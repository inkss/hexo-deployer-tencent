const COS = require('cos-nodejs-sdk-v5');
const TencentCloudCommon = require('tencentcloud-sdk-nodejs-common');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { promisify } = require('util');
const pLimit = require('p-limit').default;
const retry = require('retry');

const readFileAsync = promisify(fs.readFile);
const readdirAsync = promisify(fs.readdir);
const statAsync = promisify(fs.stat);

const CommonClient = TencentCloudCommon.CommonClient;

/**
 * 校验 Hexo 部署配置
 * @param {Object} hexo - Hexo 实例
 * @returns {Object|null} 配置对象，校验失败返回 null
 */
const validateConfig = (hexo) => {
  const config = hexo.config.deploy;
  if (!config) {
    console.error('错误：未找到 deploy 配置，请在 _config.yml 中配置');
    return null;
  }

  const domainRegex = /^https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  const required = ['secret_id', 'secret_key', 'bucket', 'region', 'upload_dir'];
  const errors = [];

  // 检查必填项
  required.forEach(item => {
    if (!config[item]) errors.push(`缺少配置项: ${item}`);
    else if (config[item] === `your_${item}`) errors.push(`未正确配置: ${item}`);
  });

  // 校验缓存类型
  const cache_type = config.cache_type || 'cdn';
  if (!['edgeone', 'cdn'].includes(cache_type)) {
    errors.push(`不支持的缓存类型 "${cache_type}"，请使用 "edgeone" 或 "cdn"`);
  }

  // 校验 CDN 域名
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
    console.error('配置错误：');
    errors.forEach(error => console.error(`- ${error}`));
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
      ignorePaths: (item.ignore_paths || []).filter(p => p).map(path => {
        let normalized = path.startsWith('/') ? path.slice(1) : path;
        return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
      }),
      ignoreExtensions: (item.ignore_extensions || []).map(ext => ext.toLowerCase())
    })),
    removeRemoteFiles: config.remove_remote_files || false,
    refreshIndexPage: config.refresh_index_page || false,
    concurrency: config.concurrency || 10
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
 * 计算文件 MD5 值
 * @param {string} filePath - 本地文件路径
 * @returns {Promise<string>} MD5 值
 */
const calculateMD5 = async (filePath) => {
  const fileBuffer = await readFileAsync(filePath);
  return crypto.createHash('md5').update(fileBuffer).digest('hex');
};

/**
 * 递归获取目录下所有文件
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
 * 获取 COS 存储桶中的文件列表
 * @param {COS} cos - COS 客户端
 * @param {Object} config - 配置对象
 * @param {Function} limit - 并发限制函数
 * @returns {Promise<string[]>} 文件 Key 数组
 */
const listCosFiles = async (cos, config, limit) => {
  let contents = [];
  let continuationToken;
  do {
    const data = await limit(() => new Promise((resolve, reject) => {
      cos.getBucket({ Bucket: config.bucket, Region: config.region, ContinuationToken: continuationToken }, (err, data) => {
        err ? reject(err) : resolve(data);
      });
    }));
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
  const operation = retry.operation({ retries: 3, factor: 2, minTimeout: 1000 });
  await new Promise((resolve, reject) => {
    operation.attempt(async () => {
      try {
        await cos.putObject({
          Bucket: config.bucket,
          Region: config.region,
          Key: key,
          Body: fs.createReadStream(filePath)
        });
        console.info(`[${new Date().toISOString()}] 上传成功: ${key}`);
        resolve();
      } catch (error) {
        if (operation.retry(error)) return;
        reject(error);
      }
    });
  });
};

/**
 * 删除 COS 中的文件
 * @param {COS} cos - COS 客户端
 * @param {Object} config - 配置对象
 * @param {string[]} keys - 要删除的文件 Key 数组
 * @returns {Promise<void>}
 */
const deleteCosFiles = async (cos, config, keys) => {
  if (!keys.length) return;
  const objects = keys.map(key => ({ Key: key }));
  await cos.deleteMultipleObject({ Bucket: config.bucket, Region: config.region, Objects: objects });
  console.info(`[${new Date().toISOString()}] 删除 ${keys.length} 个远程文件`);
};

/**
 * 刷新 CDN 缓存
 * @param {CommonClient} cdn - CDN 客户端
 * @param {string[]} urls - URL 数组
 * @returns {Promise<void>}
 */
const purgeCdnCache = async (cdn, urls) => {
  const batchSize = 1000;
  for (let i = 0; i < urls.length; i += batchSize) {
    const batchUrls = urls.slice(i, i + batchSize);
    await cdn.request('purgeCdnCache', { Urls: batchUrls });
    console.info(`[${new Date().toISOString()}] 刷新 ${batchUrls.length} 个 CDN URL`);
  }
};

/**
 * 刷新 EdgeOne 缓存
 * @param {CommonClient} edgeone - EdgeOne 客户端
 * @param {string[]} urls - URL 数组
 * @returns {Promise<void>}
 */
const purgeEdgeOneCache = async (edgeone, urls) => {
  // 校验 URL 格式
  const invalidUrls = urls.filter(u => {
    try { new URL(u); return false; } catch { return true; }
  });
  if (invalidUrls.length) {
    console.error(`[${new Date().toISOString()}] 无效的 URL: ${invalidUrls.join(', ')}`);
    return;
  }

  // 提取唯一主域名
  const mainDomains = new Set(urls.map(u => {
    const hostname = new URL(u).hostname;
    return hostname.split('.').slice(-2).join('.');
  }));

  for (const mainDomain of mainDomains) {
    // 获取 ZoneId
    let zoneId;
    try {
      const response = await edgeone.request("DescribeZones", {});
      const zone = (response?.Zones || []).find(z => z.ZoneName === mainDomain || z.ZoneName.endsWith(`.${mainDomain}`));
      zoneId = zone?.ZoneId;
      if (!zoneId) {
        console.error(`[${new Date().toISOString()}] 未找到 ${mainDomain} 对应的 ZoneId`);
        continue;
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] 获取 ${mainDomain} 的 ZoneId 失败:`, error);
      throw new Error(`无法获取 ${mainDomain} 的 ZoneId`);
    }

    let quota; // 获取配额
    try {
      const response = await edgeone.request("DescribeContentQuota", { ZoneId: zoneId });
      const purgeUrlQuota = (response?.PurgeQuota || []).find(q => q.Type === 'purge_url'); // 按 URL刷新
      quota = {
        batchLimit: purgeUrlQuota?.Batch || 500, // 单次批量提交配额上限。
        dailyLimit: purgeUrlQuota?.Daily || 1000, // 每日提交配额上限。
        dailyAvailable: purgeUrlQuota?.DailyAvailable || 0 // 每日剩余的可提交配额。
      };
    } catch (error) {
      console.error(`[${new Date().toISOString()}] 获取 ZoneId ${zoneId} 的配额失败:`, error);
      throw new Error(`无法获取 ZoneId ${zoneId} 的配额`);
    }

    const isFreePlan = quota.batchLimit === 500; // 免费版单次 500
    const batchSize = isFreePlan ? 500 : 1000;
    const domainUrls = urls.filter(u => new URL(u).hostname.endsWith(mainDomain));

    // 创建清除任务
    const tasks = isFreePlan && domainUrls.length > quota.dailyAvailable
      ? [{ type: 'purge_host', targets: [mainDomain], method: 'invalidate' }]
      : Array.from({ length: Math.ceil(domainUrls.length / batchSize) }, (_, i) => ({
        type: 'purge_url',
        targets: domainUrls.slice(i * batchSize, (i + 1) * batchSize),
        method: 'delete'
      }));

    // 执行清除任务
    for (const task of tasks) {
      const operation = retry.operation({ retries: 3, factor: 2, minTimeout: 1000 });
      await new Promise((resolve) => {
        operation.attempt(async () => {
          try {
            await edgeone.request("CreatePurgeTask", {
              ZoneId: zoneId,
              Type: task.type,
              Targets: task.targets,
              Method: task.method || 'delete'
            });
            console.info(`[${new Date().toISOString()}] 清除缓存任务成功: Type=${task.type}, Targets=${task.targets}`);
            resolve();
          } catch (error) {
            if (operation.retry(error)) return;
            console.error(`[${new Date().toISOString()}] 清除缓存任务失败（ZoneId: ${zoneId}）:`, error);
            resolve();
          }
        });
      });
    }
  }
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
  const changedFiles = [];
  const localFileKeys = new Set(localFiles.map(filePath => path.relative(config.uploadDir, filePath).replace(/\\/g, '/')));

  // 获取远程文件
  const remoteFiles = config.removeRemoteFiles ? await listCosFiles(cos, config, limit) : [];

  // 上传变更文件
  await Promise.all(localFiles.map(filePath => limit(async () => {
    const key = path.relative(config.uploadDir, filePath).replace(/\\/g, '/');
    const localMD5 = await calculateMD5(filePath);
    if (!localMD5) return;

    try {
      const data = await cos.headObject({ Bucket: config.bucket, Region: config.region, Key: key });
      if (data.ETag?.replace(/"/g, '') === localMD5) return;
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }

    await uploadFile(cos, config, key, filePath);
    changedFiles.push(key);
  })));

  // 删除多余远程文件
  if (config.removeRemoteFiles) {
    const filesToDelete = remoteFiles.filter(key => !localFileKeys.has(key));
    await deleteCosFiles(cos, config, filesToDelete);
  }

  // 刷新缓存
  if (config.cdnDomains.length && changedFiles.length) {
    const urls = [];
    config.cdnDomains.forEach(({ domain, ignorePaths, ignoreExtensions }) => {
      changedFiles.forEach(file => {
        if (ignorePaths.some(p => p && (file.startsWith(p + '/') || file === p))) return;
        if (ignoreExtensions.includes(path.extname(file).toLowerCase())) return;
        if (file === 'index.html') file = '/index.html';
        const urlPath = config.refreshIndexPage && file.endsWith('/index.html')
          ? `${file.replace(/\/index\.html$/, '/')}`
          : `${file}`;
        urls.push(new URL(urlPath, domain).toString());
      });
    });

    if (config.cache_type === 'cdn') {
      await purgeCdnCache(cdn, urls);
    } else if (config.cache_type === 'edgeone') {
      await purgeEdgeOneCache(edgeone, urls);
    }
  }

  console.info(`[${new Date().toISOString()}] 部署完成！`);
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
    console.error(`[${new Date().toISOString()}] 部署失败:`, error);
  });
};