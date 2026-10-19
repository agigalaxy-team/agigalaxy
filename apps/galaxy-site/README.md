# 银河官网

`product_pages.py` 是当前用户页面，`chrome.py` 提供公共外壳，`site.css` 和 `navigation.js` 实现样式与交互。`guide_pages.py` 将安装、宿主和专业配置说明生成可阅读页面。官网和 `/app/` 网页工作区共享入口。

首页保持独立布局。其余现行页面与 React 工作区共用 `workspace-navigation.json` 中的一级导航，以及 `packages/galaxy-web/src/selected-shell.css` 中的外壳样式；官网构建把同一份样式写入 `/assets/selected-shell.css`。品牌属于顶栏，固定一级导航从顶栏下方开始，账户、公共指南和本页目录随内容滚动。接入与 AI 的状态和操作在 `/app/account?section=access`，收藏沿 `/app/bookmarks` 纳入账户。`/downloads/` 保留客户端下载、安装和核验资料；`/start/` 是开始使用说明，链接到实际账户接入。

`public_reading.py` 同时把现行非首页内容转换为安全内容树，写入 `/assets/public-pages/`。标签、属性、大小与可用交互由 `public-reading-contract.json` 限定；脚本、事件属性、内联样式、iframe 和未知行为均被拒绝。React 的 `PublicReadingWorkspace` 通过 `createElement` 呈现同一内容，不注入 HTML，也不执行文档内脚本。当前安装、原始文件、签名核验和下载都是实际链接，保持浏览器正常行为；公开页与业务页之间沿同一个 App 切换，保留外壳、URL、锚点与阅读记录。原始版本文档和下载文件独立保存，不经过内容树重写。

从仓库根目录运行 `npm run build:site` 构建官网，或 `npm run build` 同时构建官网与网页工作区。要求 Python 3.11+ 和 Node.js 24.13+。默认输出为 `apps/galaxy-site/dist` 与 `packages/galaxy-web/dist`，默认网站明确标为未发行预览。

统一构建先完成 Web，再把该构建的 entry、CSS 地址和摘要交给官网。非首页的 `public-bootstrap.js` 预读当前内容树并启动同一个 App，失败时保留原 URL 的可阅读 HTML。独立官网构建只有显式提供 `--web-dist <已完成Web目录>` 才启用此增强，避免自动混入旧工件。独立输出可用 `npm run build -- --web-output <Web目录> --output <官网目录>`；这两个目录的文件作为同一批制品提供。

`release-data.json` 记录最近导入的公开发行资料。`public-archive.json` 固定已公开历史文档与下载的地址和 SHA-256。首次构建从官方网站读取这些公开文件并核对摘要，后续使用被忽略的 `.cache`；`--offline` 使用已有缓存构建。目录中的 `docs/index.html` 与 `downloads/index.html` 是本轮重构的现行入口；这两份旧入口原件按原始字节另存于 `/archives/public/<原路径>`，其余固定文档和下载保留原地址及字节。下载核验页提供旧入口原件链接。构建无需本机凭据、私人仪表盘或仓库外的运维报告。

发布构建需要明确的组件版本，例如 `npm run build -- --site-release 0.1.20 --api-release 0.1.15`。这只生成制品，不会发布或证明对应 API 已上线。发布前应以实际服务版本更新 `release-data.json` 的观测记录，并用已校验的客户端发行资料更新当前下载与安装说明。保留已公开的历史下载地址。

网站构建和服务部署分别执行，发行数据使用实际服务版本、公开配置与内容。开发方法见[项目工作规则](../../../../../02-architecture/current/WORK_RULES.md)，工具入口见[开发检查参考](../../docs/development-checks.md)。

官网的响应策略须允许同源脚本、内容树读取与搜索表单。首页可以使用 `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`。非首页渐进启动后使用与 `/app/` 相同的准确 API 连接策略，并允许同源 `/assets/public-pages/` 与 `/assets/workspace-entry.json`；部署时根据所选公开配置核对实际 `connect-src`，不要为此扩大到任意来源。旧静态页的 `form-action 'none'` 会阻止搜索，缺少 `connect-src` 会使 App 增强留在静态回退；HTTP 200 与本地构建不能发现这类线上浏览器阻断。
