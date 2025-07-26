const fs = require('fs').promises;
const path = require('path');
const deployer = require('./deployer'); // 假设 deployer.js 在同一目录


// 模拟 Hexo 配置（需替换为您的真实腾讯云配置）
const config = {
  secret_id: '', // 替换为真实的 secret_id
  secret_key: '', // 替换为真实的 secret_key
  bucket: '', // 替换为真实的 COS bucket
  region: '', // 替换为真实的 COS region，如 ap-guangzhou
  upload_dir: 'public',
  cache_type: 'edgeone',
  cdn_domains: [
    {
      domain: ''
    }
  ],
  remove_remote_files: true,
  refresh_index_page: true,
  concurrency: 10
};

// 模拟 Hexo 对象
const hexo = {
  config: { deploy: config },
  base_dir: process.cwd()
};

/**
 * 主调试函数
 */
async function debug() {

  try {
    await deployer.call(hexo);
  } catch (error) {
    console.error(`[调试] 失败:`, error);
  }
}

// 执行调试
debug().catch(console.error);
