# 组件目录与局部构建

`repository-components.json` 是构建输入目录。`scripts/components.mjs`、GitHub Actions、Hub 服务打包和源码归档直接读取它。现有 Node/Python 工具链和锁文件继续使用；目录不引入微服务拆分、npm workspace 或长期模块分支。

## 本地开始

需要 Node.js 24.13+、npm、Python 3.12。取得有权访问的源码后在仓库根目录运行 `npm run setup`；它按既有锁文件安装根、Official、A2A、compact-app 的开发依赖。管理端另运行 `npm ci --ignore-scripts --no-audit --no-fund --prefix apps/galaxy-admin`。AgentOS 在独立虚拟环境按 `services/galaxy-operations-agentos/requirements.lock` 安装。Gateway 的 Dockerfile 使用 `SOURCE.json` 指定的上游及其锁文件，不替换成浮动 PyPI 版本。

```sh
npm run components -- list
npm run build:component -- --component web --output outputs/review-web
npm run build:component -- --component hub --output outputs/review-hub
npm run check:component -- --component hub --output outputs/check-hub
node scripts/components.mjs plan --base <已核对的Git提交> --output outputs/component-plan.json
node scripts/components.mjs imports --output outputs/component-imports.json
python scripts/create-release-baseline.py
```

输出目录使用新目录。Web 命令实际运行 Vite；Hub 命令生成包含 API、worker、migration、publisher 四入口和完整迁移清单的独立服务源码包。两者可以分别运行。`site` 会先构建 Web，再调用现有网站生成器；网站发行目录、静态公开资产和发行数据按既有生成器合同提供。网站生成器默认从其固定公开来源取得历史下载；使用 `--offline` 时需已有缓存，或通过 `--preserved-public-source` 指定准确旧公开发行目录。源码归档保留目录和构建输入，历史二进制下载须按原目录另行取得，不能把缺失下载替换为空文件。`auth` 生成 Keycloak 主题；Java 邮件验证码 provider 使用其自己的构建器并按 `--provider-jar` 合入，不能用主题构建替代 Java 编译。`agentos`、`model-gateway` 的 catalog build 只编译 Python 代码对象，不导入服务、创建缓存或连接数据库，不能据此声称 Docker 或持久化运行通过。

## 当前组件

| 组件 | 源位置 | 构建或封包 | 运行关系 |
| --- | --- | --- | --- |
| contracts | Official `src/shared`、browser-client、运营权限目录 | 源共享合同，随使用方打包 | 由 Hub/Web/Admin/客户端直接导入 |
| core | `packages/galaxy-core` | 无独立运行进程 | 本地主体、签名、数据与身份控制 |
| mail | `packages/galaxy-mail` | 各发信方直接消费同源布局 | Hub、Admin、Keycloak 主题复用 |
| hub | `packages/galaxy-official` | `service-release capture` | API、worker、迁移、publisher 同一版本服务族，共用业务库 |
| native-client | Node、edge-mcp、native-v2、host-adapters | 既有原生客户端 builder | 本机或宿主环境，正常身份与 Worker 隔离 |
| a2a | `packages/galaxy-a2a` | 既有协议工具链 | 与 Native、Core 仍有源码引用 |
| web | `packages/galaxy-web`、共用 UI | Vite | 直接浏览与嵌入宿主分别组织 |
| site | `apps/galaxy-site`、public | Python 网站生成器＋Web 产物 | 静态站点，发行与 CMS 发布元数据分别保持 |
| auth | `apps/galaxy-auth` | 共用 UI 主题＋Java provider | Keycloak 普通用户与管理身份域分别配置 |
| admin | `apps/galaxy-admin` | Next.js | Payload/CMS 与 Node BFF，独立管理会话 |
| agentos | `services/galaxy-operations-agentos` | 锁定 Python/Agno Dockerfile | 独立 Native 服务；Node 保持业务权威 |
| model-gateway | `services/galaxy-model-gateway` | 固定上游源码 Dockerfile | 私有模型协议网关，配置由人管理 |
| discovery | `services/galaxy-discovery` | 适配器及固定开源补丁各自构建 | Gorse/OpenPanel/搜索按已有接入运行 |

影响分析同时读组件依赖和实际相对 import。它保留文件级反向引用：普通 Hub 内部文件改动只选择 Hub；共享邮件、公共 schema 或真实被客户端导入的模块改动会选择相应使用方。测试引用在报告中标成 `test`，不被当成运行源码依赖。动态 import、Python 外部依赖、环境选择的渲染器和网络接口不会仅靠静态扫描证明兼容，应按接口表补相应检查。

## CI 与拆仓准备

CI 先按真实 Git base 计算 matrix，再调用相同的 `check`/`build`。首次 push 和手动全量运行选择 catalog 全部组件。共享合同的 Task 材料权限回归、Web 类型检查及 Native bridge 原检查继续保留。数据库持久化和真实发布失败恢复使用专用隔离环境，不能借 CI 缺凭据改用运行库。

`imports` 产生的 `additionalSourceCoupling` 记录当前仍在组件目录外的源码引用，例如 Native 的 A2A/Web 工具与 Official 客户端模块、Admin 的 Web 头像和共用邮件。这些是真实耦合。远端拆仓前需要先给相应模块建立版本化导出、锁定依赖及兼容测试，保留原提交、许可与来源；当前目录安排不宣称已经可以逐仓独立发布。远端创建、默认分支、保护规则、仓库公开性和正式 push 由维护者另行决定。
