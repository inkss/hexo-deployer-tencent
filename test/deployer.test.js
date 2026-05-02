const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const deployer = require('../lib/deployer');
const { _validateConfig, _calculateMD5, _getFiles, _withRetry, _buildPurgeUrls } = deployer;

// ============================================================
// 测试工具：创建临时目录和文件
// ============================================================

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hexo-deployer-test-'));
}

function createFile(dir, relPath, content) {
  const fullPath = path.join(dir, relPath);
  const parentDir = path.dirname(fullPath);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(fullPath, content);
  return fullPath;
}

function makeHexo(config) {
  return {
    config: { deploy: config },
    base_dir: '/tmp/test-hexo'
  };
}

const VALID_CONFIG = {
  secret_id: 'AKIDxxxxxx',
  secret_key: 'xxxxxx',
  bucket: 'test-123',
  region: 'ap-guangzhou',
  upload_dir: 'public',
  cache_type: 'cdn',
  cdn_domains: [{ domain: 'https://example.com' }],
  concurrency: 5,
  enable_log: false
};

// ============================================================
// D1: 配置校验测试
// ============================================================

describe('validateConfig', () => {

  it('缺少必填项时返回 null', () => {
    const hexo = makeHexo({ secret_id: 'xxx' });
    assert.equal(_validateConfig(hexo), null);
  });

  it('placeholder 值视为未配置', () => {
    const hexo = makeHexo({ ...VALID_CONFIG, secret_id: 'your_secret_id' });
    assert.equal(_validateConfig(hexo), null);
  });

  it('无效 cache_type 返回 null', () => {
    const hexo = makeHexo({ ...VALID_CONFIG, cache_type: 'invalid' });
    assert.equal(_validateConfig(hexo), null);
  });

  it('cache_type 默认为 cdn', () => {
    const cfg = { ...VALID_CONFIG };
    delete cfg.cache_type;
    const result = _validateConfig(makeHexo(cfg));
    assert.notEqual(result, null);
    assert.equal(result.cache_type, 'cdn');
  });

  it('cdn_domains domain 格式不合法返回 null', () => {
    const hexo = makeHexo({ ...VALID_CONFIG, cdn_domains: [{ domain: 'not-a-url' }] });
    assert.equal(_validateConfig(hexo), null);
  });

  it('ignore_extensions 必须以 . 开头', () => {
    const hexo = makeHexo({ ...VALID_CONFIG, cdn_domains: [{ domain: 'https://example.com', ignore_extensions: ['jpg'] }] });
    assert.equal(_validateConfig(hexo), null);
  });

  it('ignore_extensions 非字符串返回 null', () => {
    const hexo = makeHexo({ ...VALID_CONFIG, cdn_domains: [{ domain: 'https://example.com', ignore_extensions: [123] }] });
    assert.equal(_validateConfig(hexo), null);
  });

  it('ignore_paths 非数组返回 null', () => {
    const hexo = makeHexo({ ...VALID_CONFIG, cdn_domains: [{ domain: 'https://example.com', ignore_paths: 'not-array' }] });
    assert.equal(_validateConfig(hexo), null);
  });

  it('正确配置返回标准化对象', () => {
    const result = _validateConfig(makeHexo(VALID_CONFIG));
    assert.notEqual(result, null);
    assert.equal(result.secretId, 'AKIDxxxxxx');
    assert.equal(result.bucket, 'test-123');
    assert.equal(result.region, 'ap-guangzhou');
    assert.equal(result.cache_type, 'cdn');
    assert.equal(result.concurrency, 5);
    assert.equal(result.cdnDomains.length, 1);
    assert.equal(result.cdnDomains[0].domain, 'https://example.com');
  });

  it('ignore_paths 标准化：去除首尾斜杠', () => {
    const cfg = {
      ...VALID_CONFIG,
      cdn_domains: [{ domain: 'https://example.com', ignore_paths: ['/static/', 'assets'] }]
    };
    const result = _validateConfig(makeHexo(cfg));
    assert.deepEqual(result.cdnDomains[0].ignorePaths, ['static', 'assets']);
  });

  it('ignore_extensions 转为小写', () => {
    const cfg = {
      ...VALID_CONFIG,
      cdn_domains: [{ domain: 'https://example.com', ignore_extensions: ['.PNG', '.mp4'] }]
    };
    const result = _validateConfig(makeHexo(cfg));
    assert.deepEqual(result.cdnDomains[0].ignoreExtensions, ['.png', '.mp4']);
  });
});

// ============================================================
// D7: 并发数边界测试
// ============================================================

describe('validateConfig - concurrency bounds', () => {

  it('concurrency 为 0 时修正为 1', () => {
    const result = _validateConfig(makeHexo({ ...VALID_CONFIG, concurrency: 0 }));
    assert.equal(result.concurrency, 1);
  });

  it('concurrency 为负数时修正为 1', () => {
    const result = _validateConfig(makeHexo({ ...VALID_CONFIG, concurrency: -5 }));
    assert.equal(result.concurrency, 1);
  });

  it('concurrency 过大时修正为 50', () => {
    const result = _validateConfig(makeHexo({ ...VALID_CONFIG, concurrency: 999 }));
    assert.equal(result.concurrency, 50);
  });

  it('concurrency 未设置时默认 10', () => {
    const cfg = { ...VALID_CONFIG };
    delete cfg.concurrency;
    const result = _validateConfig(makeHexo(cfg));
    assert.equal(result.concurrency, 10);
  });

  it('concurrency 在范围内保持原值', () => {
    const result = _validateConfig(makeHexo({ ...VALID_CONFIG, concurrency: 20 }));
    assert.equal(result.concurrency, 20);
  });
});

// ============================================================
// D2: calculateMD5 测试
// ============================================================

describe('calculateMD5', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('计算已知内容的 MD5', async () => {
    const content = 'hello world';
    const filePath = createFile(tmpDir, 'test.txt', content);
    const expected = crypto.createHash('md5').update(content).digest('hex');

    const result = await _calculateMD5(filePath);
    assert.equal(result, expected);
  });

  it('空文件的 MD5', async () => {
    const filePath = createFile(tmpDir, 'empty.txt', '');
    const expected = crypto.createHash('md5').update('').digest('hex');

    const result = await _calculateMD5(filePath);
    assert.equal(result, expected);
  });

  it('大文件（>64KB）不报错', async () => {
    const content = Buffer.alloc(128 * 1024, 'a'); // 128KB
    const filePath = createFile(tmpDir, 'large.bin', content);

    const result = await _calculateMD5(filePath);
    assert.equal(typeof result, 'string');
    assert.equal(result.length, 32);
  });

  it('文件不存在时抛出错误', async () => {
    await assert.rejects(
      () => _calculateMD5(path.join(tmpDir, 'nonexistent.txt')),
      { code: 'ENOENT' }
    );
  });
});

// ============================================================
// D3: getFiles 测试
// ============================================================

describe('getFiles', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('获取单个目录下的文件', async () => {
    createFile(tmpDir, 'a.txt', 'a');
    createFile(tmpDir, 'b.txt', 'b');

    const files = await _getFiles(tmpDir);
    assert.equal(files.length, 2);
    assert.ok(files.some(f => f.endsWith('a.txt')));
    assert.ok(files.some(f => f.endsWith('b.txt')));
  });

  it('递归获取嵌套目录下的文件', async () => {
    createFile(tmpDir, 'root.txt', 'root');
    createFile(tmpDir, 'sub/nested.txt', 'nested');
    createFile(tmpDir, 'sub/deep/file.txt', 'deep');

    const files = await _getFiles(tmpDir);
    assert.equal(files.length, 3);
  });

  it('空目录返回空数组', async () => {
    const files = await _getFiles(tmpDir);
    assert.deepEqual(files, []);
  });
});

// ============================================================
// D4: withRetry 测试
// ============================================================

describe('withRetry', () => {

  it('函数首次成功直接返回', async () => {
    const result = await _withRetry(async () => 42);
    assert.equal(result, 42);
  });

  it('函数失败 2 次后成功', async () => {
    let attempts = 0;
    const result = await _withRetry(async () => {
      attempts++;
      if (attempts < 3) throw new Error('fail');
      return 'success';
    }, { retries: 3, factor: 1, minTimeout: 10 });
    assert.equal(result, 'success');
    assert.equal(attempts, 3);
  });

  it('函数始终失败最终抛出错误', async () => {
    await assert.rejects(
      () => _withRetry(async () => { throw new Error('always fail'); }, { retries: 2, factor: 1, minTimeout: 10 }),
      /always fail/
    );
  });

  it('返回值可以是对象', async () => {
    const obj = { data: [1, 2, 3] };
    const result = await _withRetry(async () => obj);
    assert.deepEqual(result, obj);
  });
});

// ============================================================
// D5: buildPurgeUrls 测试
// ============================================================

describe('buildPurgeUrls', () => {

  it('普通文件生成正确 URL', () => {
    const config = {
      cdnDomains: [{ domain: 'https://example.com', ignorePaths: [], ignoreExtensions: [] }],
      refreshIndexPage: false
    };
    const urls = _buildPurgeUrls(['css/style.css', 'js/app.js'], config);
    assert.deepEqual(urls, ['https://example.com/css/style.css', 'https://example.com/js/app.js']);
  });

  it('根目录 index.html 映射为 /index.html', () => {
    const config = {
      cdnDomains: [{ domain: 'https://example.com', ignorePaths: [], ignoreExtensions: [] }],
      refreshIndexPage: false
    };
    const urls = _buildPurgeUrls(['index.html'], config);
    assert.deepEqual(urls, ['https://example.com/index.html']);
  });

  it('refresh_index_page 时 about/index.html → about/', () => {
    const config = {
      cdnDomains: [{ domain: 'https://example.com', ignorePaths: [], ignoreExtensions: [] }],
      refreshIndexPage: true
    };
    const urls = _buildPurgeUrls(['about/index.html'], config);
    assert.deepEqual(urls, ['https://example.com/about/']);
  });

  it('refresh_index_page 不影响根目录 index.html', () => {
    const config = {
      cdnDomains: [{ domain: 'https://example.com', ignorePaths: [], ignoreExtensions: [] }],
      refreshIndexPage: true
    };
    const urls = _buildPurgeUrls(['index.html'], config);
    assert.deepEqual(urls, ['https://example.com/index.html']);
  });

  it('ignore_paths 过滤匹配的文件', () => {
    const config = {
      cdnDomains: [{ domain: 'https://example.com', ignorePaths: ['static', 'vendor'], ignoreExtensions: [] }],
      refreshIndexPage: false
    };
    const urls = _buildPurgeUrls(['static/logo.png', 'vendor/lib.js', 'css/style.css'], config);
    assert.deepEqual(urls, ['https://example.com/css/style.css']);
  });

  it('ignore_extensions 过滤匹配的扩展名', () => {
    const config = {
      cdnDomains: [{ domain: 'https://example.com', ignorePaths: [], ignoreExtensions: ['.png', '.jpg'] }],
      refreshIndexPage: false
    };
    const urls = _buildPurgeUrls(['image.png', 'photo.jpg', 'style.css'], config);
    assert.deepEqual(urls, ['https://example.com/style.css']);
  });

  it('多域名为每个域名生成 URL', () => {
    const config = {
      cdnDomains: [
        { domain: 'https://example.com', ignorePaths: [], ignoreExtensions: [] },
        { domain: 'https://cdn.example.com', ignorePaths: [], ignoreExtensions: [] }
      ],
      refreshIndexPage: false
    };
    const urls = _buildPurgeUrls(['style.css'], config);
    assert.deepEqual(urls, [
      'https://example.com/style.css',
      'https://cdn.example.com/style.css'
    ]);
  });

  it('空文件列表返回空数组', () => {
    const config = {
      cdnDomains: [{ domain: 'https://example.com', ignorePaths: [], ignoreExtensions: [] }],
      refreshIndexPage: false
    };
    const urls = _buildPurgeUrls([], config);
    assert.deepEqual(urls, []);
  });
});

// ============================================================
// D6: 路径穿越检查测试
// ============================================================

describe('path traversal protection', () => {

  it('正常路径生成正常 key', () => {
    const baseDir = '/tmp/test-hexo/public';
    const filePath = '/tmp/test-hexo/public/css/style.css';
    const key = path.relative(baseDir, filePath).replace(/\\/g, '/');
    assert.equal(key, 'css/style.css');
    assert.ok(!key.startsWith('..'));
  });

  it('越界路径以 .. 开头', () => {
    const baseDir = '/tmp/test-hexo/public';
    const filePath = '/tmp/test-hexo/secret.txt';
    const key = path.relative(baseDir, filePath).replace(/\\/g, '/');
    assert.ok(key.startsWith('..'));
  });

  it('完全不同的路径产生越界 key', () => {
    const baseDir = '/tmp/test-hexo/public';
    const filePath = '/etc/passwd';
    const key = path.relative(baseDir, filePath).replace(/\\/g, '/');
    assert.ok(key.startsWith('..') || path.isAbsolute(key));
  });
});
