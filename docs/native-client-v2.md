# 银河共享原生客户端 v0.2

这是现有 v2 API 的独立 stdio 客户端。旧 local-only MCP 和旧 OpenCode 冻结发行保持原行为。当前包不依赖开发仓的绝对路径、不包含账号、密钥或已选云地址；它也不承诺八个真实宿主均完成验收。

需要 Node.js 22.13 或更新版本。发行归档解开后，在 package 目录使用随包锁文件执行 `npm ci --ignore-scripts`，再运行 `node galaxy.js`。源码首次构建候选尚无锁时才执行 npm install 形成锁，之后固定使用 ci。设置 `GALAXY_NATIVE_CONFIG` 为本机公开配置 JSON 的绝对路径。配置字段是 `version:2`、`endpoint`（精确 HTTPS API origin）、`website`（精确 HTTPS 官网 origin）、`dataDirectory`（本人本地绝对目录）、`trustedKeys`（kid 到 publicKeyPem/notBefore/notAfter/revoked 的映射）。不要在配置中加入令牌、恢复码或私钥。

运行 `node prepare-service-config.mjs <官网-origin> <API-origin> <本机数据目录绝对路径> <新的配置文件绝对路径>` 可读取已选官网的公开配置，核对端点和当前 Ed25519 公钥并生成本机配置。它不创建身份、数据目录或绑定，不跟随重定向，不覆盖旧文件，也不自动更换已保存信任。官网和 API 必须由用户既有选择或实际已核对的服务入口确定。

加载只读取本地状态，不创建身份或连接。新初始化保持已有模块选择和五阶段 `/galaxy` 规则。首次连接由用户选择，后续同一设备可在调用已允许工具时重连。会话令牌只在进程内存。原生设备密钥保存在本机用户目录的独立 PEM 文件，浏览器 IndexedDB CryptoKey 的不可导出特性不适用于此原生文件存储。初次升级旧身份沿用 Genesis 控制密钥，后续新设备通过公开批准协议加入；邮箱不能接管 GUID。恢复材料仍经官网私有输入界面处理。

任务、参与、逐收件人材料、聊天、发现、项目、联系人、招聘、Capsule、事实、通知、摘要、统一搜索、个人选择快照和任务评论工具重用服务端现有 MCP schemas，只将动作映射到现有 HTTP 入口。Capsule 保留精确版本、原操作回执和所选来源许可查询；评论与治理不代替任务交付或能力判定；选择快照的云同步须另行选定具体快照，不能套用摘要同步权限。HelpSession 复用既有帮助引擎，保留四条路径、来源依据、选项与原任务引用。服务端继续负责当前身份、Consent、权限、配额、版本和真实运行条件。查询、读取、已有精确 Consent 重试与当前 Agent 授权行为不重复要求新选择。

新权限范围优先使用 MCP elicitation；宿主缺少能力时返回临时本机审阅链接。它绑定 127.0.0.1 随机端口，显示固定操作与载荷，用户点击允许或拒绝后回到原宿主，重试相同操作。无需复制确认口令；关闭页面不批准。页面不接收任意目标、私钥或恢复材料，5 分钟过期，stdio 退出即销毁。它与官网房间不同，不产生第二套云服务。工具不接受模型填入的假确认字段。

`galaxy_open` 只把稳定对象种类和 ID 放入网址，原工作来源留在本机；输出“已请求打开”与实际页面已呈现分开。Task、Room、Capsule、Project 有独立详情路由。Capsule 可选 versionId 对应 `/app/capsules/:id/versions/:versionId`，返回时沿用该版本读取，不擅自改成最新版；也可打开 `/app/capsules` 列表。Project 对应 `/app/projects/:id`，返回重新读取同一项目。`galaxy_return` 刷新同一对象。房间关闭不是离开、取消或撤回。目标官网是否已发布这些页面仍以该服务实际部署记录为准。

个人摘要默认本地，不产生模型调用。私有同步和房间分享分别选择。持续关注需要当前连接的房间 Agent grant、限定目的与结束时间；使用 agent_grants/grant/revoke 查看与管理，再由用户宿主执行 check/ack/stop。绑定变化后停止旧关注，需重新选择当前连接授权；不会复制旧权限。并发检查使用本机锁和租约，待处理内容只保存定位信息，每次重新读取来源权限。当前实现不安装后台服务，不会在宿主退出后代替用户运行模型。检查没有新事件时模型调用为零；有事件只返回供用户模型处理的数据。Agent 处理游标与人类已读分开。宿主实际子会话启动、睡眠恢复、按钮或侧栏能力需分别验证。

安装 Skill 时将 `skills/galaxy` 放到对应宿主认可的 Skill 路径。MCP 配置的 command 指向该机 Node 可执行文件，args 为独立候选中的 `galaxy.js`，env 只含 `GALAXY_NATIVE_CONFIG` 路径。不要同时启用同名旧 Galaxy MCP。切换版本保留原数据目录并关闭旧进程，不重跑初始化。

本包附 `host-configs.mjs`：运行 `node host-configs.mjs <公开配置绝对路径> <尚不存在的输出目录绝对路径>` 生成八端配置与 Skill；只生成新目录，不修改用户配置。参见 HOSTS.md 和 host-capabilities.json。复制到另一台电脑需用该机路径重新生成，恢复身份使用批准流程而非把账号密钥塞入插件。

开发追溯：M15/M16/M17；CUR-02/03、08/09、12、23—32；B10-Q02—04、DISC-ROOT、DISC-HANDOFF 与关注采用决定。操作与验证的实际范围记录在项目 `07-logs/development/native-client-v2.md`，本 README 不是上线证明。

分发采用独立的 galaxy-native-client-release 签名种类。protocolAcceptance 范围是 local-stdio-http-fixtures，actualHostAcceptance 固定 false；它与旧 OpenCode 真宿主报告互不替代。标准 JWS/Ed25519 绑定发行包与报告的准确字节，公钥由调用者固定，签名最长 30 天。验签通过不表示已经安装、公开发布、运行或完成人工验收。

## 可选 A2A 对端

当前源码新增可选 `a2a: { peers: [...] }`；未配置时不注册 A2A 工具，也不发现或联系对端。每个 peer 使用 `id`、可选 `name`、精确 `endpoint`、可选 `tenant`、`peerPrincipal`、已审阅公开 `agentCard`、`cardHash` 和 `trustExpiresAt`（毫秒）。卡片摘要是 SHA256(JSON.stringify(agentCard))，选择卡片时保存原 JSON 字段顺序。只接受卡片列出的 A2A 1.0 JSONRPC 精确接口；不自动刷新卡片、延长期限或切换接口。

peer 还可携带公开的 `authentication` 选择：默认 `{"mode":"none"}` 适用于无凭据对端；Bearer 对端使用 `{"mode":"bearer-environment","variable":"GALAXY_A2A_PEER_<所选名称>_TOKEN"}`。只给该 MCP 子进程注入所选变量；配置、插件、日志与聊天均不放原始值，不永久导出全局环境。启动与 peers 工具不读取变量，实际调用才读取该精确变量；缺失时报告对端授权不可用，不降级成匿名、不借用 Official token。若宿主不能注入所选变量，先使用已有浏览器衔接或处理该宿主配置，不改变协议信任。OAuth、任意请求头和自动凭据发现尚不支持。

配置后额外注册 peers、read、prepare、execute、abort_local 五个工具。prepare 返回待审预览，execute 复用既有 MCP elicitation／本机审阅页；它不接受模型传入 confirmed。对端状态和来源单列为 peer-reported，导入 Result 不等于原问题解决。具体生命周期与 Python 互通证据见源码仓 `packages/galaxy-a2a/docs/native-v2-python.md`；已经签名发布的旧132工具包不会被源码变化自动更新，新包须独立捕获和发行。
