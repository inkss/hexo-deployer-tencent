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

// 创建测试文件
const publicDir = path.join(hexo.base_dir, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<h1>Hello from debug</h1>');
  fs.mkdirSync(path.join(publicDir, 'css'), { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'css/style.css'), 'body { margin: 0; }');
  console.log('[debug] 已创建 public/ 测试文件');
}

async function run() {
  console.log('[debug] 目录:', publicDir);
  try {
    await deployer.call(hexo);
  } catch (error) {
    console.error('[debug] 部署异常:', error);
  }
}

run();
