# 开发与本地运行

[文档目录](README.md) · [架构](architecture.md) · [部署](deployment.md) · [检查](development-checks.md)

## 取得源码

默认分支为 `main`。当前仓库为私有仓库，Git 克隆、源码 ZIP 和 Issues 需要对应访问权限。认证使用自己的 GitHub 凭据管理器或既有 HTTPS / SSH 机制，不把令牌写入克隆 URL。

```sh
git clone https://github.com/agigalaxy-team/agigalaxy.git
cd agigalaxy
```

[main 源码 ZIP](https://github.com/agigalaxy-team/agigalaxy/archive/refs/heads/main.zip)用于阅读和开发；AI 宿主中的客户端安装使用[官网下载](downloads.md)，二者分别发行。

实际开发或复现时选定明确提交。远端默认 main、本地审阅候选和已部署源可能处于不同提交；未推送的本地成果应从其审阅工作区或源码归档取得，不能用远端 main 代替。组件、依赖、配置入口和局部命令见[组件目录](component-catalog.md)。

## 环境与依赖

| 范围 | 要求 |
|---|---|
| 完整仓库开发、API、A2A、管理端 | Node.js 24.13+，使用对应 package-lock.json |
| 官网构建 | Python 3.11+；根构建脚本发现本机 Python |
| AgentOS/Gateway 服务工具链 | Python 3.12；AgentOS 使用独立虚拟环境及 requirements.lock，Gateway 使用固定上游源码/锁文件 |
| 已发行 Native 客户端 | 随包要求为 Node.js 22.13+，不要与完整开发门槛混淆 |
| 业务运行 | PostgreSQL、准确服务配置与信任材料；按功能增加认证、聊天、对象存储和扫描器 |
| 浏览器观察 | 使用任务隔离的无头浏览器与合成资料，避免复用个人浏览器状态 |

只安装本次组件需要的锁定依赖。根目录 `npm run setup` 是批量入口，会顺序安装根、`packages/galaxy-official`、`packages/galaxy-a2a` 和 `integrations/native-v2/compact-app`；只做网页时不需要这四次安装。它不安装独立管理应用，也不启动服务器或创建数据库。

## 仓库组织与文档归属

按真实职责沿已有组件放置，下面是通常归属；平台或构建有不同需要时就近说明。目录约定不限制合理重构。

| 内容 | 通常放在哪里 |
|---|---|
| 可运行应用、共享包、独立服务、宿主适配 | `apps/`、`packages/`、`services/`、`integrations/` 的现有组件；领域实现跟随真正的运行与数据所有者 |
| 测试、夹具与示例 | 组件现有 `test/` 或 `tests/`、`examples/`；夹具只含可分发的合成内容，专用测试数据库与运行库隔离 |
| 构建、开发和部署工具 | `scripts/`、实际组件的 `deploy/` 或根 `deploy/`；可复用入口进入仓库，一次性主机执行及原始结果留维护证据区 |
| 依赖与锁文件 | 跟随实际安装根；共享依赖先按真实消费者复用，不为整理目录随意合锁、换包管理器或升级 |
| 组件说明与跨组件文档 | 组件 README 讲自己的入口、配置与构建；`docs/` 按阅读目的维护总览、开发、运行和公共合同，一个主题保留一个主要正文并引用它 |
| 构建输出、下载缓存和运行资料 | 使用原工具的独立输出目录及 Git 忽略规则；身份、数据库、真实凭据、会话和私有日志放源码外，不把输出当第二份可编辑源码 |

临时草稿、一次性分析中间稿与可再生成副本统一放在 `outputs/<任务>/tmp/`。任务结束后先采用有用结论、把必须保存的原始结果和失败证据转入所选维护证据区，再清理确认可丢弃的材料；不能只凭名称删除历史、用户决定或未知改动，也不把真实凭据放临时文档。

新增说明先扩充已有主题；只有不同读者、维护周期或独立合同确有需要才拆文件。版本化用户指南、历史记录和现行正文分别保留；现状从[项目状态](project-status.md)进入。更改路径时同步受影响的导入、构建和文档引用，避免多个入口重复易过期的现状。

## 官网与网页工作区

网页日常开发只需根依赖和 Vite：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run dev
```

打开 **http://127.0.0.1:5179/app/**；依赖已安装且锁文件未变时直接运行 dev。未构建的官网静态页不影响这个网页开发入口，不必先运行产品 build 或检查命令。

| 需要的结果 | 命令 |
|---|---|
| 仅生成 Web | `npm run build:web` |
| 仅生成官网 | `npm run build:site` |
| 官网与 Web 完整预览 | `npm run build` 后 `npm start`，打开 **http://127.0.0.1:5179/** |

这些构建入口不附带全套业务检查。统一构建输出 `packages/galaxy-web/dist` 与 `apps/galaxy-site/dist`；首次官网构建会获取固定公开历史文档和下载文件，并使用 Git 忽略的缓存。已有缓存可用官网构建参数 `--offline`；全新克隆需要首次获取。

统一构建入口是 [build-product.mjs](../scripts/build-product.mjs)，预览与公开配置入口是 [serve-product.mjs](../scripts/serve-product.mjs)。预览只监听本机，默认端口可由 `GALAXY_PREVIEW_PORT` 选择；Vite 开发端口由其配置决定。根 `app/` 与 `dev:demo`、`build:demo` 属于早期演示。

## 连接实际 API

前端预览不启动完整 Hub。需要业务数据时，让预览进程的 `GALAXY_WEB_CONFIG_FILE` 指向所选服务的公开 JSON 配置。字段以 [publicConfiguration()](../scripts/serve-product.mjs) 为准，至少包含：

| 字段 | 含义 |
|---|---|
| `version` | 当前为 1 |
| `endpoint` | 所选 API 地址，不含用户名或口令 |
| `signingKeys` | 获准公钥、kid、有效期与撤销状态 |
| `operator` | 可选的服务运营方说明 |

公开配置只放公钥和服务元数据。API 的 browser policy 还必须允许准确的预览 Origin；允许读取静态文件不等于允许账户 Cookie、CSRF 或客户端签名操作。不要将生产私钥或数据库配置塞进 Web JSON。

Windows PowerShell 示例：

```powershell
$env:GALAXY_WEB_CONFIG_FILE = 'C:/absolute/path/to/public-web-config.json'
npm start
```

macOS / Linux 示例：

```sh
GALAXY_WEB_CONFIG_FILE=/absolute/path/to/public-web-config.json npm start
```

这里只设置预览进程读取的公开配置路径，不提供通用可用的生产账户或数据库。服务端配置见[部署指南](deployment.md)。

## 管理应用与认证

[运营后台](../apps/galaxy-admin/README.md)有独立 package-lock.json、CMS 数据库、环境与构建步骤。根 setup 和产品 build 不安装或构建它；组件 CI 根据影响范围单独选择 Admin，并按它自己的锁文件安装和构建。CI 构建不能替代真实管理认证、CMS 与业务 BFF 的操作验证。

[认证应用](../apps/galaxy-auth/README.md)包含 Keycloak 主题、验证码 Provider 和 realm 配置工具。构建主题不会修改目标 realm，也不会部署认证服务；完整邮件扩展还需要 Java 构建与匹配的 Keycloak 版本。

## 常见问题

| 表现 | 先检查什么 |
|---|---|
| setup 拒绝 Node 版本 | 完整仓库需要 24.13+；客户端 22.13+ 不适用于根 setup |
| 官网构建首次失败 | Python、网络与固定公开资源的获取；不要把旧 dist 当新构建 |
| 静态页可看，业务页不可用 | Web 公开配置、API 可达性、browser Origin、Cookie / CSRF 和当前权限 |
| 文档可以打开，搜索或增强页面失败 | 实际 CSP 的 form-action、script-src、connect-src 及相应 API |
| 管理端不能登录 | 独立管理 realm、受控 BFF origin 与实际角色；普通账户 Cookie 不等于管理权限 |
| 本地工作没有自动采集 | 实际宿主事件能力、所选配置和资料目录；其他宿主不能套用 OpenCode 覆盖 |
| CI 在 lint 阶段结束 | 阅读第一处失败和完整诊断；后续跳过的构建与测试没有结果 |

完成相关改动后集中运行必要检查，命令和范围见[开发检查](development-checks.md)。
