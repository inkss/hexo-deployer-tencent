const path = require('path');
const fs = require('fs');
const deployer = require('./deployer');

// 读取 .env 文件
function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    const key = t.slice(0, idx).trim();
    const val = t.slice(idx + 1).trim();
    if (val && !process.env[key]) process.env[key] = val;
  }
}

loadEnv(path.resolve(__dirname, '..', '.env'));

// ==========================================
// 在这里配置你的部署参数（密钥从 .env 读取）
// ==========================================
const hexo = {
  config: {
    deploy: {
      type: 'tencent-cos',
      secret_id: process.env.SECRET_ID,
      secret_key: process.env.SECRET_KEY,
      bucket: process.env.BUCKET,
      region: process.env.REGION || 'ap-shanghai',
      upload_dir: 'public',
      cache_type: 'edgeone',
      cdn_domains: [
        process.env.DOMAIN_1 && {
          domain: process.env.DOMAIN_1,
          ignore_paths: ['/img', '/css', '/js', '/fonts']
        },
        process.env.DOMAIN_2 && {
          domain: process.env.DOMAIN_2,
          ignore_extensions: ['.html']
        }
      ].filter(Boolean),
      remove_remote_files: true,
      refresh_index_page: true,
      concurrency: 10,
      enable_log: true
    }
  },
  base_dir: path.resolve(__dirname, '..')
};

// 校验
const { secret_id, secret_key, bucket } = hexo.config.deploy;
if (!secret_id || !secret_key || !bucket) {
  console.error('[debug] 缺少 SECRET_ID / SECRET_KEY / BUCKET');
  console.error('[debug] 请复制 .env.example 为 .env 并填入真实值');
  process.exit(1);
}

const publicDir = path.join(hexo.base_dir, 'public');

// ==========================================
// 测试文件定义
// ==========================================

function getTestFiles(timestamp) {
  return {
    // 根目录 index.html
    'index.html': `<!DOCTYPE html>
<html><head><title>Home - ${timestamp}</title></head>
<body><h1>Hello from debug</h1><p>Generated at ${timestamp}</p></body></html>`,

    // 子目录 index.html
    'about/index.html': `<!DOCTYPE html>
<html><head><title>About</title></head>
<body><h1>About</h1><p>Version ${timestamp}</p></body></html>`,

    'blog/index.html': `<!DOCTYPE html>
<html><head><title>Blog</title></head>
<body><h1>Blog Index</h1><p>Updated ${timestamp}</p></body></html>`,

    // 深层嵌套 index.html
    'blog/2024/01/index.html': `<!DOCTYPE html>
<html><head><title>Jan 2024</title></head>
<body><h1>January 2024</h1></body></html>`,

    // 非 index 的 html 文件
    'post.html': `<!DOCTYPE html>
<html><head><title>Post</title></head>
<body><h1>My Post</h1><p>${timestamp}</p></body></html>`,

    '404.html': `<!DOCTYPE html>
<html><head><title>404</title></head>
<body><h1>Not Found</h1></body></html>`,

    // 静态资源
    'css/style.css': `body { margin: 0; font-size: 16px; } /* ${timestamp} */`,
    'js/app.js': `console.log('app loaded at ${timestamp}');`,
    'img/logo.svg': `<svg xmlns="http://www.w3.org/2000/svg"><text y="20">${timestamp}</text></svg>`,

    // 会被重命名的文件（初始版本）
    'temp-report.html': `<!DOCTYPE html>
<html><head><title>Report</title></head>
<body><h1>Report ${timestamp}</h1></body></html>`
  };
}

// ==========================================
// 文件操作工具
// ==========================================

function writeFiles(files) {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(publicDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}

function removeFile(relPath) {
  const fullPath = path.join(publicDir, relPath);
  if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
}

function cleanDir() {
  if (fs.existsSync(publicDir)) {
    fs.rmSync(publicDir, { recursive: true, force: true });
  }
  fs.mkdirSync(publicDir, { recursive: true });
}

function listLocalFiles() {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(publicDir, full));
    }
  }
  if (fs.existsSync(publicDir)) walk(publicDir);
  return files.sort();
}

function separator(title) {
  console.log('\n' + '='.repeat(60));
  console.log(`  ${title}`);
  console.log('='.repeat(60) + '\n');
}

// ==========================================
// 测试流程
// ==========================================

async function run() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ts2 = new Date(Date.now() + 1000).toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // ----------------------------------------
  // 阶段 1：首次部署 — 全量上传
  // ----------------------------------------
  separator(`阶段 1: 首次部署（全量上传）`);

  cleanDir();
  const initialFiles = getTestFiles(ts);
  writeFiles(initialFiles);

  console.log('[阶段 1] 本地文件:');
  listLocalFiles().forEach(f => console.log(`  ${f}`));

  try {
    await deployer.call(hexo);
  } catch (error) {
    console.error('[阶段 1] 部署异常:', error);
  }

  // ----------------------------------------
  // 阶段 2：无变更部署 — 文件内容不变
  // ----------------------------------------
  separator(`阶段 2: 无变更部署（文件内容不变，应全部跳过）`);

  console.log('[阶段 2] 本地文件（与阶段 1 完全相同）:');
  listLocalFiles().forEach(f => console.log(`  ${f}`));

  try {
    await deployer.call(hexo);
  } catch (error) {
    console.error('[阶段 2] 部署异常:', error);
  }

  // ----------------------------------------
  // 阶段 3：部分文件内容变更
  // ----------------------------------------
  separator(`阶段 3: 部分文件内容变更`);

  // 只修改 index.html 和 css/style.css，其他不变
  const changed = {
    'index.html': initialFiles['index.html'].replace('Hello from debug', 'Hello from debug [UPDATED]'),
    'css/style.css': `body { margin: 0; font-size: 18px; color: #333; } /* ${ts2} */`
  };
  writeFiles(changed);

  console.log('[阶段 3] 变更的文件:');
  Object.keys(changed).forEach(f => console.log(`  ${f} (内容已修改)`));

  console.log('[阶段 3] 本地文件（含变更）:');
  listLocalFiles().forEach(f => console.log(`  ${f}`));

  try {
    await deployer.call(hexo);
  } catch (error) {
    console.error('[阶段 3] 部署异常:', error);
  }

  // ----------------------------------------
  // 阶段 4：文件重命名 — 测试远端删除
  // ----------------------------------------
  separator(`阶段 4: 文件重命名（删除旧文件 + 新文件，测试远端同步删除）`);

  // 删除 temp-report.html，创建 temp-report-v2.html
  removeFile('temp-report.html');
  const renamed = {
    'temp-report-v2.html': `<!DOCTYPE html>
<html><head><title>Report V2</title></head>
<body><h1>Report V2</h1><p>Renamed at ${ts2}</p></body></html>`
  };
  writeFiles(renamed);

  console.log('[阶段 4] 删除: temp-report.html');
  console.log('[阶段 4] 新增: temp-report-v2.html');
  console.log('[阶段 4] 本地文件:');
  listLocalFiles().forEach(f => console.log(`  ${f}`));

  try {
    await deployer.call(hexo);
  } catch (error) {
    console.error('[阶段 4] 部署异常:', error);
  }

  // ----------------------------------------
  // 阶段 5：删除子目录 — 测试批量远端删除
  // ----------------------------------------
  separator(`阶段 5: 删除整个子目录 blog/（测试批量远端删除）`);

  const blogDir = path.join(publicDir, 'blog');
  if (fs.existsSync(blogDir)) {
    fs.rmSync(blogDir, { recursive: true, force: true });
  }

  console.log('[阶段 5] 删除: blog/ 目录（含 blog/index.html、blog/2024/01/index.html）');
  console.log('[阶段 5] 本地文件:');
  listLocalFiles().forEach(f => console.log(`  ${f}`));

  try {
    await deployer.call(hexo);
  } catch (error) {
    console.error('[阶段 5] 部署异常:', error);
  }

  // ----------------------------------------
  // 结束
  // ----------------------------------------
  separator('全部测试阶段完成');
  console.log('最终本地文件:');
  listLocalFiles().forEach(f => console.log(`  ${f}`));
}

run();
