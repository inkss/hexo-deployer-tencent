const COS = require('cos-nodejs-sdk-v5');
const { CommonClient } = require('tencentcloud-sdk-nodejs-common');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const crypto = require('crypto');
const pLimit = require('p-limit');

const RETRY_OPTIONS = { retries: 3, factor: 2, minTimeout: 1000 };
const CDN_PURGE_BATCH_SIZE = 1000;
const COS_DELETE_BATCH_SIZE = 1000;
const EDGEONE_PURGE_BATCH_SIZE = 500;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 50;

/**
 * 日志辅助函数
 * @param {Object} config - 配置对象
 * @param {string} prefix - 日志前缀
 * @param {string} message - 日志消息
 */
const log = (config, prefix, message) => {
  if (config.enableLog) {
    console.info(`[${prefix}] [${new Date().toISOString()}] ${message}`);
  }
};

/**
 * 错误日志
 * @param {string} prefix - 日志前缀
 * @param {string} message - 日志消息
 * @param  {...any} args - 附加参数
 */
const errorLog = (prefix, message, ...args) => {
  console.error(`[${prefix}] [${new Date().toISOString()}] ${message}`, ...args);
};

/**
 * 异步重试工具函数
 * @param {Function} fn - 返回 Promise 的函数
 * @param {Object} opts - retry 库选项
 * @returns {Promise<any>}
 */
const withRetry = async (fn, opts = RETRY_OPTIONS) => {
  const { retries = 3, factor = 2, minTimeout = 1000 } = opts;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        const delay = minTimeout * Math.pow(factor, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
};

/**
 * 校验 Hexo 部署配置
 * @param {Object} hexo - Hexo 实例
 * @returns {Object|null} 配置对象，校验失败返回 null
 */
const validateConfig = (hexo) => {
  const config = hexo.config.deploy;
  if (!config) {
    errorLog('配置', '未找到 deploy 配置，请在 _config.yml 中配置');
    return null;
  }

  const domainRegex = /^https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  const required = ['secret_id', 'secret_key', 'bucket', 'region', 'upload_dir'];
  const errors = [];

  required.forEach(item => {
    if (!config[item]) errors.push(`缺少配置项: ${item}`);
    else if (config[item] === `your_${item}`) errors.push(`未正确配置: ${item}`);
  });

  const cache_type = config.cache_type || 'cdn';
  if (!['edgeone', 'cdn'].includes(cache_type)) {
    errors.push(`不支持的缓存类型 "${cache_type}"，请使用 "edgeone" 或 "cdn"`);
  }

  const cdnDomains = config.cdn_domains || [];
  cdnDomains.forEach((item, index) => {
    if (!item.domain) {
      errors.push(`cdn_domains[${index}] 缺少 domain 字段`);
    } else if (!domainRegex.test(item.domain)) {
      errors.push(`cdn_domains[${index}] 的 domain 格式不合法: ${item.domain}`);
    }
    if (item.ignore_paths && !Array.isArray(item.ignore_paths)) {
      errors.push(`cdn_domains[${index}] 的 ignore_paths 必须为数组`);
    }
    if (item.ignore_extensions) {
      if (!Array.isArray(item.ignore_extensions)) {
        errors.push(`cdn_domains[${index}] 的 ignore_extensions 必须为数组`);
      } else {
        item.ignore_extensions.forEach(ext => {
          if (typeof ext !== 'string') {
            errors.push(`cdn_domains[${index}] 的 ignore_extensions 中 "${ext}" 必须为字符串`);
          } else if (!ext.startsWith('.')) {
            errors.push(`cdn_domains[${index}] 的 ignore_extensions 中 "${ext}" 必须以 "." 开头`);
          }
        });
      }
    }
  });

  if (errors.length) {
    errorLog('配置', '校验失败:');
    errors.forEach(error => console.error(`  - ${error}`));
    return null;
  }

  return {
    secretId: config.secret_id,
    secretKey: config.secret_key,
    bucket: config.bucket,
    region: config.region,
    uploadDir: path.join(hexo.base_dir, config.upload_dir),
    cache_type: cache_type,
    cdnDomains: cdnDomains.map(item => ({
      domain: item.domain,
      ignorePaths: (item.ignore_paths || []).filter(p => p).map(segment => {
        let normalized = segment.startsWith('/') ? segment.slice(1) : segment;
        return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
      }),
      ignoreExtensions: (item.ignore_extensions || []).map(ext => ext.toLowerCase())
    })),
    removeRemoteFiles: config.remove_remote_files || false,
    refreshIndexPage: config.refresh_index_page || false,
    concurrency: Math.max(MIN_CONCURRENCY, Math.min(config.concurrency ?? 10, MAX_CONCURRENCY)),
    enableLog: config.enable_log || false
  };
};

/**
 * 初始化 COS、CDN 和 EdgeOne 客户端
 * @param {Object} config - 配置对象
 * @returns {Object} 客户端对象
 */
const initClients = (config) => {
  const clientConfig = { credential: { secretId: config.secretId, secretKey: config.secretKey }, region: '' };
  return {
    cos: new COS({ SecretId: config.secretId, SecretKey: config.secretKey }),
    cdn: new CommonClient('cdn.tencentcloudapi.com', '2018-06-06', clientConfig),
    edgeone: new CommonClient('teo.tencentcloudapi.com', '2022-09-01', clientConfig)
  };
};

/**
 * 流式计算文件 MD5 值
 * @param {string} filePath - 本地文件路径
 * @returns {Promise<string>} MD5 值
 */
const calculateMD5 = (filePath) => {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
};

/**
 * 递归获取目录下所有文件
 * @param {string} dir - 目录路径
 * @returns {Promise<string[]>} 文件路径数组
 */
const getFiles = async (dir) => {
  const subdirs = await fsPromises.readdir(dir);
  const files = await Promise.all(subdirs.map(async (subdir) => {
    const res = path.resolve(dir, subdir);
    return (await fsPromises.stat(res)).isDirectory() ? getFiles(res) : res;
  }));
  return files.flat();
};

/**
 * 获取 COS 存储桶中的文件列表
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
 * 上传文件到 COS，支持重试
 * @param {COS} cos - COS 客户端
 * @param {Object} config - 配置对象
 * @param {string} key - 文件 Key
 * @param {string} filePath - 本地文件路径
 * @returns {Promise<void>}
 */
const uploadFile = async (cos, config, key, filePath) => {
  await withRetry(async () => {
    await cos.putObject({
      Bucket: config.bucket,
      Region: config.region,
      Key: key,
      Body: fs.createReadStream(filePath)
    });
    log(config, '上传', `成功: ${key}`);
  });
};

/**
 * 删除 COS 中的文件（分批 + 重试）
 * @param {COS} cos - COS 客户端
 * @param {Object} config - 配置对象
 * @param {string[]} keys - 要删除的文件 Key 数组
 * @returns {Promise<void>}
 */
const deleteCosFiles = async (cos, config, keys) => {
  if (!keys.length) return;
  for (let i = 0; i < keys.length; i += COS_DELETE_BATCH_SIZE) {
    const batch = keys.slice(i, i + COS_DELETE_BATCH_SIZE);
    await withRetry(async () => {
      await cos.deleteMultipleObject({
        Bucket: config.bucket,
        Region: config.region,
        Objects: batch.map(key => ({ Key: key }))
      });
      log(config, '删除', `完成 ${batch.length} 个远程文件`);
    });
  }
};

/**
 * 刷新 CDN 缓存（分批 + 重试）
 * @param {CommonClient} cdn - CDN 客户端
 * @param {Object} config - 配置对象
 * @param {string[]} urls - URL 数组
 * @returns {Promise<void>}
 */
const purgeCdnCache = async (cdn, config, urls) => {
  for (let i = 0; i < urls.length; i += CDN_PURGE_BATCH_SIZE) {
    const batchUrls = urls.slice(i, i + CDN_PURGE_BATCH_SIZE);
    await withRetry(async () => {
      await cdn.request('PurgeUrlsCache', { Urls: batchUrls });
      log(config, 'CDN刷新', `提交 ${batchUrls.length} 个 URL`);
    });
  }
};

/**
 * 刷新 EdgeOne 缓存（支持多域名独立处理）
 * @param {CommonClient} edgeone - EdgeOne 客户端
 * @param {Object} config - 配置对象
 * @param {string[]} urls - URL 数组
 * @returns {Promise<number>} 成功刷新的 URL 数量
 */
const purgeEdgeOneCache = async (edgeone, config, urls) => {
  const invalidUrls = urls.filter(u => {
    try { new URL(u); return false; } catch { return true; }
  });
  if (invalidUrls.length) {
    errorLog('EdgeOne', `无效的 URL: ${invalidUrls.join(', ')}`);
    return 0;
  }

  // 提取唯一主域名
  const mainDomains = new Set(urls.map(u => {
    const hostname = new URL(u).hostname;
    return hostname.split('.').slice(-2).join('.');
  }));

  // 只调用一次 DescribeZones，缓存结果供所有域名使用
  let allZones;
  try {
    const response = await edgeone.request("DescribeZones", {});
    allZones = response?.Zones || [];
  } catch (error) {
    errorLog('EdgeOne', '获取 Zone 列表失败:', error);
    return 0;
  }

  let refreshedCount = 0;

  for (const mainDomain of mainDomains) {
    // 查找 ZoneId：优先精确匹配，其次后缀匹配
    const zone = allZones.find(z => z.ZoneName === mainDomain)
      || allZones.find(z => z.ZoneName.endsWith(`.${mainDomain}`));
    const zoneId = zone?.ZoneId;

    if (!zoneId) {
      errorLog('EdgeOne', `未找到 ${mainDomain} 对应的 ZoneId，跳过该域名`);
      continue;
    }

    // 获取配额
    let quota;
    try {
      const response = await edgeone.request("DescribeContentQuota", { ZoneId: zoneId });
      const purgeUrlQuota = (response?.PurgeQuota || []).find(q => q.Type === 'purge_url');
      quota = {
        batchLimit: purgeUrlQuota?.Batch || EDGEONE_PURGE_BATCH_SIZE,
        dailyLimit: purgeUrlQuota?.Daily || 1000,
        dailyAvailable: purgeUrlQuota?.DailyAvailable || 0
      };
    } catch (error) {
      errorLog('EdgeOne', `ZoneId ${zoneId} 获取配额失败，跳过:`, error);
      continue;
    }

    log(config, 'EdgeOne', `Zone ${zoneId} 配额: 单次 ${quota.batchLimit} / 每日 ${quota.dailyLimit} / 剩余 ${quota.dailyAvailable}`);

    const isFreePlan = quota.batchLimit === EDGEONE_PURGE_BATCH_SIZE;
    const batchSize = isFreePlan ? EDGEONE_PURGE_BATCH_SIZE : CDN_PURGE_BATCH_SIZE;
    const domainUrls = urls.filter(u => new URL(u).hostname.endsWith(mainDomain));

    // 创建清除任务
    let tasks;
    if (isFreePlan && domainUrls.length > quota.dailyAvailable) {
      // 免费版配额不足，回退到主机名级刷新
      const hostnames = new Set(domainUrls.map(u => new URL(u).hostname));
      tasks = Array.from(hostnames).map(hostname => ({
        type: 'purge_host',
        targets: [hostname],
        method: 'invalidate'
      }));
      log(config, 'EdgeOne', `Zone ${zoneId} 策略: 主机名级刷新（免费版配额不足，${domainUrls.length} URL > ${quota.dailyAvailable} 剩余）`);
    } else {
      tasks = Array.from({ length: Math.ceil(domainUrls.length / batchSize) }, (_, i) => ({
        type: 'purge_url',
        targets: domainUrls.slice(i * batchSize, (i + 1) * batchSize),
        method: 'delete'
      }));
      log(config, 'EdgeOne', `Zone ${zoneId} 策略: URL级刷新，${tasks.length} 个任务`);
    }

    // 执行清除任务
    for (const task of tasks) {
      try {
        await withRetry(async () => {
          await edgeone.request("CreatePurgeTask", {
            ZoneId: zoneId,
            Type: task.type,
            Targets: task.targets,
            Method: task.method || 'delete'
          });
          log(config, 'EdgeOne', `缓存清除成功: Type=${task.type}, 数量=${task.targets.length}`);
        });
        refreshedCount += task.targets.length;
      } catch (error) {
        errorLog('EdgeOne', `缓存清除失败（ZoneId: ${zoneId}）:`, error);
      }
    }
  }

  return refreshedCount;
};

/**
 * 构建缓存刷新 URL 列表
 * @param {string[]} changedFiles - 变更的文件 Key 数组
 * @param {Object} config - 配置对象
 * @returns {string[]} URL 数组
 */
const buildPurgeUrls = (changedFiles, config) => {
  const urls = [];
  config.cdnDomains.forEach(({ domain, ignorePaths, ignoreExtensions }) => {
    changedFiles.forEach(file => {
      if (ignorePaths.some(p => p && (file.startsWith(p + '/') || file === p))) return;
      if (ignoreExtensions.includes(path.extname(file).toLowerCase())) return;
      let urlFile = file === 'index.html' ? '/index.html' : file;
      const urlPath = config.refreshIndexPage && urlFile !== '/index.html' && urlFile.endsWith('/index.html')
        ? `${urlFile.replace(/\/index\.html$/, '/')}`
        : `${urlFile}`;
      urls.push(new URL(urlPath, domain).toString());
    });
  });
  return urls;
};

/**
 * 主逻辑：上传文件、同步远程文件、刷新缓存
 * @param {Object} config - 配置对象
 * @param {Object} clients - 客户端对象
 * @returns {Promise<void>}
 */
const main = async (config, clients) => {
  const { cos, cdn, edgeone } = clients;
  const limit = pLimit(config.concurrency);
  const localFiles = await getFiles(config.uploadDir);
  const localFileKeys = new Set(localFiles.map(filePath => path.relative(config.uploadDir, filePath).replace(/\\/g, '/')));

  // 获取远程文件
  const remoteFiles = config.removeRemoteFiles ? await listCosFiles(cos, config) : [];

  // 上传变更文件（收集结果而非 push）
  const results = await Promise.all(localFiles.map(filePath => limit(async () => {
    const key = path.relative(config.uploadDir, filePath).replace(/\\/g, '/');
    if (key.startsWith('..') || path.isAbsolute(key)) {
      errorLog('上传', `跳过越界路径: ${filePath}`);
      return null;
    }

    const localMD5 = await calculateMD5(filePath);
    if (!localMD5) return null;

    try {
      const data = await cos.headObject({ Bucket: config.bucket, Region: config.region, Key: key });
      if (data.ETag?.replace(/"/g, '') === localMD5) return null;
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }

    await uploadFile(cos, config, key, filePath);
    return key;
  })));
  const changedFiles = results.filter(Boolean);

  // 删除多余远程文件
  let deletedCount = 0;
  if (config.removeRemoteFiles) {
    const filesToDelete = remoteFiles.filter(key => !localFileKeys.has(key));
    deletedCount = filesToDelete.length;
    await deleteCosFiles(cos, config, filesToDelete);
  }

  // 刷新缓存
  let refreshedCount = 0;
  if (config.cdnDomains.length && changedFiles.length) {
    const urls = buildPurgeUrls(changedFiles, config);

    if (config.cache_type === 'cdn') {
      await purgeCdnCache(cdn, config, urls);
      refreshedCount = urls.length;
    } else if (config.cache_type === 'edgeone') {
      refreshedCount = await purgeEdgeOneCache(edgeone, config, urls);
    }
  }

  log(config, '部署', `上传: ${changedFiles.length} 个文件 | 删除: ${deletedCount} 个文件 | 刷新: ${refreshedCount} 个 URL`);
  log(config, '部署', '完成！');
};

/**
 * Hexo 部署入口
 * @param {Object} hexo - Hexo 实例
 */
module.exports = function () {
  const hexo = this;
  const config = validateConfig(hexo);
  if (!config) return;

  const clients = initClients(config);
  main(config, clients).catch(error => {
    errorLog('部署', '失败:', error);
  });
};

// 导出内部函数供测试使用
module.exports._validateConfig = validateConfig;
module.exports._calculateMD5 = calculateMD5;
module.exports._getFiles = getFiles;
module.exports._withRetry = withRetry;
module.exports._buildPurgeUrls = buildPurgeUrls;
