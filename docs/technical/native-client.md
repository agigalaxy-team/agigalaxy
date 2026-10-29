# Native 客户端与宿主工程

共享 Native 是用户机器上的 v2 stdio 客户端。当前 Go 开发候选使用目标平台的 `galaxy`（Windows 为 `galaxy.exe`）承接本机核心和所选服务的 HTTP 调用；OpenCode TUI、宿主插件 SDK 和 MCP Apps 界面保留平台代码，模型调用仍使用用户宿主配置。v2 是协议标识，发行版本读取包清单的 `releaseId`，不能据协议名推断版本或验收范围。旧已签名发行包保持其原字节和启动方式；本地候选没有自动替换正式安装。构建与运行边界见 [Go 核心](../../go/README.md)、[Go 候选运行样例](../../go/deploy/README.md)和[实施计划](go-core-plan.md)。公共授权/原操作规则见[接口](interfaces.md#管理身份与原操作)。

## 安装、配置与发行

服务版 Native 与无服务本机 Integration 是两个入口，不能互相替代：

```text
galaxy native --config <现有公开配置绝对路径>
galaxy integration-mcp --data-dir <本机资料目录>
```

`native` 读取服务配置，提供已接入的服务工具、连接与本人选择、宿主接续及本机能力。`integration-mcp` 不要求服务配置，只提供原本机 Integration 工具：初始化、Case Draft／Disclosure／Consent／Local Proof Draft、本机历史与原有本机资料管理等；不构造服务 Runtime、不连接服务或调用模型。它沿用 `--data-dir`、`GALAXY_DATA_DIR` 及默认用户 `.galaxy` 目录的选择次序。本机草稿不是云端 Evidence 或已验证履历；Consent 与 Proof 保留各自的原提交和状态。

Go 候选中的 `setup`、`service-config`、`host-configs` 子命令分别承接原安装、公开配置准备与宿主配置生成。参数以 `galaxy --help` 和 [Go 核心说明](../../go/README.md)为准，不使用旧 Node 业务安装器来处理 Go 候选。`setup` 从所选官网 `galaxy-web-config.json` 读取真实 API 和 Ed25519 公钥；失败保留原资料，不猜另一服务。OpenCode 一次确认列出实际配置/资料位置、记录方式，保存独立运行包并合并银河 TUI/MCP/Skill，保留其他插件、项目和模型设置。已有身份/类型沿用；无身份时同次选择准备个人或明确组织身份。安装不注册账户、关联服务或开始上传。只有自定义目录未被正常启动加载时才使用包内原宿主启动薄适配。

服务版公开配置仍为 `version:2`、精确 HTTPS `endpoint/website`、本机绝对 `dataDirectory`、`trustedKeys`（kid→publicKeyPem/notBefore/notAfter/revoked）；通过 `--config` 或 `GALAXY_NATIVE_CONFIG` 选择，不放 token、私钥或恢复码。配置准备不创建身份/绑定、不跟重定向或覆盖原信任；宿主生成只写选定输出，不自行修改用户配置。

Go 候选宿主配置的 MCP command 指向包内平台二进制，args 为 `native`，env 含公开配置路径。正常宿主源码和包内 `opencode.js` 默认使用 Go，不通过缺包或缺配置回退到旧 JS 内核；旧协议固定字节期望保留在当前回归夹具中，不调用已替代内核。OpenCode 的 JS 仅承担宿主 UI／SDK 桥接；有服务配置时启动 Go MCP 子进程，录制和整理经独立 `galaxy host` 私有 JSONL 子进程保存原资料。私有通道不是模型工具或网络服务。宿主事件取材及模型 SDK 调用留在宿主，不把观察方法开放给模型，也不偷偷改用服务器模型。旧同名 MCP 只启一套，切版本保留数据目录并关旧进程。卸载配置/Skill 不删除本机身份、摘要或任务；设备撤销和数据删除另行办理。

无服务配置的 OpenCode 保留原本机菜单、本人选择与材料／模型选择，持久处理使用 `galaxy integration-host --data-dir <目录>` 私有 JSONL 入口；它按与本机 CLI 相同的目录次序取值，不读取服务配置、不创建服务 Runtime，也不发会话完成上传通知。本机状态、初始化／延后、记录整理和原件管理复用现有本机方法；重置仍由原可信菜单确认，只重置原身份／集成文件，保留独立工作资料。服务配置存在时使用 `host`；两者都不把宿主观察和保存端口加入模型 MCP 清单。

旧签名发行种类 `galaxy-native-client-release` 以 JWS/Ed25519 绑定包和报告准确字节，签名最长30天；其维护、验签和启动说明仍用于对应旧包，不表示 Go 候选沿用旧内核。被替代内核从现行源码退出，历史签名包及必要原始证据留在项目外；宿主 TUI、SDK 桥接和 UI 继续使用各自平台代码。信任不能从包内自行推导。`protocolAcceptance=local-stdio-http-fixtures`、`actualHostAcceptance=false` 的报告只覆盖该范围；验签不等于安装、发布或真实宿主验收。构建及 NOTICE 见[源码与许可](source-and-licensing.md)。

`scripts/build-native-v2.mjs`在新候选目录构建平台 Go 二进制、薄宿主 JS、compact UI 与现有宿主资源，并记录实际文件摘要；不要求源码预存 UI dist。宿主依赖在构建／搬移运行包时闭合，不在安装中联网补包。候选准备核对包完整性和临时宿主配置；实际 CLI 发现、隔离 TUI 与物理桌面分别记录。目标平台、构建成功或包完整性均不表示真实宿主和系统提醒已经验收，也不表示上线或用户已安装。

身份恢复的本机页面模板属于 Go 源码并编入 `galaxy`；候选构建按 `./cmd/galaxy` 的实际 Go 依赖收集源码及嵌入资源摘要，不需要额外复制恢复页面。该接线不代表新候选已经构建或完成宿主、平台验收。

## 宿主配置与能力

生成器的配置形状不是跨宿主验收结论。运行前按包内 `HOSTS.md`、`host-capabilities.json` 和实际 `tools/list` 确认可用能力。

| 宿主 | 生成位置/约束 |
|---|---|
| Claude Code | 项目 `.mcp.json`、`.claude/skills/galaxy`；桌面 Chat/Code/远程来源分开核对，CLI 不直接读取桌面配置 |
| VS Code Copilot Agent | `.vscode/mcp.json` 的 `servers.galaxy`、`.github/skills/galaxy`，不外推其他模式 |
| Codex | 完整 galaxy-native-v2 插件，或 `config.fragment.toml`＋`.agents/skills/galaxy`，只启用一套 |
| Cursor | `.cursor/mcp.json`、`.cursor/skills/galaxy`；Apps 显示、关闭重启须真宿主验证 |
| WorkBuddy | connector-meta/mcp/icon/skills；元数据最低4.24.0，市场注册须独立确认 |
| TRAE/TraeWork | 桌面本地 MCP 的 `mcp.local.json`、项目 `.trae/skills/galaxy`；Go 配置直接引用平台二进制，实际路径及该宿主对 command 空格的处理仍须宿主验收 |
| Hermes | 合并 `config.fragment.yaml` 的 `mcp_servers.galaxy`、宿主 Skill 路径；不读取旧私人资料 |
| DeepSeek Harness | 组合 `mcp-plugin.fragment.json`、项目 `.dsh/skills/galaxy`；复用原 registry/filesystem/consumer，浮窗和后台能力分别实现 |

OpenCode 的事件适配保存本地事实、有限片段和环境，自有模型增量整理；事实不等模型/网络，失败有限重试。`client.tui.appendPrompt({text})` 可追加正文和来源到原未发送输入，不提交模型；原会话返回沿宿主导航。其他宿主无事件接口时只读取已有资料或保存明确自述，不宣称相同自动采集。MCP Apps 使用 compact-app，小面板合同检查不替代真宿主呈现；无 Apps 保留普通 MCP，同义操作继续可用。

Claude `watchHost` 只接受 `kind:claude-code` 与真实绝对 command/cwd，不接受附加参数、认证变量或已验证布尔值。`galaxy_watch_host_capabilities` 只查询版本/help，不建模型会话。缺有效配置证据时 `readerProfileDocumented` 可为真，`readerConfigurationConfirmed/effectiveManagedPolicyConfirmed/backgroundReaderSupported` 仍为假；activate 返回 foreground-fallback（如 `host_reader_configuration_unconfirmed`），不启动模型。原因是 managed settings 优先级及动态来源不能仅靠旗标/缺本机文件排除。前台 `galaxy_watch_check`/`ack` 更新 Agent 游标；reconcile 的 unknown 不等于原模型已停止。

既有证据包括隔离 OpenCode 的实际 TUI 操作及 Codex/Claude CLI 工具发现；它们使用合成数据或有限发现范围，且须保留其记录的版本／运行内核，不能自动归于当前 Go 候选，也不能扩成所有宿主、桌面 UI、真实模型与后台循环都已验收。

根管理的服务信任是显式选择：`service-config prepare` 的 `--root-pins-file` 与 `--trust-directory` 须成对提供绝对路径，`--network-type` 可选 `official` 或 `hub`。根 pin 文件为 `kid → {publicKeyPem,notBefore,notAfter,revoked}` 的公开 JSON，根信任不会从服务响应自行建立。先在服务信息中明确读取，Go 验证 Manifest 和 keyring、持久化公开信任序列后才采用；回滚、冲突、撤销复活及过期均拒绝。更新采用后使旧内存连接失效，沿原身份重新连接；根 keyring 过期不能继续使用旧会话。静态 `trustedKeys` 配置继续沿原方式工作。

## 本机数据、同步与接续

本机准备与远端连接分别处理。手动加载且缺身份时提供一次实际选择，延后选择会保留。已有同身份/设备/服务的有效连接范围可恢复；明确断开、换身份、换设备/服务使旧连接及迟到结果失效。会话 token 仅在进程内，Native 私钥是用户目录独立 PEM，不能声称具备浏览器不可导出 CryptoKey 的属性；旧身份初升沿用 Genesis，新增设备走批准协议，邮箱不能接管 GUID。

`galaxy_local_work_list/get/pending/summary`、`galaxy_command history` 和 `galaxy_local_panel` 读取本机事实/整理。模型摘要与实际观察分开，工具完成不自动成为整体成功。四档由 `galaxy_local_upload_privacy_get/set` 保存：

| 档位 | 上传投影 |
|---|---|
| local-only | 不上传本机工作资料 |
| history-overview（默认） | 类型、角色、时间、结果状态、来源标识及主要版本；不含标题、自由摘要、路径、私人项目名或正文，也不能称匿名 |
| work-content | 另含所选说明、摘要和实际保留材料；有大小/条数窗口及 coverage |
| conversation-archive | 另行启用并选定原会话，才含实际采到的 message/parts；升档不自动全量回填 |

档位只允许数据类型，同步还要选服务、关联账户和具体工作/会话范围；默认不主动上传。凭据始终排除并保类别/位置，白名单投影与输入检查不保证全面匿名化。`galaxy_local_archive_configure/list/export/delete/cleanup` 管理选定原件，可设清理天数；导出报告 coverage/exclusions，不补未采消息或附件。重置身份配置保留独立资料目录。

同步按身份/来源隔离；新工作范围默认只含以后资料，旧资料另选。断网保原操作/快照，云端本人删除不会被旧范围自动恢复，到期快照停止重传，新版本可按有效范围接续。超容量明确未同步，不截断冒充完整；云原会话导出格式 `galaxy-private-conversation-v1` 含实际 session/messages/parts/exclusions/coverage。本机、宿主、云副本删除分别办理。

`galaxy_work_continue` 从网页请求的服务、同身份、对象和精确版本重读；只带定位/返回位置，不复制私人草稿和全聊天。OpenCode 可追加原输入，其他宿主返回可读内容；没有当前权限时 `current:false,data:null` 并保来源错误，不重放缓存。`galaxy_open` URL 只放稳定类型和 ID，本机保存 workRef；Capsule 可带 versionId，Project 路由 `/app/projects/:id`。`galaxy_return` 沿 navigationId 重读同对象，身份/endpoint/website 不同不能沿用原归属。方法引用、网页返回和设备接续不记录成功复用。

## 本人选择、设备与关注

新范围优先 MCP elicitation，缺失时开 `127.0.0.1` 随机端口的临时审阅页，显示准确内容/用途/接收者/范围，5分钟失效、stdio 退出销毁；模型的 confirmed 不算批准，关页不批准。页面只接受精确 loopback Host/Origin，同源 referrer；null/跨源仍拒绝，不为403放宽。退出停止新调用、使预览失效，等待在途回执/保存，再关协议。

`galaxy_identity_web_connect/status` 从原 Native 身份准备受控握手，官网自建设备钥，原设备须本人核对同 GUID/设备/范围后授权；仅交换用途受限公开证明，不跨窗传私钥/token/恢复码。握手180秒，与普通5分钟页不同；弹窗/窗口丢失/关页不表示批准。已登记同 GUID/deviceId/keyId 可复用，新增远端批准不自动替换网页当前设备，须本人采用。恢复坐标为requestId/handoffId与设备journal，存在未决授权时禁用设备复用途径。

设备工具 `galaxy_identity_device_native_read` 的 current/list/pending/reconcile 只核对，prepare_revoke 登记未签挑战并给进程内 previewId，confirm 再经真实选择。控制版本/期限/连接变化重核；撤销只作用所选服务、拒绝目标旧连接，不删除数据或声称全网撤销。最后管理设备须已登记恢复依据才可自撤，登记不证明本人仍持有码。stop_retry 只停止本机继续提交，已签未知操作保留，不等于服务取消。

Native 身份恢复码的当前源码入口是 `galaxy_identity_recovery`：`set` 为当前身份准备新码，`recover` 打开原码输入页，`resume` 以原 `operationId` 接续未完成操作。工具只返回临时本机页面定位，恢复码仅由本人在该页输入或查看，不放入工具参数、工具结果或公开配置。恢复在所选服务的同一 GUID 上执行控制操作，会撤销该服务原设备与绑定、选择新设备并轮换下一代恢复码；本人须在本机保存并确认新码，重新连接另行选择。它不自动恢复历史私有内容或本机资料。页面十分钟有效，关闭或过期不代表服务操作取消；结果未知先查询原回执，只有服务仍记录为待提交时，才可由本人确认重试原签名字节。此流程本机定向联测已通过，不能据源码接线声称最终候选或真实宿主与平台验收通过。

关注需当前房间 Agent grant、用途和结束时间，宿主按 nextCheckAt 调度 check/ack/stop；绑定变更停止旧关注，不复制权限。本机锁/租约只存定位、每次重读来源，人类已读与 Agent 游标分开。无事件不调用模型，当前实现不安装常驻服务；停用 grant 不等于宿主原模型进程已停止。

## A2A 与已选 Worker Pack

缺 `a2a.peers` 不注册工具或发现对端。peer 显式 id/name、精确 endpoint/tenant、peerPrincipal、已审 agentCard、`SHA256(JSON.stringify(agentCard))`（保原字段顺序）、毫秒 trustExpiresAt；仅接受卡中 A2A1.0 JSONRPC 接口，不自动更新卡/期限/接口。

authentication 默认 none，或 `bearer-environment` 指定 `GALAXY_A2A_PEER_<名称>_TOKEN`；只给该子进程注入，实际调用才读，缺失不降匿名、不借 Official token。不支持 OAuth、任意 headers 和自动凭据发现。prepare/execute 走真实选择，对端状态保 peer-reported。互通说明见 [A2A组件](../../packages/galaxy-a2a/README.md)。

`workerPacks.workers` 固定已有 peer 与真实 pack（builderId/manifestId/manifestHash、sourceHash/version），id 为1—80字母数字/下划线/连字符，最多32项。不接受 shell、下载地址或模型程序路径，不安装启动任意程序。`galaxy_worker_host_read/prepare/execute/abort_local` 需准确可读 Attempt/Configuration/用途，执行经原预览/本人选择；面板自动轮询进度及回执。对端Task、participant-reported Result与PackUse保留独立关联和记录，abort_local只结束本地等待，远端CancelTask另行确认。当前回归分别核对 Go 执行与宿主协议；受控协议端不等于外部 Worker 或真实宿主平台验收。

## 系统提醒与平台范围

提醒默认关闭，重启重新明确启用；status 不开进程/定时器/模型，enable 经选择后每60秒查收件箱，disable/断开/退出清理。配置只含 `hostNotifications.kind`（linux-freedesktop/windows-notify-icon/macos-user-notifications）与可选绝对 command，不接受 enabled、参数、脚本或正文。省略时按 OS 选择通道，缺依赖保前台入口，不自动安装或启动 session bus。

Windows 固定 NotifyIcon 仅收到 BalloonTipShown 才记观察到展示。Linux 用同用户本地 Unix D-Bus/Python3/PyGObject/GIO，helper 仅收模式和数量，不收私有标题/正文/URL/收件人/对象ID；Notify 返回仅受理，`displayed:false`。固定服务唯一名称/通知ID撤回不重连猜测，未知尝试重启不重发。Windows 中的 Linux 检查使用受控 Node 替身，不是实体 Linux 桌面验收。

macOS 当前只有源码/协议检查，无编译、签名、公证 helper。command 必须为 `.../GalaxyNotifications.app/Contents/MacOS/GalaxyNotifications`，不退 AppleScript。已有 macOS SDK 时可用源码 `notifications/macos-helper/build.mjs` 向新绝对目录构建，仍不签名/安装/启动。permission 工具每次独立本人选择，仅未决定时请求系统 alert 权限；普通 status/enable 不弹窗，也不标已读。UNUserNotificationCenter.add 仅受理、展示未知；撤回请求与之后观察列表消失分开。Swift 编译、真实 Notification Center 和发行适用性需对应机器验证。
