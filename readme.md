# hexo-deployer-tencent

一个 Hexo 部署插件，用于将静态文件上传到腾讯云对象存储（COS）并刷新（CDN/EdgeOne）缓存。

## 功能概述

该插件提供以下功能：

- 将指定路径的静态文件上传至腾讯云对象存储，通过 MD5 校验仅上传变更内容。
- 支持根据配置自动清理对象存储（COS）中的冗余文件，默认关闭此功能。
- 依据配置，使用指定域名刷新变更文件的（CDN/EdgeOne）缓存，支持配置多个域名。
- 可根据配置文件，在刷新缓存时过滤指定目录下的文件，灵活控制刷新范围。
- 可根据配置文件，在刷新缓存时将永久链接尾部的 `index.html` 转换为根路径形式。

## 安装使用

1. 在 Hexo 项目根目录下运行以下命令安装插件：

    ```bash
    npm install hexo-deployer-tencent
    ```

2. 运行以下命令生成并部署静态文件：

    ```bash
    hexo generate && hexo deploy
    ```

## 配置示例

在 Hexo 的 `_config.yml` 中添加以下配置：

```yaml
deploy:
  type: tencent-cos
  secret_id: your_secret_id
  secret_key: your_secret_key
  bucket: your_bucket
  region: your_region
  upload_dir: public  # 默认上传 Hexo 的 public 目录
  cache_type: cdn # 可选值 cdn（默认）, edgeone
  cdn_domains:
      - domain: https://static.example.com
        ignore_extensions: ['.html']
      - domain: https://example.com
        ignore_paths: ['/js', '/css', '/img']
  remove_remote_files: true  # 是否删除 COS 中多余的远程文件
  refresh_index_page: true  # 是否将 index.html 刷新为根路径
  concurrency: 10  # 腾讯云 API 并发数
  enable_log: false  # 是否打印日志
```

`cdn_domains` 支持配置多个域名，适用于一个存储桶绑定多个自定义域名的场景，可通过 `ignore_paths` 和 `ignore_extensions` 灵活指定刷新时需要过滤的目录或文件格式。

## 属性说明

### 基础配置

| 属性名 | 类型 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `secret_id` | String | 是 | - | 腾讯云 API Secret ID |
| `secret_key` | String | 是 | - | 腾讯云 API Secret Key |
| `bucket` | String | 是 | - | COS 存储桶名称，如 `my-bucket-1250000000` |
| `region` | String | 是 | - | 存储桶所在区域，如 `ap-guangzhou` |
| `upload_dir` | String | 是 | - | 本地上传目录（相对于 Hexo 根目录），通常为 `public` |
| `concurrency` | Number | 否 | `10` | 并发数，取值范围 1~50 |
| `enable_log` | Boolean | 否 | `false` | 是否打印日志 |

### 缓存刷新配置

| 属性名 | 类型 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `cache_type` | String | 否 | `cdn` | 刷新类型：`cdn` 或 `edgeone` |
| `cdn_domains` | Array | 否 | `[]` | 加速域名列表，未设置则不刷新缓存 |
| `remove_remote_files` | Boolean | 否 | `false` | 是否删除 COS 中多余的远程文件 |
| `refresh_index_page` | Boolean | 否 | `false` | 是否将 `*/index.html` 转换为 `*/` 进行刷新 |

### cdn_domains 子属性

| 属性名 | 类型 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `domain` | String | 是 | 加速域名，以 `http://` 或 `https://` 开头 |
| `ignore_paths` | Array | 否 | 忽略的相对路径[^1]，如 `['/js', '/css']` |
| `ignore_extensions` | Array | 否 | 忽略的文件扩展名[^2]，如 `['.html', '.txt']` |

### 注意事项

- 默认行为是上传变更文件但不删除远程文件、不刷新缓存。
- `cdn` 按 URL 刷新；`edgeone` 免费版配额不足时按 Hostname 刷新[^3]，其它按 URL 刷新。
- `refresh_index_page` 不影响根目录 `index.html`（始终刷新为 `/index.html`）。

## 工作流程

```text
hexo deploy
  └─ validateConfig    校验配置
  └─ initClients       初始化 COS / CDN / EdgeOne 客户端
  └─ main
       ├─ getFiles            递归获取本地文件列表
       ├─ calculateMD5        流式计算文件 MD5
       ├─ headObject + 比对   与远程 ETag 对比，跳过未变更文件
       ├─ uploadFile          上传变更文件（带重试）
       ├─ deleteCosFiles      删除远程多余文件（分批 + 重试）
       └─ 缓存刷新
            ├─ purgeCdnCache       CDN：按 URL 批量刷新（带重试）
            └─ purgeEdgeOneCache   EdgeOne：按 URL 或 Hostname 刷新
```

## 许可证

MIT License

[^1]: 指定路径下的文件即使发生变更，也不会触发缓存刷新。

[^2]: 指定扩展名的文件即使发生变更，也不会触发缓存刷新。

[^3]: 当待刷新 URL 数量超出每日剩余配额时，回退为按 Hostname 刷新（标记缓存过期）。
