const COS = require('cos-nodejs-sdk-v5');
const TencentCloudCommon = require('tencentcloud-sdk-nodejs-common');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { promisify } = require('util');
const pLimit = require('p-limit');
const retry = require('retry');

const readFileAsync = promisify(fs.readFile);
const readdirAsync = promisify(fs.readdir);
const statAsync = promisify(fs.stat);

const CommonClient = TencentCloudCommon.CommonClient;

/**
 * 校验 Hexo 的 deploy 配置并返回配置对象
 * @param {Object} hexo - Hexo 实例
 * @returns {Object|null} 配置对象，如果校验失败则返回 null
 */
const validateConfig = (hexo) => {
  const config = hexo.config.deploy;
  if (!config) {
    console.error('未找到 deploy 配置项，请在 _config.yml 中添加');
    return null;
  }

  const required = ['secret_id', 'secret_key', 'bucket', 'region', 'upload_dir'];
  const errors = [];

  // 检查必填项
  const missing = required.filter(v => !config[v]);
  if (missing.length) {
    errors.push(`缺少必要的 deploy 配置项: ${missing.join(', ')}`);
  }

  // 检查配置项是否为默认值
  required.forEach(item => {
    if (config[item] === `your_${item}`) {
      errors.push(`未正确配置: ${item}`);
    }
  });

  // 校验 cdn_domains
  const cdnDomains = config.cdn_domains || [];
  cdnDomains.forEach((item, index) => {
    if (!item.domain) {
      errors.push(`cdn_domains[${index}] 缺少 domain 字段`);
    } else if (!item.domain.startsWith('http://') && !item.domain.startsWith('https://')) {
      errors.push(`cdn_domains[${index}] 的 domain 必须以 http:// 或 https:// 开头`);
    }
    if (item.ignore_paths && !Array.isArray(item.ignore_paths)) {
      errors.push(`cdn_domains[${index}] 的 ignore_paths 必须是数组`);
    }
    if (item.ignore_extensions) {
      if (!Array.isArray(item.ignore_extensions)) {
        errors.push(`cdn_domains[${index}] 的 ignore_extensions 必须是数组`);
      } else {
        item.ignore_extensions.forEach(ext => {
          if (typeof ext !== 'string') {
            errors.push(`cdn_domains[${index}] 的 ignore_extensions 中 "${ext}" 必须是字符串`);
          } else if (!ext.startsWith('.')) {
            errors.push(`cdn_domains[${index}] 的 ignore_extensions 中 "${ext}" 必须以 "." 开头`);
          }
        });
      }
    }
  });

  // 如果有错误，一次性输出并返回 null
  if (errors.length > 0) {
    console.error('配置错误：');
    errors.forEach(error => console.error(`- ${error}`));
    return null;
  }

  // 返回配置对象
  return {
    secretId: config.secret_id,
    secretKey: config.secret_key,
    bucket: config.bucket,
    region: config.region,
    uploadDir: path.join(hexo.base_dir, config.upload_dir),
    cdnDomains: cdnDomains.map(item => ({
      domain: item.domain,
      ignorePaths: (item.ignore_paths || []).map(path => {
        let normalized = path.startsWith('/') ? path.slice(1) : path;
        normalized = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
        return normalized;
      }),
      ignoreExtensions: (item.ignore_extensions || []).map(ext => ext.toLowerCase())
    })),
    removeRemoteFiles: config.remove_remote_files || false,
    refreshIndexPage: config.refresh_index_page || false,
    concurrency: config.concurrency || 10
  };
};

/**
 * 初始化 COS 和 CDN 客户端
 * @param {Object} config - 配置对象
 * @returns {Object} 包含 COS 和 CDN 客户端的对象
 */
const initClients = (config) => {
  const cos = new COS({ SecretId: config.secretId, SecretKey: config.secretKey });
  const cdn = new CommonClient(
    'cdn.tencentcloudapi.com',
    '2018-06-06',
    { credential: { secretId: config.secretId, secretKey: config.secretKey }, region: '' }
  );
  return { cos, cdn };
};

/**
 * 计算文件的 MD5 值
 * @param {string} filePath - 文件路径
 * @returns {Promise<string>} 文件的 MD5 值
 */
const calculateMD5 = async (filePath) => {
  const fileBuffer = await readFileAsync(filePath);
  return crypto.createHash('md5').update(fileBuffer).digest('hex');
};

/**
 * 递归获取指定目录下的所有文件
 * @param {string} dir - 目录路径
 * @returns {Promise<string[]>} 文件路径数组
 */
const getFiles = async (dir) => {
  const subdirs = await readdirAsync(dir);
  const files = await Promise.all(subdirs.map(async (subdir) => {
    const res = path.resolve(dir, subdir);
    return (await statAsync(res)).isDirectory() ? getFiles(res) : res;
  }));
  return files.flat();
};

/**
 * 获取 COS 存储桶中的所有文件
 * @param {COS} cos - COS 客户端
 * @param {Object} config - 配置对象
 * @returns {Promise<string[]>} 文件 Key 数组
 */
const listCosFiles = async (cos, config) => {
  let contents = [];
  let continuationToken;
  do {
    const data = await new Promise((resolve, reject) => {
      cos.getBucket({ Bucket: config.bucket, Region: config.region, ContinuationToken: continuationToken }, (err, data) => {
        err ? reject(err) : resolve(data);
      });
    });
    contents = contents.concat(data.Contents);
    continuationToken = data.NextContinuationToken;
  } while (continuationToken);
  return contents.map(item => item.Key);
};

/**
 * 上传单个文件到 COS，支持重试机制
 * @param {COS} cos - COS 客户端
 * @param {Object} config - 配置对象
 * @param {string} key - 文件在 COS 中的 Key
 * @param {string} filePath - 本地文件路径
 * @returns {Promise<void>}
 */
const uploadFile = async (cos, config, key, filePath) => {
  const operation = retry.operation({ retries: 3, factor: 2, minTimeout: 1000 });
  return new Promise((resolve, reject) => {
    operation.attempt(async () => {
      try {
        await cos.putObject({
          Bucket: config.bucket,
          Region: config.region,
          Key: key,
          Body: fs.createReadStream(filePath)
        });
        console.info(`上传成功: ${key}`);
        resolve();
      } catch (error) {
        if (operation.retry(error)) return;
        reject(error);
      }
    });
  });
};

/**
 * 删除 COS 中的多个文件
 * @param {COS} cos - COS 客户端
 * @param {Object} config - 配置对象
 * @param {string[]} keys - 要删除的文件 Key 数组
 * @returns {Promise<void>}
 */
const deleteCosFiles = async (cos, config, keys) => {
  if (!keys.length) return;
  const objects = keys.map(key => ({ Key: key }));
  await cos.deleteMultipleObject({ Bucket: config.bucket, Region: config.region, Objects: objects });
  console.info(`删除 ${keys.length} 个远程文件`);
};

/**
 * 刷新 CDN URL 缓存
 * @param {CommonClient} cdn - CDN 客户端
 * @param {string[]} urls - 要刷新的 URL 数组
 * @returns {Promise<void>}
 */
const purgeUrlsCache = async (cdn, urls) => {
  const batchSize = 1000;
  let index = 0;
  while (index < urls.length) {
    const batchUrls = urls.slice(index, index + batchSize);
    await cdn.request('PurgeUrlsCache', { Urls: batchUrls });
    console.info(`刷新 ${batchUrls.length} 个 URL`);
    index += batchSize;
  }
};

/**
 * 主逻辑函数，协调文件上传、同步和 CDN 刷新
 * @param {Object} config - 配置对象
 * @param {Object} clients - 包含 COS 和 CDN 客户端的对象
 * @returns {Promise<void>}
 */
const main = async (config, clients) => {
  const { cos, cdn } = clients;
  const limit = pLimit(config.concurrency);
  const localFiles = await getFiles(config.uploadDir); // 获取本地文件列表
  const changedFiles = []; // 记录发生变更的文件
  const localFileKeys = new Set(localFiles.map(filePath => path.relative(config.uploadDir, filePath).replace(/\\/g, '/')));

  // 如果配置允许，则获取远程文件列表
  let remoteFiles = config.removeRemoteFiles ? await listCosFiles(cos, config) : [];

  // 并行上传文件
  const uploadPromises = localFiles.map(filePath => limit(async () => {
    const key = path.relative(config.uploadDir, filePath).replace(/\\/g, '/');
    const localMD5 = await calculateMD5(filePath);
    if (!localMD5) return;

    try {
      const data = await cos.headObject({ Bucket: config.bucket, Region: config.region, Key: key });
      if (data.ETag?.replace(/"/g, '') === localMD5) return; // 文件未变更，跳过上传
    } catch (error) {
      if (error.statusCode !== 404) throw error; // 文件不存在，继续上传
    }

    await uploadFile(cos, config, key, filePath);
    changedFiles.push(key);
  }));

  await Promise.all(uploadPromises);

  // 删除远程多余文件
  if (config.removeRemoteFiles) {
    const filesToDelete = remoteFiles.filter(key => !localFileKeys.has(key));
    await deleteCosFiles(cos, config, filesToDelete);
  }

  // 刷新 CDN 缓存
  if (config.cdnDomains.length && changedFiles.length) {
    const urls = [];
    config.cdnDomains.forEach(({ domain, ignorePaths, ignoreExtensions }) => {
      changedFiles.forEach(file => {
        const shouldIgnorePath = ignorePaths.some(pathPrefix => {
          if (pathPrefix === '') return false;
          return file.startsWith(pathPrefix + '/') || file === pathPrefix;
        });
        if (shouldIgnorePath) return;

        const fileExtension = path.extname(file).toLowerCase();
        if (ignoreExtensions.includes(fileExtension)) return;

        let url = `${domain}/${file}`;
        if (config.refreshIndexPage && url.endsWith('/index.html')) {
          url = url.replace(/\/index\.html$/, '/'); // 将 index.html 替换为目录形式
        }
        urls.push(url);
      });
    });
    await purgeUrlsCache(cdn, urls);
  }

  console.info('文件同步和 CDN 刷新完成');
};

/**
 * Hexo 部署入口函数
 * @param {Object} hexo - Hexo 实例
 */
module.exports = function() {
  const hexo = this; // this 指向 Hexo 实例
  const config = validateConfig(hexo);
  if (!config) return;

  const clients = initClients(config);
  main(config, clients).catch(error => {
    console.error(`Deploy failed: ${error.message}`);
  });
};
