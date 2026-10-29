# 银河产品网页

产品网站由 [apps/galaxy-site](../../apps/galaxy-site/) 的 Next.js 路由装配本包的共享 React 页面和会话；本包不提供独立网站路由。根仓 app 及 demo 脚本保留早期演示用途。

领域页面、客户端、类型与样式集中在`src/features/`，人物、身份、阅读和操作生命周期等跨领域能力归`src/shared/`。根目录的应用、运行时与外壳入口承担真实组合职责；状态、草稿和读取租约由原会话唯一持有，展示组件不另建副本。

## 负责的用户工作

发现和查询、社区与回复、账户与公开资料、对话与通知、收藏、工作与结果、人物和方法在同一工作区中接续。普通网站参与使用在线账户；本地银河 ID 与设备签名只在相应客户端操作中介入。

内容先呈现，动作就近发生。返回和认证接续保留独立草稿与定位；旧异步结果不覆盖新对象。受控正文每次按当前来源、版本、受众和期限读取，离线或无法核实时按适用规则收起。

## 共用模块

- [site-chrome.mjs](src/site-chrome.mjs)：官网、Web 和 Keycloak 直接调用的品牌、顶栏、导航与搜索。
- [网站界面](../../docs/product/experience.md)：共用外壳的生成与使用。
- [客户端交互](../../docs/product/experience.md)：读取任务、等待、失败及复制行为复用。
- [账户参与](../../docs/product/data-and-files.md)：普通账户与附件合同。
- [公开查询](../../docs/product/data-and-files.md)：UID、账户、ID 与外部凭据范围。

## 开发与构建

在仓库根目录运行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run dev
```

开发地址为 **http://127.0.0.1:5179/app/**。根 `npm run dev` 启动 Next 网站，根 build / start 和站点构建见[开发指南](../../docs/technical/development.md)。前端预览不启动 API；业务功能需要所选公开配置、准确 Origin 和实际服务。

本地浏览器观察使用独立无头上下文和明示合成材料，真实 API、OIDC、聊天、存储及模型的范围分别记录。不得从某次前端检查推定完整产品或全部依赖已经验收。当前已发行与候选范围见[项目状态](../../WORK_STATUS.md)。

`scripts/` 的浏览器工具共用 `browser-tool-runtime.mjs`，使用根依赖中的 Playwright 和独立无头浏览器。首次按需执行 `node node_modules/playwright/cli.js install chromium`；默认结果写入仓库 `outputs/<脚本名>/tmp/`，与启动目录无关。原有报告目录环境变量仍可指定输出，通用临时产物管理见根开发规则。

