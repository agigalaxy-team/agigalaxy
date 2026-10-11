# 银河官网

`product_pages.py` 是当前用户页面，`chrome.py` 提供公共导航，`site.css` 和 `navigation.js` 实现样式与交互。官网和 `/app/` 网页工作区共享入口；整个产品重构仍在进行。

从仓库根目录运行 `npm run build:site` 构建官网，或 `npm run build` 同时构建官网与网页工作区。要求 Python 3.11+ 和 Node.js 24.13+。默认输出为 `apps/galaxy-site/dist` 与 `packages/galaxy-web/dist`，默认网站明确标为未发行预览。

`release-data.json` 记录最近导入的公开发行资料。`public-archive.json` 固定已公开历史文档与下载的地址和 SHA-256。首次构建从官方网站读取这些公开文件并核对摘要，后续使用被忽略的 `.cache`；可通过 `npm run build:site -- --offline` 验证离线构建。构建无需本机凭据、私人仪表盘或仓库外的运维报告。

发布构建需要明确的组件版本，例如 `npm run build -- --site-release 0.1.17 --api-release 0.1.12`。这只生成制品，不会发布或证明对应 API 已上线。发布前应以实际服务版本更新 `release-data.json` 的观测记录，并用已校验的客户端发行资料更新当前下载与安装说明。保留已公开的历史下载地址。

AI Agent 应先检查当前服务、制品哈希、历史迁移兼容性及公开配置。网站构建和服务部署分别执行；不要将本地预览标识、虚构内容或测试身份作为发行数据。发布后从真实 HTTPS 页面检查搜索、身份接续、工作和客户端入口。

官网的响应策略须允许同源 `navigation.js` 与搜索表单。例如静态页采用 `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`。`/app/` 继续使用自己的 API 连接策略。旧静态页的 `form-action 'none'` 会阻止首页提交，缺少 `script-src` 会阻止手机菜单增强；HTTP 200 与本地构建都不能发现这类线上浏览器阻断。
