# 开发、局部构建与检查

从本次准确源码和受影响组件开始。维护工程方法的规则在根 [`AGENTS.md`](../../AGENTS.md)；本页集中环境、命令和结果边界。已有实现、助手建议和旧文档不自动产生已确认产品需求。

## 获取源码与选择环境

```sh
git clone https://github.com/agigalaxy-team/agigalaxy.git
cd agigalaxy
```

远端访问取决于实际仓库权限。认证使用凭据管理器或已有 HTTPS/SSH，令牌不进入 URL。`main` 是长期集成线，任务按需要使用短期分支；复现须选准确提交，本地未推送候选和已部署冻结源不能用远端 main 代替。

| 范围 | 工具链与安装根 |
|---|---|
| 完整开发、Hub、A2A、Admin | Node.js 24.13+，按各自 `package-lock.json` 安装 |
| 官网生成 | Python 3.11+；根构建器发现本机 Python |
| AgentOS/Gateway | Python 3.12；AgentOS 独立虚拟环境及 `requirements.lock`；Gateway 固定上游及其锁文件 |
| 已发行 Native 客户端 | 包要求 Node.js 22.13+，与完整开发门槛分开 |
| 数据库/外部服务检查 | 专用隔离环境，不使用运行库、运行角色或个人浏览器状态 |

只安装本次需要的组件。根 `npm run setup` 顺序安装根、Official、A2A、`integrations/native-v2/compact-app`，不安装 Admin、不创建数据库或启动服务。Admin 单独运行 `npm ci --ignore-scripts --no-audit --no-fund --prefix apps/galaxy-admin`；AgentOS 按其组件 README 安装锁定依赖。

## 网页工作与真实 API

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run dev
```

Web 开发入口为 `http://127.0.0.1:5179/app/`。锁未变且依赖已安装时直接 dev。仅 Web 用 `npm run build:web`，仅官网用 `npm run build:site`；完整预览使用 `npm run build` 后 `npm start`，打开 `http://127.0.0.1:5179/`。构建输出为 `packages/galaxy-web/dist`、`apps/galaxy-site/dist`，不附带全套业务检查。

[`scripts/build-product.mjs`](../../scripts/build-product.mjs) 统一构建，[`serve-product.mjs`](../../scripts/serve-product.mjs) 本机预览，端口可用 `GALAXY_PREVIEW_PORT` 指定。首次官网构建获取固定公开历史资料与下载文件；`--offline` 需要已有缓存，或在对应组件入口用 `--preserved-public-source` 指定准确旧公开发行目录。缺少历史二进制时不能用空文件冒充。

前端预览不启动 Hub。连接业务时给预览进程设置 `GALAXY_WEB_CONFIG_FILE`，值为公开 JSON 的绝对路径。字段以 `serve-product.mjs` 的 `publicConfiguration()` 为准：`version:1`、无凭据 `endpoint`、当前公钥 `signingKeys`（kid/有效期/撤销状态），可选 `operator`。API 的 browser policy 同时允许准确 Origin；静态可读不代表 Cookie、CSRF 或签名操作已可用。公开配置不含服务私钥或数据库连接。

## 官网内容树与制品配对

Site的public_reading.py把现行非首页内容转成/assets/public-pages/安全树，public-reading-contract.json约束标签/属性/大小/交互，拒脚本、事件属性、inline style、iframe和未知行为；Web通过createElement呈现，不注入HTML。product_pages/guide_pages/chrome与workspace-navigation/selected-shell复用入口。首页独立，非首页public-bootstrap预读树并启动同App，失败保原URL静态HTML；原始版本指南/下载不被树重写。

统一build先Web再传entry/CSS/摘要给Site，独立Site必须显式--web-dist才增强。可用 `npm run build -- --web-output <Web目录> --output <Site目录>` 配对输出，发行构建显式--site-release/--api-release，release-data取真实观测。public-archive固定公开旧文件地址/摘要，首次网络后.cache可offline；被替换的旧docs/downloads入口字节留/archives/public/，历史下载不改地址。

静态响应须允许同源脚本、字体/图像、搜索form-action及安全树/workspace-entry读取；非首页按当前公开配置精确connect-src至API，缺项会停在静态回退。default-src none而form-action none会阻搜索，HTTP200/构建不检测目标浏览器CSP。组件构建参数仍以实际build-product/官网生成器为准。

## 组件构建与真实边界

[`repository-components.json`](../../repository-components.json) 与 [`scripts/components.mjs`](../../scripts/components.mjs) 共同定位入口、依赖和资源：

```sh
npm run components -- list
npm run build:component -- --component web --output outputs/review-web
npm run build:component -- --component hub --output outputs/review-hub
npm run check:component -- --component hub --output outputs/check-hub
node scripts/components.mjs plan --base <准确Git提交> --output outputs/component-plan.json
node scripts/components.mjs imports --output outputs/component-imports.json
python scripts/create-release-baseline.py
```

按所需结果选择命令。输出须在仓库 `outputs/` 内或仓库外的新目录；拒绝非空目录和指回源码的链接。

| 组件/动作 | 能证明什么及仍需输入 |
|---|---|
| Web | 实际 Vite 打包 |
| Site | 先构建 Web，再运行网站生成器；公开发行目录、资产和下载按生成器合同提供 |
| Hub capture | API/worker/migration/publisher 四入口、完整迁移和显式资源的服务源码包；不安装或部署 |
| Auth | Keycloak 主题；Java 邮件验证码 provider 需自己的 Java21/Keycloak26.7.3 构建，再经 `--provider-jar` 合入 |
| Admin | 独立 Next/Payload 锁和构建；根产品 build 不覆盖它 |
| AgentOS/Model Gateway | catalog 仅编译 Python 代码对象，不导入服务、连接库、构建镜像或证明持久化运行 |
| Discovery/OpenPanel | 完整上游是显式外部输入，按 [`SOURCE_BUILD.md`](../../services/galaxy-discovery/SOURCE_BUILD.md) 和 `source-inputs.json` 组装固定源码、补丁及许可 |

计划同时读取声明依赖、配置/入口及真实相对 import，未知工程源码进入 `blockedInputs` 并停止生成执行计划；纯文档可没有 matrix。普通 Hub 内部变动只选 Hub，共享 schema、邮件或客户端真实导入则传播到消费者。测试引用单独标识，动态模块、Python 外部依赖与网络接口仍需相关接口检查。

CI [`product-checks.yml`](../../.github/workflows/product-checks.yml) 按真实 Git base 生成同一组件 matrix；首次 push 和手动全量选择所有组件。`additionalSourceCoupling` 报告目录外真实耦合，Native/A2A/Web/Official、Admin/Web/Mail 等拆仓前须先建立版本化导出、锁定依赖与兼容检查，目录整理不代表可独立发行。

## 按变化选择检查

完成一批实质改动再集中验证；表中是可选入口，同输入已有结果直接复用。

| 变化 | 入口 |
|---|---|
| JS/权限/恢复 | `npm test -- packages/galaxy-official/test/<相关文件>.test.mjs` |
| 工具/Core | `npm test -- scripts/test/<相关文件>.test.mjs` 或具体 Core 测试文件 |
| Web 打包/类型 | `npm run build:web` 或 `node node_modules/typescript/bin/tsc --noEmit` |
| 局部 lint | `node node_modules/oxlint/bin/oxlint <相关文件或目录>`；必要时 `npm run lint` |
| 官网 | `npm run build:site` |
| Admin | 在 `apps/galaxy-admin` 按需选择 `npm run types`、相关测试或 `npm run build` |

统一测试 CLI 接受明确 `.test.mjs`，也可在 `test:core`/`test:official`/`test:a2a` 后追加本包文件。未知参数、无效路径、缺专用环境直接失败，不回退全套。根与 Admin 测试复用 `tsx`，生产构建仍走各自工具链。

`npm test` 无路径覆盖普通 packages 与 scripts/test 范围；仓库级 test/ 集成用例及专用环境检查按相应入口显式选择。`npm run check` 再含根 lint，只在需要整体回归时选一次。`check:layers` 包含重叠和真实环境前提；需要单层用 `node scripts/verify-layers.mjs --layers=<所需层>`。`npm run check:requirements` 检查本仓库docs及相关链接，可用 `npm run check:requirements -- docs/technical/interfaces.md` 限定文件，不依赖上层项目manifest。`prepare:client` 用于正式客户端候选，不是普通编辑前提。

根 lint 涵盖 `app/`、`packages/`、`scripts/`、`lib/browser-demo.mjs`，Next 规则限早期 `app/`，未采用 React Compiler 专用规则。oxlint 不替代完整 tsc；DiceBear 生成文件的精确排除和来源见 [`THIRD_PARTY_AVATARS.md`](../../packages/galaxy-web/THIRD_PARTY_AVATARS.md)，调用代码仍检查。读取续期的独立 React/DOM 合成 QA 见 [`tools/qa/operations-read-renewal`](../../tools/qa/operations-read-renewal/README.md)，不证明真实后端或生产不中断。

代码和测试沿实际组件保存，依赖/锁跟随安装根；临时中间稿归 `outputs/<任务>/tmp/`，必须保留的原始失败及执行证据转维护记录后再清理可丢弃副本。真实身份、数据库、会话、密钥与私有日志留源码外。轻量文档整理不触发产品构建或全套测试。

## 故障定位与未验证范围

检查结果按实际层次记录：源码/配置生成、编译/封包、隔离替身、真实依赖读回、目标业务结果各自说明输入和观察。前一层成功不自动证明后一层；已有脚本、运行进程或健康探测也不能代替消费者采用和外部结果。下列组件表、宿主章节和运维正文只补各自具体覆盖条件，避免把未运行项纳入通过结论。

setup 版本拒绝先区分开发 24.13+ 与客户端 22.13+；官网首次失败检查 Python 和固定资源获取；静态页可看但业务不可用时查公开配置、API、Origin、Cookie/CSRF；管理登录查独立 realm、BFF 与当前角色。CI 在 lint 结束时，后续跳过项没有结果。

认证主题与Java Provider分别构建，两个Provider可用既有CI组合入口在明确JDK21/Keycloak26.7.3环境验证。真实PostgreSQL、Prosody、模型、Native制品、TLS和恢复各自按所需环境运行；未运行项按实际范围报告，不把编译、进程启动或替身测试写成外部服务验收。
