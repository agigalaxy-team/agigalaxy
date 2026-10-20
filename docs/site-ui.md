# 共用网站界面

官网 Web、公开静态页和认证站从同一组展示组件和样式构建。认证站只适配 Keycloak 的实际内容、表单和会话，页面外壳没有另一份近似实现。

| 职责 | 唯一实现与调用位置 |
|---|---|
| 品牌、六项导航、顶栏、搜索及动作布局 | [site-chrome.mjs](../packages/galaxy-web/src/site-chrome.mjs)；Web 的 SiteShell 直接调用，公开页和认证构建使用 ReactDOMServer 渲染同一组件 |
| 当前主题、字体和基础控件 | [site-foundation.css](../packages/galaxy-web/src/site-foundation.css)；原 porcelain-theme 使用此源，认证输入与主按钮使用同一控件类 |
| 固定侧栏、顶栏与手机底栏 | [selected-shell.css](../packages/galaxy-web/src/selected-shell.css)；三个表面直接消费源文件，720px 以下使用同一布局规则 |
| 搜索目标与认证环境导航 | [site-search.mjs](../packages/galaxy-web/src/site-search.mjs)；只取得输入的 q，不沿用认证URL中的其他参数 |
| 公开构建适配 | [render-shell.mjs](../apps/galaxy-site/render-shell.mjs) 一次批量渲染，Python 保留页面内容、历史资料和单一 main |
| 认证内容适配 | [galaxy-auth](../apps/galaxy-auth/README.md)；SSR 保留消息和内容槽，Keycloak 的原生 form action、会话字段、认证状态和返回由原流程处理 |

顶栏允许按当前页面传入搜索处理和动作内容。Web 的功能目录继续使用真实详情交互；不挂载 Web runtime 的静态和认证页面用真实文档导航。普通链接使用当前表面对应的实际官网地址，不伪造本机接入或账户状态。首页仍使用已选的独立布局，其品牌也来自同一源。

认证站的语言选择属于表单内容。认证提交控制只绑定认证内容中的实际表单，共用顶栏搜索独立处理；搜索不提交认证字段，也不复用 OAuth 请求参数。

网站构建需要当前仓库依赖和 Node。统一构建入口自动将当前 Node 传给 Python；单独运行公开站构建时可用 --node /absolute/path/to/node。认证主题和静态站的 CSS、搜索模块均打包在各自同源目录，生产不依赖另一域名运行时加载样式或 React 应用。

认证构建按实际资源内容产生版本参数，同时用于入口 CSS、脚本、品牌图标及相对依赖，让已有浏览器缓存更新到同一批资源。共用搜索源保留为 ESM；认证制品发布为 `.js`，对应 Keycloak 26.7.3 的 JavaScript MIME 映射。

开发方法见[项目工作规则](../../../../02-architecture/current/WORK_RULES.md)，具体发行及支持范围见[当前状态](../../../../02-architecture/current/chapters/11-current-state.md)。

