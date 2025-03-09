# hexo-deployer-tencent

一个 Hexo 部署插件，用于将静态文件上传到腾讯云对象存储（COS）并刷新 CDN 缓存。

## 功能概述

该插件提供以下功能：

- 将指定路径的静态文件上传至腾讯云对象存储，通过 MD5 校验仅上传变更内容。
- 支持根据配置自动清理对象存储（COS）中的冗余文件，默认关闭此功能。
- 依据配置，使用指定域名刷新变更文件的 CDN 缓存，支持配置多个域名。
- 可根据配置文件，在刷新 CDN 缓存时过滤指定目录下的文件，灵活控制刷新范围。
- 支持根据配置，在刷新 CDN 时将永久链接尾部的 `index.html` 转换为根路径形式。

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
  cdn_domains:
      - domain: https://static.example.com
        ignore_paths: []
      - domain: https://example.com
        ignore_paths: ['/js', '/css', '/img/demo/']
  remove_remote_files: true  # 是否删除 COS 中多余的远程文件
  refresh_index_page: true  # 是否将 index.html 刷新为根路径
  concurrency: 10  # 腾讯云 API 并发数
```

`cdn_domains` 支持配置多个域名，适用于一个存储桶绑定多个自定义域名的场景，可通过 `ignore_paths` 灵活指定 CDN 刷新时需要过滤的目录。

## 属性说明

| 属性名              | 类型    | 是否必填 | 默认值 | 描述                                                         |
| ------------------- | ------- | -------- | ------ | ------------------------------------------------------------ |
| `secret_id`         | String  | 是       | 无     | 腾讯云 API 的 Secret ID，用于身份验证。                      |
| `secret_key`        | String  | 是       | 无     | 腾讯云 API 的 Secret Key，用于身份验证。                     |
| `bucket`            | String  | 是       | 无     | 腾讯云 COS 的存储桶名称，例如 `my-bucket-1250000000`。       |
| `region`            | String  | 是       | 无     | 存储桶所在区域，例如 `ap-guangzhou`。                        |
| `upload_dir`        | String  | 是       | 无     | 本地上传目录，相对于 Hexo 根目录，通常为 `public`。          |
| `cdn_domains`       | Array   | 否       | `[]`   | CDN 加速域名列表，每项可包含 `ignore_paths`，未设置则不刷新 CDN。 |
| `cdn_domains.domain` | String | 是 | 无 | 加速域名，以 `https://` 或 `http://` 开头。 |
| `cdn_domains.ignore_paths` | Array | 否 | 无 | 加速域名的忽略路径，支持多个相对（`upload_dir`）路径。 |
| `remove_remote_files` | Boolean | 否    | `false` | 是否删除 COS 中不在本地文件列表中的远程文件。                |
| `refresh_index_page`  | Boolean | 否    | `false` | 是否将 `index.html` 的 CDN 刷新 URL 转换为根路径（例如 `/`）。 |
| `concurrency`       | Number  | 否       | `10`   | 文件上传和 CDN 刷新的并发数，受限于腾讯云 API 并发限制。      |

### 注意事项

- **必填项**：`secret_id`、`secret_key`、`bucket`、`region` 和 `upload_dir` 是必须提供的。
- **可选项**：未设置的可选项将使用默认值，默认行为是上传文件但不删除远程文件或刷新 CDN。
- **路径处理**：`upload_dir` 是相对于 Hexo 项目根目录的路径，通常应设置为 `public`。
- **永久链接**：当永久链接中去除尾部的 `index.html` 时，CDN 刷新缓存时应刷新 `/` 而非 `/index.html`。

## 处理流程

![处理流程](https://github.com/inkss/hexo-deployer-tencent/blob/main/img/export.svg)

## 许可证

MIT License
