# hexo-deployer-tencent

一个 Hexo 部署插件，用于将静态文件上传到腾讯云对象存储（COS）并刷新 CDN 缓存。

## 功能概述

该插件将实现以下功能：

1. **读取配置**：从 _config.yml 的 tencent_cos 配置项中获取 COS 和 CDN 参数。
2. **文件上传**：将 Hexo 的静态文件上传到腾讯云 COS，支持 MD5 校验和重试机制。
3. **文件同步**：根据配置删除 COS 中多余的远程文件。
4. **CDN 刷新**：根据配置刷新指定 CDN 域名的缓存。

## 安装使用

1. 在 Hexo 项目根目录下运行以下命令安装插件：

    ```bash
    npm install hexo-deploy-tencent
    ```

2. 运行以下命令生成并部署静态文件：

    ```bash
    hexo generate && hexo deploy
    ```

## 配置示例

在 Hexo 的 _config.yml 中添加以下配置：

```yaml
deploy:
  type: tencent-cos
  secret_id: your_secret_id
  secret_key: your_secret_key
  bucket: your_bucket
  region: your_region
  upload_dir: public  # 默认上传 Hexo 的 public 目录
  cdn_domains: 
    - https://static.example.com
    - https://example.com
  remove_remote_files: true  # 是否删除 COS 中多余的远程文件
  refresh_index_page: true  # 是否将 index.html 刷新为根路径
  concurrency: 10  # 腾讯云 API 并发数
```

## 属性说明

| 属性名              | 类型    | 是否必填 | 默认值 | 描述                                                         |
| ------------------- | ------- | -------- | ------ | ------------------------------------------------------------ |
| secret_id           | String  | 是       | 无     | 腾讯云 API 的 Secret ID，用于身份验证。                      |
| secret_key          | String  | 是       | 无     | 腾讯云 API 的 Secret Key，用于身份验证。                     |
| bucket              | String  | 是       | 无     | 腾讯云 COS 的存储桶名称，例如 my-bucket-1250000000。         |
| region              | String  | 是       | 无     | 存储桶所在区域，例如 ap-guangzhou。                          |
| upload_dir          | String  | 是       | 无     | 本地上传目录，相对于 Hexo 根目录，通常为 public。            |
| cdn_domains         | Array   | 否       | []     | CDN 加速域名列表，未设置不刷新 CDN。                         |
| remove_remote_files | Boolean | 否       | false  | 是否删除 COS 中不在本地文件列表中的远程文件。                |
| refresh_index_page  | Boolean | 否       | false  | 是否将 index.html 的 CDN 刷新 URL 转换为根路径（例如 /）。   |
| concurrency         | Number  | 否       | 10     | 文件上传和 CDN 刷新的并发数，受限于 *腾讯云 API 并发数* 限制。 |

### 注意事项

- **必填项**：`secret_id`、`secret_key`、`bucket`、`region` 和 `upload_dir` 。
- **可选项**：未设置的可选项将使用默认值，默认行为是上传文件但不删除远程文件或刷新 CDN。
- **路径处理**：`upload_dir` 是相对于 Hexo 项目根目录的路径，通常应设置为 `public`。
- **永久链接**：当永久链接中去除尾部的 `index.html` 时，CDN 刷新缓存时应当刷新 `/` 而非 `/index.html`。

## 处理流程

<div style="text-align: center;">
  <img src="https://github.com/inkss/hexo-deployer-tencent/blob/main/img/export.svg" alt="处理流程">
</div>

## 许可证

MIT License
