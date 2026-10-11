# 银河共享原生客户端（v2 协议）

2026-10-09 本地体验重构：当前源码的 MCP Apps 小面板已按当前工作组织，展示可用帮助、消息和必要动作；原始来源、载荷 JSON 与操作回执不再作为日常界面。工具文本返回可读的当前内容，精确引用继续保留于 structuredContent。未发送笔记和回复只存在本机及组件 metadata。房间消息自动分页读取，直接回复只使用同一连接已有有效 respond 授权；缺授权时打开同一完整会话，不自动申请新范围。发送未知结果自动查询原消息，网页返回后按窗口焦点接续原导航并保留输入。

本次本地构建、签名 HTTP 与 Official App/AppBridge 检查分别提供有限证据。聊天传输及账号资格使用显式合成夹具；真实 AI 宿主、真实 Prosody 投递和真人效果仍未验证。这些源码变化没有更新冻结发行、宿主安装或发布指针。

这是现有 v2 API 的独立 stdio 客户端。旧 local-only MCP 和旧 OpenCode 冻结发行保持原行为。当前包不依赖开发仓的绝对路径、不包含账号、密钥或已选云地址；它也不承诺八个真实宿主均完成验收。

需要 Node.js 22.13 或更新版本。发行归档解开后，在 package 目录使用随包锁文件执行 `npm ci --ignore-scripts`，再运行 `node galaxy.js`。源码首次构建候选尚无锁时才执行 npm install 形成锁，之后固定使用 ci。设置 `GALAXY_NATIVE_CONFIG` 为本机公开配置 JSON 的绝对路径。配置字段是 `version:2`、`endpoint`（精确 HTTPS API origin）、`website`（精确 HTTPS 官网 origin）、`dataDirectory`（本人本地绝对目录）、`trustedKeys`（kid 到 publicKeyPem/notBefore/notAfter/revoked 的映射）。不要在配置中加入令牌、恢复码或私钥。

运行 `node prepare-service-config.mjs <官网-origin> <API-origin> <本机数据目录绝对路径> <新的配置文件绝对路径>` 可读取已选官网的公开配置，核对端点和当前 Ed25519 公钥并生成本机配置。它不创建身份、数据目录或绑定，不跟随重定向，不覆盖旧文件，也不自动更换已保存信任。官网和 API 必须由用户既有选择或实际已核对的服务入口确定。

加载只读取本地状态，不创建身份或连接。初始化按当前本机配置步骤进行；已经有身份时直接读取并保留原GUID，不为了进入官网重复初始化。首次连接由用户选择，后续同一设备可在调用已允许工具时重连。会话令牌只在进程内存。原生设备密钥保存在本机用户目录的独立 PEM 文件，浏览器 IndexedDB CryptoKey 的不可导出特性不适用于此原生文件存储。初次升级旧身份沿用 Genesis 控制密钥，后续新设备通过公开批准协议加入；邮箱不能接管 GUID。恢复材料仍经官网私有输入界面处理。

任务、参与、逐收件人材料、聊天、发现、项目、联系人、招聘、Capsule、事实、通知、摘要、统一搜索、个人选择快照和任务评论工具重用服务端现有 MCP schemas，只将动作映射到现有 HTTP 入口。Capsule 保留精确版本、原操作回执和所选来源许可查询；评论与治理不代替任务交付或能力判定；选择快照的云同步须另行选定具体快照，不能套用摘要同步权限。HelpSession 复用既有帮助引擎，保留四条路径、来源依据、选项与原任务引用。服务端继续负责当前身份、Consent、权限、配额、版本和真实运行条件。查询、读取、已有精确 Consent 重试与当前 Agent 授权行为不重复要求新选择。

新权限范围优先使用 MCP elicitation；宿主缺少能力时返回临时本机审阅链接。它绑定 127.0.0.1 随机端口，显示本次实际内容、用途、接收方和范围，用户点击允许或取消后回到原宿主。原操作与准确字节仍绑定原选择；MCP Agent 沿同一参数继续，当前 Worker 小面板在焦点返回时自动继续同一操作。无需复制确认口令；关闭页面不批准。无名称的身份和所选设备在明确详情中核对，完整原始输入通过来源与诊断下载。页面不接收任意目标、私钥或恢复材料，5 分钟过期，stdio 退出即销毁。它与官网房间不同，不产生第二套云服务。工具不接受模型填入的假确认字段。

`galaxy_open` 只把稳定对象种类和 ID 放入网址，原工作来源留在本机；输出“已请求打开”与实际页面已呈现分开。Task、Room、Capsule、Project 有独立详情路由。Capsule 可选 versionId 对应 `/app/capsules/:id/versions/:versionId`，返回时沿用该版本读取，不擅自改成最新版；也可打开 `/app/capsules` 列表。Project 对应 `/app/projects/:id`，返回重新读取同一项目。`galaxy_return` 刷新同一对象。房间关闭不是离开、取消或撤回。目标官网是否已发布这些页面仍以该服务实际部署记录为准。

返回记录绑定创建时的本机身份、所选 API 和官网。同一身份明确重新连接后，可以沿用原记录；切换身份、服务或官网时不能拿到另一范围的原工作引用。旧发行留下的无归属记录会保留，但不能推断其属于当前身份；从当前身份重新打开准确对象即可建立新的返回记录。创建身份或连接变化期间迟到的旧请求也不能继续展示原范围数据。

原对象目前不可读或服务暂时不可用时，返回结果保留原对象定位和原工作引用，明确标记 `current:false`、`data:null` 与来源错误，不重放缓存正文、不自动授权或重新提交业务。认证或会话本身失效仍按原错误处理。宿主可以据此回到原工作、说明当前缺口，并在条件恢复后再次查询同一对象；历史回执不授予当前正文访问权。HelpSession 刷新或返回遇到发布、参与接受结果未知时，先查询原 operationId 与原载荷摘要，确认后再读取当前任务，不通过另建任务或另一次接受猜测结果。

个人摘要默认本地，不产生模型调用。私有同步和房间分享分别选择。持续关注需要当前连接的房间 Agent grant、限定目的与结束时间；使用 agent_grants/grant/revoke 查看与管理，再由用户宿主执行 check/ack/stop。绑定变化后停止旧关注，需重新选择当前连接授权；不会复制旧权限。并发检查使用本机锁和租约，待处理内容只保存定位信息，每次重新读取来源权限。当前实现不安装后台服务，不会在宿主退出后代替用户运行模型。检查没有新事件时模型调用为零；有事件只返回供用户模型处理的数据。Agent 处理游标与人类已读分开。宿主实际子会话启动、睡眠恢复、按钮或侧栏能力需分别验证。

安装 Skill 时将 `skills/galaxy` 放到对应宿主认可的 Skill 路径。MCP 配置的 command 指向该机 Node 可执行文件，args 为独立候选中的 `galaxy.js`，env 只含 `GALAXY_NATIVE_CONFIG` 路径。不要同时启用同名旧 Galaxy MCP。切换版本保留原数据目录并关闭旧进程，不重跑初始化。

本包附 `host-configs.mjs`：运行 `node host-configs.mjs <公开配置绝对路径> <尚不存在的输出目录绝对路径>` 生成八端配置与 Skill；只生成新目录，不修改用户配置。参见 HOSTS.md 和 host-capabilities.json。复制到另一台电脑需用该机路径重新生成，恢复身份使用批准流程而非把账号密钥塞入插件。

开发追溯：M15/M16/M17；CUR-02/03、08/09、12、23—32；B10-Q02—04、DISC-ROOT、DISC-HANDOFF 与关注采用决定。操作与验证的实际范围记录在项目 `07-logs/development/native-client-v2.md`，本 README 不是上线证明。

分发采用独立的 galaxy-native-client-release 签名种类。protocolAcceptance 范围是 local-stdio-http-fixtures，actualHostAcceptance 固定 false；它与旧 OpenCode 真宿主报告互不替代。标准 JWS/Ed25519 绑定发行包与报告的准确字节，公钥由调用者固定，签名最长 30 天。验签通过不表示已经安装、公开发布、运行或完成人工验收。

## 可选 A2A 对端

当前源码新增可选 `a2a: { peers: [...] }`；未配置时不注册 A2A 工具，也不发现或联系对端。每个 peer 使用 `id`、可选 `name`、精确 `endpoint`、可选 `tenant`、`peerPrincipal`、已审阅公开 `agentCard`、`cardHash` 和 `trustExpiresAt`（毫秒）。卡片摘要是 SHA256(JSON.stringify(agentCard))，选择卡片时保存原 JSON 字段顺序。只接受卡片列出的 A2A 1.0 JSONRPC 精确接口；不自动刷新卡片、延长期限或切换接口。

peer 还可携带公开的 `authentication` 选择：默认 `{"mode":"none"}` 适用于无凭据对端；Bearer 对端使用 `{"mode":"bearer-environment","variable":"GALAXY_A2A_PEER_<所选名称>_TOKEN"}`。只给该 MCP 子进程注入所选变量；配置、插件、日志与聊天均不放原始值，不永久导出全局环境。启动与 peers 工具不读取变量，实际调用才读取该精确变量；缺失时报告对端授权不可用，不降级成匿名、不借用 Official token。若宿主不能注入所选变量，先使用已有浏览器衔接或处理该宿主配置，不改变协议信任。OAuth、任意请求头和自动凭据发现尚不支持。

配置后额外注册 peers、read、prepare、execute、abort_local 等当前协议工具，准确列表以实际工具发现为准。prepare 返回待审预览，execute 复用既有 MCP elicitation／本机审阅页；它不接受模型传入 confirmed。对端状态和来源单列为 peer-reported，导入 Result 不等于原问题解决。具体生命周期与 Python 互通证据见源码仓 `packages/galaxy-a2a/docs/native-v2-python.md`；源码变化不会自动更新已经签名发布的包，新包须独立捕获、验证和发行。

## 设备清单与明确撤销

### 已有Agent身份接官网（当前开发候选）

本次新增 `galaxy_identity_web_connect` 与 `galaxy_identity_web_connect_status`，最终固定包与实际验证范围以其发行记录为准。先用status读取当前Native已有身份，按真实工具schema传入原对象、可选原工作来源和固定requestId；准备连接不会另建GUID。工具打开受控的临时本机页面，再由用户进入配置中的固定官网。官网生成自己的设备钥；原Native设备只有在本机页明确核对同一GUID、所示设备和范围并批准后才签署授权。模型不能填写确认布尔值代替这次选择。

本机页与官网通过精确窗口和来源交换限定用途的公开证明、设备申请、批准与回执，私钥、恢复码及令牌不跨窗口。URL只携带必要公开定位；原宿主和workRef留在Native本机。新握手有效期为180秒，与原有5分钟普通操作审阅页不同；过期、关闭、弹窗被阻止或窗口引用丢失都不表示已经批准或连接。

已有官网设备在本次持钥证明绑定的同一GUID、deviceId与keyId下可以复用。后续正常刷新沿持久身份读取当前设备控制，不把180秒握手当永久权限，也不要求每次重新初始化。设备当前有效不保证旧任务根Consent继续有效；原Task保留定位，正文无权时返回明确不可用，不重放缓存。

结果未知时保留原requestId、handoffId及已有设备操作journal，用status和原设备reconcile核对；已有未决授权操作不能走复用设备捷径或改ID重建。status中的网页连接报告不等于Native独立观察到了网页会话，工具保持两者的区别。确认页关闭不撤销已经接受的业务事实。

完成网页工作后，使用同一navigationId调用 `galaxy_return` 刷新原对象并接回原工作。当前模型负责向用户说明实际取得的帮助、仍未解决部分和当前来源限制；网页返回、方法引用或设备接续本身都不生成成功履历。

`galaxy_identity_device_native_read` 的 `current`／`list` 返回本机身份在所选服务的当前设备控制，`pending` 读取本机待处理操作，`reconcile` 配合原 `operationId` 核对原回执。读取不会签名、重连或恢复私有资料；本机已有身份时，普通连接断开后仍可核对公共控制状态。

使用 `galaxy_identity_device_native_prepare_revoke` 选择当前清单中的准确 `deviceId`。返回的 `previewId` 仅指向本进程保存的原预览，预览列出目标设备、公钥标识、控制版本、控制链、原请求和挑战摘要、期限及后果。prepare 会登记未签署的挑战，尚未撤销设备。`galaxy_identity_device_native_confirm` 接受这个 `previewId`，再经过真实宿主选择或本机审阅页；模型不能填写确认布尔值替代本人选择。

撤销成功后，所选服务拒绝目标设备的原连接和凭据，GUID 与历史证明保持。它不删除数据、不消耗恢复码，也不声称其他服务同步撤销。最后一个管理设备只有在服务已登记恢复依据时才允许明确自撤；“已登记”不能证明本人仍安全持有恢复码。

连接、控制版本或预览期限改变后重新核对。提交结果未知时保留原 operation、挑战及证明，只查询原状态；不要生成另一份撤销来猜测结果。`galaxy_identity_device_native_stop_retry` 经真实选择仅停止本机继续提交，已签署未知操作仍保留定位，不能称为服务取消。终态历史回执不授予当前访问权。官网“身份与设置”提供同义清单、预览、原回执与本机停止入口。

## 已选 Worker Pack 的原生使用

可选配置 `workerPacks: { workers: [...] }` 把已选择的 Pack 固定版本关联到已有 `a2a.peers`，不安装或启动任意程序。每个 worker 使用以下公开字段：

| 字段 | 含义 |
|---|---|
| `id` | 本机唯一名称，1—80 个字母、数字、下划线或连字符 |
| `peerId` | 当前配置中已经核对的 A2A peer ID |
| `pack.builderId` / `pack.manifestId` / `pack.manifestHash` | 真实可读的 Builder、精确 Manifest 及其 SHA-256 |
| `sourceHash` / `version` | 所选 Pack 内容摘要与版本，执行前再核对 |

未配置时不注册 Worker 工具；每个 Worker 必须有对应的显式 A2A peer。配置最多 32 项，不接收 shell command、下载地址或模型传入的程序路径。工具发现不创建身份、连接、执行进程或模型。连接后的本人首次操作才打开按身份隔离的本机记录。

四个工具为 `galaxy_worker_host_read`、`galaxy_worker_host_prepare`、`galaxy_worker_host_execute`、`galaxy_worker_host_abort_local`。开始使用需本人当前可读的精确 Attempt、Configuration、用途和必要文本。prepare 返回完整预览及本进程句柄，execute 经既有真实选择执行；支持 MCP Apps 的宿主复用同一紧凑资源，不支持的宿主保留可读普通 MCP 预览与同一本机选择页。

当前 Worker 小面板先显示工作目的、必要输入、处理位置与范围，返回后先显示对端实际输出，再提供可选的结果保留。可识别的结构化内容显示可读字段并提供完整原始内容下载；精确关联、版本与原操作保留在来源与诊断。已知的对端 Task 在面板可见时自动读取进度，已有 Result/PackUse 未确认时自动查原回执；这些读取不会批准、再次派发或自动记录成功。离开页面仍可带当前引用回到原工作。

本地 Chromium 与 SDK App/AppBridge 已运行真实 Node 参考 Worker、签名 HTTP 和 PGlite；Native 租约与宿主本地选择存储是显式合同夹具。实际计算、未知初次发送不重发、既有 Task 自动读取、本地取消与真实远端取消分别有检查。它们不证明实体 AI 宿主或独立运营 Worker 的使用效果。

对端完成、导入 participant-reported Result、记录独立 PackUse 是三个不同事实。后两者各有自己的准确预览、披露选择和回执；对端完成不会自动解决原任务、形成 Verification 或成功履历。丢失回执时查询原关联和原操作，不能重复发送。`abort_local` 只结束本地等待或预览，远端取消需另行准备并确认 CancelTask。仓库中的 reference-worker-pack 是隔离示例，不是已被独立运营者采用的生产 Worker。

## 本机系统提醒

提醒默认关闭，重启后需要再次明确启用。`galaxy_host_notifications_status` 不启动辅助进程、定时器或模型；`enable` 经过现有真实选择后，每60秒检查当前收件箱，`check` 可在已启用时手工核对，`disable` 停止检查并撤回仍由本进程持有的提醒。退出及断开连接也执行清理。通知展示、人类已读和 Agent 处理游标分别记录。

可选公开配置为 `hostNotifications: { kind: "linux-freedesktop", command: "/usr/bin/python3" }`；`kind` 只接受 `linux-freedesktop`、`windows-notify-icon` 或 `macos-user-notifications`，`command` 如提供必须为本机绝对路径。此配置不接受 `enabled`、任意参数、脚本文本或通知正文；MCP 工具也不接受这些字段。省略配置时 Linux、macOS 分别选择对应通道，其余系统选择 Windows 通道；缺少所需辅助程序或系统能力时保留前台收件箱。配置本身不会启用提醒。

Windows 使用固定 NotifyIcon 辅助程序，只有收到 `BalloonTipShown` 才记录客户端观察到的展示。Linux 使用已安装的 Python3、PyGObject/GIO 和当前同一用户的本地 Unix D-Bus；缺依赖或通知服务时保留前台入口，不自动安装、启动 session bus 或切换远端总线。固定辅助进程只收到模式和条目数量，不接收私有标题、正文、网址、收件人或业务对象ID。

Linux 的 `Notify` 返回只表示系统接收了请求，输出始终保留 `displayed:false`，不会写成已展示或人类已读。原短生命周期连接固定通知服务的唯一名称和原通知ID；来源撤回、静音、禁用或退出时只请求关闭原提醒，不重连寻找另一条通知。系统实际撤回仍与辅助进程已关闭分开。未知展示保留原尝试记录，重启后不会再发送同一事件来猜测结果。

当前 Windows 环境的 Linux 自动检查使用真实受控 Node 子进程代替 Python/GIO，核验固定命令合同、管道、取消、退出及原ID撤回；它不是物理 Linux 桌面验收。实际宿主显示、焦点与用户体验仍需在对应设备核验。

macOS 通道当前为源码和协议验证阶段，未提供已编译、签名或公证的辅助程序。默认不启动任何 helper。受信本机配置的 `command` 必须指向绝对路径 `.../GalaxyNotifications.app/Contents/MacOS/GalaxyNotifications`；不会改用 AppleScript 或任意命令。开发者在已有 macOS SDK 的机器上可运行源码目录 `notifications/macos-helper/build.mjs`，传入尚不存在的绝对输出目录。该构建仅生成新目录，不签名、公证、安装、启动或改变系统安全设置；本轮 Windows 测试没有编译 Swift，也没有验证真实 Notification Center。

`galaxy_host_notifications_permission` 使用一次独立的真实宿主选择，仅在 macOS 权限尚未决定时请求系统 alert 权限。已拒绝时只返回当前状态；普通 `status`、`enable` 和自动检查不会触发权限弹窗。此动作不启用或停用已有提醒、不读取业务收件箱、不展示通知、不写人类已读。每次调用重新审阅，审批记录不作为后续调用的授权缓存；浏览器批准在等待本机记录写完之前即被消费，原链接不能再次授权。身份或连接变化时不沿用旧选择；禁用和退出会关闭本次拥有的 helper。

macOS `UNUserNotificationCenter.add` 成功仅表示系统受理，仍返回未知展示及 `displayed:false`。撤回仅请求移除同一辅助进程原 UUID 的 pending/delivered 通知；“请求已发出”和“随后观察到列表中不存在”分别返回，不宣称用户看见、已读或永久删除。真正的系统授权、显示及发行适用性仍需 macOS 环境验证。

## AI Agent 部署与核验

部署代理先核对用户所选官网、API origin 和当前发布公钥，再使用随包 `prepare-service-config.mjs` 写新的公开配置。版本从包内 `package.json` 与 `native-v2.json.releaseId` 读取；“v2”指协议，不能当作发行版本。保留原数据目录、旧可用包和已保存信任，依随包锁文件安装依赖。签名和文件摘要必须用已明确固定的发行公钥核验，不从归档内容自行推导信任。

逐项记录安装、stdio 握手、工具发现、实际选择、业务回执和宿主 UI 的结果。先读 `galaxy_native_status`，再由本人选择连接；工具出现不能当作业务执行成功。Worker 工具缺失时核对 `workerPacks` 与同名 `a2a.peers`，不要自动补一个对端。设备预览失效时查询原记录，不能把重绑后旧句柄重新当成授权。

本机审阅页只接受准确的 loopback Host 与 Origin。实际浏览器表单使用同源 referrer 策略；Origin 为 `null` 或来自另一来源时仍拒绝，不能为绕开 403 放宽校验。退出时停止接收新调用、使设备预览失效、等待在途回执和本机保存完成，随后关闭协议；未知操作保留在原 journal。测试替身、参考子进程、真实浏览器、物理宿主及真人验收须分别说明，自动测试结果不填补真实验收缺口。
