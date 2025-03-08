const deployer = require('./lib/deployer'); // 假设部署逻辑在 deployer.js 文件中

hexo.extend.deployer.register('tencent-cos', deployer);
