# Native 客户端与宿主工程

统一 Go Native 核心提供本机服务及 MCP 接口，stdio 入口作为宿主薄连接。客户端使用目标平台的 `galaxy`（Windows 为 `galaxy.exe`）承接身份、资料、业务调用与连接；npm 引导、原生整版包和适用容器均交付同一核心。JavaScript／TypeScript 保留安装引导、OpenCode TUI、宿主 SDK 和 MCP Apps 界面，模型仍由用户宿主提供。v2 是协议标识，发行版本读取包清单的 `releaseId`，不能据协议名推断版本或验收范围。旧已签名发行包保持其原字节和启动方式；源码改动经正式发行后由更新程序应用，不自行替换用户安装。构建与运行边界见 [Go 核心](../../go/README.md)、[Go 运行样例](../../go/deploy/README.md)和[架构](architecture.md)。公共授权/原操作规则见[接口](interfaces.md#管理身份与原操作)。

## 通用插件与共用本机服务

本节合并已确认职责、当前源码接线及开发准备依据。共用服务、薄连接、安装维护、完整 MCP 和宿主适配已进入实现，不再作为待选的另一套客户端架构。客户端已有正式发行；当前源码修改、实际检查与剩余工作以 [WORK_STATUS](../../WORK_STATUS.md) 为准。

本机经验的增量整理、形成依据、检索与修订集中见 [经验机制](native-learning.md)。支持的宿主使用用户已选模型；实际平台和模型覆盖以当前状态记录为准。

### 客户端交互与结果

MCP 的结构化结果保留完整业务数据和诊断，可读内容呈现实际正文、操作结果及必要选择。宿主同时兼容旧版 JSON 文字结果；配置、签名、操作定位等由程序和 Agent 处理，不要求使用者理解或填写。业务结果与辅助状态读取分别交付，后续读取失败不抹掉已经取得的结果。

连接状态区分稳定身份、当前连接、持久账户关联及短期登录进度。技术连接和官网账户关联分别沿原 ID 办理并观察原操作；自身登记设备造成的正常变化继续接续，真正身份或权限变化仍约束后续读取与操作。本机确认页局部更新结果，记录保存、设备移除等确认以具体对象和实际影响展示。

### Skill 的按需组合

对宿主保持一个 `galaxy` 入口；入口按用户当前用途选择 `references/` 中的接入维护、查询帮助、社区、身份、本机记录、房间、协作或网页接续说明。高级身份管理再从身份模块深入读取，不在普通接入时加载全部细节。模块可以围绕同一任务组合，也可与宿主已有的工程或文档 Skill 协作；不创建固定业务编排或依赖未安装的 Skill。

客户端包、官网独立 Skill ZIP 和稳定公开路径均从同一 Skill 源树递归生成。宿主仍按原格式安装整套目录，不假定每个宿主都能发现多个独立子 Skill。更新替换受管理目录；官网重复生成清理自己负责的旧 Skill 文件，避免出现内容不同步的模块。

### 已确认职责与当前运行结构

已确认：[按需启动后保持运行](../product/client.md#通用插件的运行方式)，退出单个Agent不关闭共用本机服务；用户可主动退出；系统登录和进程管理边界按平台实际机制处理，不设置开机自启。首次只接入当前宿主的当前系统用户范围，其他宿主以后接入同一核心。多种部署方式共存，由Skill配合Agent选择及排障，尽量降低用户操作。保留本机身份、资料、既有业务能力和用户侧模型职责，不另建服务器业务实现。

当前 `go/internal/nativebridge` 持有同用户共用服务；`native`／`integration-mcp` 与 `host`／`integration-host` 分别是 MCP 和私有宿主薄连接。宿主观察与持久化走私有通道，业务调用复用 `go/internal/native`。npm、原生包与容器使用同版程序和资源；HTTP MCP、会话读取、面板及后台模型能力仍按宿主实际接通情况采用。

最新边界：完整MCP能力＋Skill用法是Agent主入口。Agent决定任务如何组合、继续与结束，程序负责实际操作、资料、连接和结果。持续关注复用 MCP 与宿主实际执行能力，事实记录由薄适配器采集。支持的宿主在真实阶段完成、事实保存后使用用户已选模型整理实质增量；原 pending/summary 和经验读写仍可由当前 Agent 直接使用，其余宿主在正常回合接续。人工菜单和旧显式analysis兼容工具是可选能力，不是Agent使用银河的前置流程；现有业务授权及原操作规则保持。

阶段自动整理在 OpenCode V2 的对应前台 TUI 会话接通，模型侧与 TUI 记录完成通过同一项目作用域的 RPC 汇合，按原请求代次去重，不以延迟赌落库。无 TUI 的 CLI 自动记录尚未接通；Codex/Claude/Hermes/DSH 的已适配模型上下文提示与 MCP 接续不等于已完成全部真实宿主验收。一次新请求只预取一次相关经验候选，正文和来源工作由 Agent 按需选择读取，任务不强制经过某个指定工具。

经验与处理位置保存在原 `work-history/history.sqlite`，摘要位置和已整理位置分别管理；无新增方法可不写经验。检索采用 FTS5 trigram / bm25，只有无法建立三字符词项的短查询使用有限短词回退。自动修订只使用本轮实际读取的完整条目，索引片段不覆盖正文；来源删除使相关修订退役，不自动恢复旧版。模型错误按宿主实际类型保存可查原因，未处理材料保留，不自动更换模型或重发业务操作。

```text
Skill用法＋当前Agent → 环境发现与共用安装/维护入口
                              ├─ npm引导
                              ├─ 原生安装
                              └─ 适用环境的容器交付
                                       ↓
宿主Skill/MCP/薄插件 → 共用Go Native服务 → 现有银河HTTP/事件接口
        │                  │
   宿主模型与会话     身份、资料、回执、事件与接续
        └──── 原工作关联 ───┘
```

### 开源源码选择与复用方式

下表保留固定上游的准备依据；实际直接依赖以 `go/go.mod` 和源码为准，参考机制不表示全部采用。共用服务已使用 `gofrs/flock` 与 Windows `go-winio`；其余候选库按实际需要采用，不为它们建立第二套运行核心。

| 上游与准确来源 | 核查到的机制 | 银河采用建议及限制 |
|---|---|---|
| Vercel Skills `7a5e920bead4b1039a6d6df5d7e1163b7b09423a`：[宿主目录](https://github.com/vercel-labs/skills/blob/7a5e920bead4b1039a6d6df5d7e1163b7b09423a/src/agents.ts)、[当前Agent识别](https://github.com/vercel-labs/skills/blob/7a5e920bead4b1039a6d6df5d7e1163b7b09423a/src/detect-agent.ts)、[安装](https://github.com/vercel-labs/skills/blob/7a5e920bead4b1039a6d6df5d7e1163b7b09423a/src/installer.ts) | 当前执行环境与已安装目录分开；Skill统一来源及链接/复制；Cursor弱环境标记另行排除 | 选择性适配目录表、环境线索及单份分发；目录存在只是线索。它不负责完整MCP/插件接线；不带入遥测、全宿主默认安装或每次临时下载 |
| MCPorter `e5933dc7f5ed4dcb71e1ffc2b0cc5272c25007ec`：[启动](https://github.com/openclaw/mcporter/blob/e5933dc7f5ed4dcb71e1ffc2b0cc5272c25007ec/src/daemon/launch.ts)、[本机通道](https://github.com/openclaw/mcporter/blob/e5933dc7f5ed4dcb71e1ffc2b0cc5272c25007ec/src/daemon/paths.ts)、[连接代理](https://github.com/openclaw/mcporter/blob/e5933dc7f5ed4dcb71e1ffc2b0cc5272c25007ec/src/daemon/broker.ts)、[配置路径](https://github.com/openclaw/mcporter/blob/e5933dc7f5ed4dcb71e1ffc2b0cc5272c25007ec/src/config/imports/paths.ts) | 独立启动、就绪握手、每用户通道及多连接复用；Windows命名管道、其他系统socket；配置来源与连接身份区分 | 借鉴生命周期和宿主配置发现，Go实现沿用银河Runtime；不嵌入整套Node MCP代理、浏览器专用逻辑或其空闲退出参数。显式退出不被后台重连立即拉起 |
| MCP Go SDK **现有v1.8.0**：[HTTP传输](https://github.com/modelcontextprotocol/go-sdk/blob/v1.8.0/mcp/streamable.go)、[服务与工具](https://github.com/modelcontextprotocol/go-sdk/blob/v1.8.0/mcp/server.go) | 已有stdio、Streamable HTTP、事件存储接口、工具变更通知与会话能力 | 直接复用现有依赖，无需为网关另换MCP框架。EventStore须接实际存储；协议会话及重连不等于业务任务持久化。按宿主能力使用工具变更，不能默认各宿主都会重载工具目录 |
| MCP Apps **现有2.0.0**：[App实现](https://github.com/modelcontextprotocol/ext-apps/blob/v2.0.0/src/app.ts) | 面板调用、链接、宿主能力；`updateModelContext`更新未来轮次上下文，`sendMessage`另有触发语义 | 继续复用compact-app，按实际能力接面板和返回；不把更新上下文说成AI已继续，不向无Apps宿主虚构嵌入界面 |
| OpenCode **v1.18.31**：[平台启动器](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/bin/opencode)、[TUI接线](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/server/routes/instance/httpapi/handlers/tui.ts)、[会话处理](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts)、[同工作执行协调](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/core/src/session/run-coordinator.ts) | 平台包选择；输入追加、会话读写；同一key执行协调与唤醒 | 继续用现有宿主SDK与薄插件；借鉴安装入口及同任务串行接续，不复制其模型引擎、任务轮数或运行后端 |
| DSH `ce7073d51254c26cd63b22a60835b8f948deb447`：[增量投影](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/api/session-controller/src/client/sessions/projection-store.ts)、[稳定列表](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/api/session-controller/src/client/ordered-baseline.ts)、[安装失败分类](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/boot/plugin-manager/src/install-failure.ts) | 每项按序更新，旧基线不覆盖新事件；网络、权限、空间、完整性等实际失败分开 | 选择性借鉴状态合并和失败事实，不引入整套Session Controller/插件平台；银河沿原业务版本、游标和回执处理 |
| Hermes `81567c33e9997fbd4eb26a23f289e47f3eba777e`：[插件钩子](https://github.com/NousResearch/hermes-agent/blob/81567c33e9997fbd4eb26a23f289e47f3eba777e/hermes_cli/plugins.py)、[事件分发](https://github.com/NousResearch/hermes-agent/blob/81567c33e9997fbd4eb26a23f289e47f3eba777e/hermes_cli/plugin_events.py)、[消息存储](https://github.com/NousResearch/hermes-agent/blob/81567c33e9997fbd4eb26a23f289e47f3eba777e/hermes_state_messages.py) | 会话、工具、模型和流式观察钩子；消息与来源/展示信息分开 | Hermes适配优先走实际插件钩子；通用观察合同借鉴事件关联。原存储和摘要继续归银河，不导入上游数据库、强制验证循环或改写用户回复的中间件 |
| `gofrs/flock` **v0.13.1**：[Windows](https://github.com/gofrs/flock/blob/v0.13.1/flock_windows.go)、[Unix](https://github.com/gofrs/flock/blob/v0.13.1/flock_unix.go) | OS文件锁、非阻塞TryLock，持锁生命周期由进程/句柄约束 | 已用于同用户核心实例启动互斥及所选 transcript 读取互斥；原`.galaxy-coordination.sqlite`业务协调锁保留，锁的作用域分别处理 |
| A2A Go SDK **v2.7.0**：[协议1.0](https://github.com/a2aproject/a2a-go/blob/v2.7.0/a2a/core.go)、[客户端](https://github.com/a2aproject/a2a-go/blob/v2.7.0/a2aclient/client.go) | 发送、流式消息、取任务、取消和订阅；源码明确协议版本1.0 | 作为替换银河重复wire/流解析的候选；先对齐现有请求字节、card、Task/Attempt和原操作语义。保留银河授权及事实归属，不改用SDK内存任务库，不借此新建Hub服务 |
| go-selfupdate `8ea35fe103fcb292fcc19d9258f5bb37859febdf`：[更新](https://github.com/creativeprojects/go-selfupdate/blob/8ea35fe103fcb292fcc19d9258f5bb37859febdf/update.go)、[替换与失败恢复](https://github.com/creativeprojects/go-selfupdate/blob/8ea35fe103fcb292fcc19d9258f5bb37859febdf/update/apply.go) | 下载验证、解压、程序替换与失败回退；校验器为可选配置 | 借鉴或选择性复用更新模块，不直接套单文件更新：银河同时有面板、Skill及宿主资源，需整版目录交付。上游默认可选校验不等于银河已有发行验签，亦不必引入其全部托管平台SDK |
| GoReleaser `a0881564a526aa9662ad90b5a7b23ac2f215f4b7`：[构建](https://github.com/goreleaser/goreleaser/blob/a0881564a526aa9662ad90b5a7b23ac2f215f4b7/internal/builders/golang/build.go)、[归档](https://github.com/goreleaser/goreleaser/blob/a0881564a526aa9662ad90b5a7b23ac2f215f4b7/internal/pipe/archive/archive.go) | 目标平台构建、资源归档和发行流水线 | 候选构建工具；先整理现有scripts的单一产物合同，再判断是否用其开源基础功能替换重复脚本，不在用户运行时安装，不并存两套发行主流程 |
| beeep `bb308db910e19405f29ec9e10e4463316cd5779c`：[Linux](https://github.com/gen2brain/beeep/blob/bb308db910e19405f29ec9e10e4463316cd5779c/notify_unix.go)、[macOS](https://github.com/gen2brain/beeep/blob/bb308db910e19405f29ec9e10e4463316cd5779c/notify_darwin.go) | Linux D-Bus/命令回退，macOS依赖terminal-notifier/AppleScript等 | 作为通道参考，不整体替换现有通知：API成功不证明展示/已读，macOS也不是无依赖的系统签名通知。现有Windows、Linux与macOS helper按真实平台补齐 |
| XDG `424b3a2ab7ce7f10194ffeee64017f8968be202e`：[Windows目录](https://github.com/adrg/xdg/blob/424b3a2ab7ce7f10194ffeee64017f8968be202e/paths_windows.go) | 平台配置、数据、缓存及运行目录分别解析 | 目录布局参考；保留现有显式dataDirectory，不因标准化静默迁移用户资料，暂不为目录名称单独增加依赖 |

许可：Skills、MCPorter、OpenCode、DSH、Hermes、go-selfupdate、GoReleaser及XDG的已读根许可为MIT；其中go-selfupdate实际参考的`update/`子目录另有[Apache-2.0原文](https://github.com/creativeprojects/go-selfupdate/blob/8ea35fe103fcb292fcc19d9258f5bb37859febdf/update/LICENSE)，不能只带根MIT。flock为BSD-3-Clause，beeep为BSD-2-Clause，A2A Go为Apache-2.0。MCP Go SDK/Apps的已读原文包含MIT向Apache-2.0过渡及文档CC-BY-4.0说明，不能概括为整仓纯MIT。采用与许可归集按实际源码和锁版本办理；研究候选不随用户安装全部分发，见[许可归集](source-and-licensing.md#native-许可生成与准备按准确发行-profile)。

Codex接续按[官方App Server](https://learn.chatgpt.com/docs/app-server)研究：区分`thread/read`、`thread/resume`、`turn/start`和流式事件；stdio/Unix socket与实验性TCP WebSocket区别处理。启动自己的app-server不证明能控制用户已打开桌面聊天；必须核实实际宿主连接和会话归属。当前并无控制已打开 Codex 桌面聊天的完整接线。

### 全能力适配清单

本表归集能力对应的实际模块及接线范围；实际发行和未覆盖项见 [WORK_STATUS](../../WORK_STATUS.md)。它是工程职责清单，不规定 Agent 必须依次执行的任务流程。

| 领域 | 银河源码 | 接线与范围 |
|---|---|---|
| 统一初始化、环境识别、安装及修复 | `installation.go`、`host-configuration*.go`、现有Skill | 发现已有核心/身份、系统与当前宿主、用户级配置和可用能力；单份安装、多入口复用；首次MCP尚未安装时也能执行引导/修复。识别、Skill安装、MCP加载和完整宿主能力分开记录 |
| 身份、个人/组织/Agent、设备与账户 | `connection-first-use.go`、`identity-account*.go`、`identity-recovery.go`、`identity-control-operation.go`、`command-local.go` | 共用服务持有原ID、密钥、关联、恢复及设备操作；不同资料/身份/服务隔离。Worker ID创建与Worker运行分开，不靠重建ID处理冲突 |
| 普通真实工作默认积累与环境事实 | `host-local.go`、`history*.go`、OpenCode `work-recorder.mjs` | 宿主消息/工具/产物观察接内部通道，按实际源ID及宿主版本或本机观测修订去重；补主要环境事实、实际模型与未知范围。无工具调用的普通工作也在已确认范围；不以模型自述补造宿主事实 |
| 用户模型增量整理及个人摘要 | 本机MCP pending/summary工具、宿主新增事实提示、`personal-summary-sync.go` | 当前Agent结合任务读取材料，使用本页提交位置保存摘要，来源由事务自动关联，自行决定分批与时机；支持的宿主可在阶段结束后使用用户已选模型整理，无新增内容时保持原记录。事实先保存，来源/修订冲突沿实际状态接续，不默认改用后台模型 |
| 原件与完整会话 | `archive*.go`、宿主archive采集 | 沿原选择取得实际message/parts，保留未采/排除范围、导出和删除；默认工作积累不改成默认全会话归档。JSON/PEM、履历SQLite、原件SQLite与协调SQLite分别保留 |
| 四档上传、履历/原件/摘要私有同步 | `upload-lifecycle.go`、`sync-work-*`、`sync-archive-*` | 把已有选定范围、队列与回执交共用服务持续持有；服务恢复后查原操作，远端删除不被旧副本复活。保持原云端接口，不用文件同步软件代替领域同步或复制整个SQLite数据库 |
| 查询、求助、发布、房间及业务参与 | 现有Go远端工具、Skill按需references、帮助/消息面板 | 保留真实读写和原授权；由用户Agent按工作目的使用。已有流程在聊天/TUI/面板/官网之间连续；不为普通求助造新的官方流程、固定失败阈值或强制Task |
| 原聊天与网页接续 | `navigation.go`、`work-continuation.go`、`web-handoff.go`及现有MCP工具 | Agent用`galaxy_open`打开原对象，用原`navigationId`调用`galaxy_return`重读结果；官网接续链接由`galaxy_work_continue`按当前身份和权限读取。Agent在原聊天处理取得的资料，宿主无需自动写入聊天或输入区 |
| 持续关注与已委托任务 | 现有MCP watch/check/ack/status/stop、房间grant与原事件/回执 | 用户Agent按目的组合工具，决定实际处理及ACK；程序保存事件与位置，不新增固定job/child菜单。旧显式只读分析工具保持原用途，不作为通用任务主路径，也不限制新明确委托沿当前Agent已有工具执行 |
| A2A与Worker Pack | `a2a-*.go`、`worker-*`、现有参考Pack及协议资源 | 评估SDK替换传输重复代码；贯通已有选择、任务、取消、状态和结果归属。对端状态与银河确认分开。专业Worker/Hub初始化仍有未实现项，Hub服务端部署不作为通用客户端安装的隐含内容 |
| 小面板、TUI、聊天与系统通知 | `compact-app`、OpenCode TUI、`host-notification-*`、各平台helper | 共用内容/动作视图，保留各平台交互；处理输入、取消、关闭返回、加载、局部失败和独立更新。通知受理/实际展示/业务已读分别处理；无图形宿主仍完成可支持的业务操作 |
| 工具目录、schema与模型兼容 | `tool-registration.go`、`tool-schema.go`、当前MCP SDK及宿主schema适配 | 按宿主支持选择发现/分组/工具变更方式；工具仍沿同一实际目录执行，不固定缩成测试的5项。检查联合schema、结构化结果、并行工具及取消，保留原服务端业务校验 |
| 安装维护、多平台与正式发行 | `build-native-v2.mjs`、`prepare-client-candidate.mjs`、`native-client-release.mjs`、现有许可工具 | npm/直接安装/容器共用产物；平台命名、版本选择、资源完整更新、启动、修复、卸载及资料保留。Windows/macOS/Linux分别记录真实能力，签名/公证/市场上架不能以交叉编译代替 |

Worker/A2A和普通panel的MCP结果在 `Content` 中提供与 `StructuredContent` 同源的JSON，保证只消费文本结果的宿主模型也能取得后续操作和分页引用。组件专用正文仍保留原Meta边界，按组件投影生成模型结果；人类界面由实际共享renderer呈现，不再另维护Go摘要副本。

### 共同机制与模块归属

业务复用 `go/internal/native`，生命周期与本机 IPC 在 `go/internal/nativebridge`，安装维护在现有 `installation*`／`host-configuration*` 模块；`cmd/galaxy`装配入口。`integrations/host-adapters/<host>`负责宿主 SDK、事件和 UI，`integrations/native-v2/compact-app`负责共用小面板。Skill正文按需引用现有references；发行工具集中沿既有scripts入口维护。

Native 的连接、导出、删除、公网传输及 A2A 业务由 Go 实现。JavaScript 保留宿主诊断与界面、独立参考 Worker 的第三方协议 SDK，以及离线治理材料准备。

事实观察的Host与ingress子进程共用最小环境投影，只接收所需的系统、会话、代理及Native资料路径；宿主模型的凭据和无关环境不向观察进程传递。该投影不修改父Agent环境或通用工具执行器。

共同合同最少包含：

- **实例与资料范围**：安装位置、运行版本、协议版本、实际进程实例、本机连接及资料profile。先复用已有实例，启动锁与业务锁分开；PID存在不等于服务就绪。多资料范围由同一进程分别持有Runtime，不共享一个可被其他宿主切走的全局当前身份。
- **宿主能力**：实际宿主/版本/配置范围、MCP及Skill、观察、原会话定位、输入追加、面板、后台执行、模型调用、停止及取消。分别记录已发现、已接入和实际可用；不以目录存在作为全部可用。只有真实差异才设适配，避免第二份长期手填功能目录。
- **工作与事件**：原宿主会话、工作、来源事件/修订、对象版本、原操作、处理位置及消费者。已完成历史按需读取；新增/修订只更新相关项。DSH式序号合并可借鉴，但宿主游标、云业务版本和MCP事件位置不能混作全局同一序号。
- **Agent使用**：完整MCP提供实际能力，Skill说明用途、条件与可选示例；用户Agent使用自己的执行环境按任务选择、继续、等待或结束。程序负责资料、连接与事件，阶段整理按宿主模型能力执行。宿主不能后台运行时保留准确状态，不把接收通知说成模型已执行。
- **安装与故障事实**：Agent和人工入口共用同一计划/执行器，返回实际阶段、原因、已完成动作及可继续方式。网络、空间、配置冲突、缺运行环境、版本及权限分开；读取本任务所需诊断，不复制所有宿主凭据。程序能确定的直接处理，Agent根据事实组合修复，不按无限重试或一律重装处理。

stdio薄连接结束只释放该宿主连接，不能关闭共用核心。主动退出须记录本次暂停意图，后台重连不得立即拉起；下次明确使用可再次按需启动。Windows WTS 与 macOS launchd 登录边界沿现有机制观察；无法观察时状态报告 `lifecycle.mode:unavailable`。Linux 按需启动时优先使用同一有效用户的 systemd transient service（root 使用系统管理器），状态标记为 `managed`；管理器不可用或显式前台运行时由执行环境管理，状态标记 `environment-managed`。Linux 不把启动来源的单个 shell 会话关闭当作共享核心的退出信号。用户管理器的生命周期仍受系统登录和 linger 设置约束；不配置 linger、不安装或启用开机服务。服务启动所需环境通过匿名管道传递，不写入 unit 属性或启动参数。协议传输恢复不自动重发已发出的业务写入；继续使用原操作和回执。

本机进程优先采用适合平台的私有IPC；浏览器需要时使用回环HTTP并校验来源和本机连接身份，不能暴露到公网。官网身份接续沿既有设备授权和服务事件办理，网页资料由Agent通过普通MCP读取。WSL/容器/远程分别发现执行机器和连接路径，不自动挂载整个用户目录或混用桌面与容器localhost。

### 宿主推进与部署选择

当前实现按所选宿主接入共用核心，OpenCode保留TUI适配；Codex、Claude、Hermes和DSH有相应事实观察源码。配置生成、用户级安装、宿主实际加载、会话观察及面板能力分别核对；Copilot、Cursor、WorkBuddy、TRAE等的配置形状不代表这些能力均已验收。

Codex安装使用宿主官方`hooks/list`和配置写接口，逐项采用本次安装的事实观察hook；已由用户关闭的hook保持关闭。`hooksConfigured`只表示文件接入，`hookStatus`另示实际采用结果，不代表普通会话已实际触发录制。repair与uninstall只处理原安装记录匹配的MCP表及自有信任字段，其他配置表和用户修改保持原样。实际宿主会话记录结果仍以当前状态说明为准。

Vercel Skills目录表与MCPorter配置路径是适配线索，各宿主当前官方合同及真实加载结果才决定采用位置。选择用户级安装不等于把其他现有项目/组织配置覆盖成统一配置。若宿主无用户级能力、原会话接入受限，或必须改变用户可见操作，带具体差异与选项核对；不静默降为项目级或新建会话。

安装选择优先复用可用核心，其次结合当前环境选择npm引导或原生包；容器用于实际适用的容器/远程环境，不为普通桌面额外引入Docker。选择可以根据故障调整，无须写死每种工具的优先链。npm不作为每次MCP启动的浮动`latest`下载路径；程序、资源与资料分开，稳定启动入口指向整版安装。更新先准备同版二进制/面板/Skill/适配资源，再在可接续时切换，不单独替换一个可执行文件。旧版本目前保留：在不能证明所有相关连接和进程均已退出时不自动删除；不在源码仓库堆备份。

## 安装、配置与发行

`galaxy install`、`update`、`repair`、`uninstall` 共用本机安装维护入口，人工和 Agent 均可调用；`--dry-run` 只查看计划。准备完整候选后，从其中的 `galaxy`（Windows 为 `galaxy.exe`）执行。程序从当前进程的宿主环境线索识别所选宿主；没有唯一线索时用 `--host <宿主ID>` 明确指定，目录存在本身不证明宿主正在运行或已加载。默认只处理当前用户和所选宿主，不修改其他宿主配置。

```sh
galaxy install --host opencode --local-only
galaxy update --host opencode --package-dir <完整候选目录>
galaxy repair --host opencode
galaxy uninstall --host opencode
```

这些示例选择本机模式。默认资料目录为用户目录下 `.galaxy`，可用 `--data-dir` 指定；安装根目录在当前用户的平台数据目录，可用 `--install-root` 指定。服务版用 `--config <公开配置文件>` 或 `GALAXY_NATIVE_CONFIG` 选择既有配置，配置内的 `dataDirectory` 与所选资料范围一致。底层 `install` 未提供服务配置时使用本机模式；面向初次使用的 `setup` 从所选网站准备配置并在安装后接入，同用户现有身份继续沿用。维护命令默认沿用受管记录中的资料和连接；明确选择其他配置或 profile 时保留原资料与身份。同宿主不同用户配置有各自记录，卸载指定 `--mcp-config` 可定位特定配置。显式 `--local-only` 安装只使用本机资料；已选择服务配置的安装会在成功后连接该服务。官网账户关联及资料上传另按原选择办理，断网保留待接入的网站。`repair` 与 `update` 沿用已保存连接。

已接入的用户级配置包括 OpenCode、Codex、Claude Code、Cursor、VS Code Copilot、Copilot CLI、Hermes 和 DSH；实际宿主加载和能力仍需分别核对。VS Code 的非默认用户 profile 可通过 `GALAXY_VSCODE_PROFILE_DIR` 指向实际目录；DSH 需有当前 `DSH_PROFILE_DIR` 或 `DSH_PROFILE`。对于其他宿主，只有已知道其当前用户配置位置和格式时才明确指定：

```sh
galaxy install --host custom --mcp-config <用户级MCP配置文件> --skill-dir <该宿主galaxy技能目录> --mcp-format json-mcpServers --local-only
```

`--mcp-format` 支持 `json-mcpServers`、`json-servers`、`toml-mcp_servers`；路径使用绝对路径，`--skill-dir` 是所选宿主中银河 Skill 的目标目录。也可省略 `--host custom`，由上述路径参数选择自定义入口。`repair`、`update` 沿用选定的受管记录；存在多个自定义配置时，维护及卸载均提供相同 `--mcp-config` 定位目标。配置冲突按实际返回处理，不覆盖无法确认归属的同名项目。

Codex 和 Claude 的事实 hook 使用 Node；程序可从 PATH 发现，或用 `--node` 指定。Node 缺失、hook 配置冲突或其他 hook 故障不会阻断已能完成的原生 MCP 与 Skill 安装；结果分别报告 `mcpConfigured`、`skillInstalled`、`hooksConfigured` 与 `hookStatus`，修复环境后可再执行 `repair`。hook 记录宿主实际事实，当前 Agent 可按任务使用 MCP 和 Skill，不由安装器启动固定摘要子模型。宿主权限、hook 信任及实际加载仍由该宿主决定。

安装器先按目标 OS/架构和清单检查候选，内容与依赖一致时复用已有受管发行，否则把平台二进制、面板、Skill、宿主适配及其依赖复制到用户安装根下的新发行目录，再更新选定配置；宿主入口不依赖临时 `npx` 缓存。现有资料和用户自有配置保留；`uninstall` 移除所选受管宿主配置，并按宿主处理不再被其他受管记录引用的 Skill；OpenCode 的 Skill 随保留的旧发行目录保留。卸载不删除身份、履历、任务或其他资料。旧发行目录当前保留，不能仅凭 PID 或一个服务状态推断所有旧连接已退出。

共用服务按需启动，`native`/`integration-mcp` 是 MCP 薄连接，`host`/`integration-host` 是宿主私有 JSONL 通道。关闭单个宿主连接不会关闭共用服务，也不设置 OS 开机自启。首次安装在尚无期望版本时选择完整发行；普通 `install` 和 `repair` 保留已经选定的服务版本，修复较旧宿主不会把服务期望版本切回旧版。明确执行 `update` 才选择本次完整候选作为期望版本；正在运行的兼容旧核心继续服务，`galaxy service status` 报告运行版本、期望版本及 `restart-required`。需要切换时执行 `galaxy service restart`。

支持交接协议的核心与薄连接在切换时暂停接纳新的业务消息，等待已接纳请求及其响应写入原宿主输出，再切换核心并让同一 stdio 连接重新建立协议；不自动重发业务操作。已有本人选择或其他进程内待处理交互时，切换报告等待并恢复旧连接，原选择仍可继续，处理后再执行切换。连接意外中断时，结果不能仅凭断链认定成功或失败，应查询原操作与回执。没有该控制协议的旧核心或旧连接不能声称可无损自动迁移，切换会报告不支持或旧连接限制，不以强制终止代替排空。`galaxy service stop` 记录暂停意图，后台重连不会立即拉起；`galaxy service start` 明确恢复。停止、重启和卸载均保留身份与资料。

Unix 本机通信在地址长度允许时保留原缓存内 socket；超出系统限制时，使用按当前用户和规范缓存路径生成的稳定私有短地址，锁、期望版本及暂停记录仍在原缓存。不同宿主的临时目录不改变该地址。

服务版入口 `galaxy native --config <公开配置绝对路径>` 提供当前已接入的服务和本机工具；本机入口 `galaxy integration-mcp --data-dir <目录>` 不构造服务 Runtime 或连接服务。对应的 `host`、`integration-host` 只供可信宿主使用，不作为模型 MCP 工具。公开配置含 `version:2`、HTTPS `endpoint`/`website`、绝对 `dataDirectory` 和可信公钥；通过 `--config` 或 `GALAXY_NATIVE_CONFIG` 选择，不写入 token、私钥或恢复码。`service-config inspect/prepare` 负责读取所选服务信息和准备公开配置；显式根 pin、信任目录及轮换见下文。`setup` 保留从所选官网读取公开服务配置并展示计划、经本人确认后安装的原入口，也支持 `setup --local-only`；实际安装共用同一执行器；`host-configs` 只向新目录生成片段，不代表已安装或宿主已加载。命令参数以 `galaxy --help` 为准。

`scripts/build-native-v2.mjs` 构建平台二进制、面板、Skill 和宿主资源，`scripts/prepare-client-candidate.mjs` 在构建时解析并锁定薄宿主依赖、归集许可并准备归档；已有缓存可用 `--offline`。`--goos`/`--goarch` 可选择目标，跨目标构建产物不在当前机器执行安装检查。归档名包含发行版本、OS 和架构。`scripts/prepare-native-npm.mjs` 从已准备的客户端产物生成 `@galaxy/native` 薄入口和对应平台包目录，仅列入本次提供的目标。启动器无参数时执行 `install`，无法唯一识别宿主时在交互终端提示输入宿主 ID，非交互环境可使用 `install --host <宿主ID>`；其他参数直接交给 Native 程序。`scripts/prepare-native-container.mjs` 从 Linux 客户端产物生成容器构建上下文。正式发行的 npm 包可从发行页下载并离线安装；容器上下文用于本地构建。容器显式挂载专用资料目录和所需公开配置，用同一用户启动一个前台核心，再让各宿主通过 `docker exec -i` 连接同一容器；私有 IPC 在容器内。容器 `localhost` 不是桌面 `localhost`，不自动挂载整个用户目录、发布端口或部署数据库。容器准备器的第四个可选参数为基础镜像引用，也可由 `prepareNativeContainer({baseImage})` 传入；已核实的 `image@sha256:…` 可直接用于固定构建。默认值采用已经实际拉取并核对的 `node:22-bookworm-slim` 摘要，准确引用只在脚本中维护；显式覆盖时生成结果和说明仍区分固定摘要与可变标签。准备器不自动查询镜像，基础镜像更新与客户端发行分别处理。

正式发行版本和各平台文件以 [官网下载目录](https://agigalaxy.org/downloads/) 及其签名清单为准；当前源码目录登记于 `apps/galaxy-site/release-data.json` 的 `currentNativeClient`。实际平台与宿主结果集中于 [WORK_STATUS](../../WORK_STATUS.md)。

历史签名包沿用其准确版本的验签与启动说明；许可材料见 [源码与许可](source-and-licensing.md)。当前 Mac／ARM 交叉构建及系统通知的实际限制见当前状态。

身份恢复页面模板编入 `galaxy`；候选构建按 `./cmd/galaxy` 的实际 Go 依赖收集源码及嵌入资源摘要，不需要另复制页面。其接线与真实宿主、平台验收分别记录。

## 宿主配置与能力

包内 `HOSTS.md` 和 `host-capabilities.json` 说明接入形状与源码适配范围；当前工具目录以实际 `tools/list` 为准。真实宿主验收集中记录在 `WORK_STATUS.md` 及其外部证据，不在静态配置清单维护重复的运行或发布状态。

当前受管安装使用下列用户级入口；`host-configs`生成的项目片段只是可选手动配置材料，不作为用户级安装结果。

| 宿主 | 当前用户级接入 |
|---|---|
| OpenCode | 实际配置目录的TUI／MCP条目与同版插件Skill；复用当前资料范围 |
| Claude Code | `~/.claude.json`的MCP、`~/.claude/skills/galaxy`及可选`settings.json`事实hook；桌面与远程模式分别核对 |
| VS Code Copilot Agent | 当前VS Code用户profile中的`mcp.json`与`~/.copilot/skills/galaxy` |
| Copilot CLI | 所选`COPILOT_HOME`的`mcp-config.json`与用户Skill |
| Codex | 所选`CODEX_HOME`的`config.toml`、`~/.agents/skills/galaxy`与可选hooks；直接配置和插件只采用一套连接 |
| Cursor | `~/.cursor/mcp.json`与`~/.cursor/skills/galaxy` |
| Hermes | 所选Hermes目录的`config.yaml`、Skill和事实插件；插件启用由宿主控制 |
| DeepSeek Harness | 所选真实profile的`cordis.patch.yml`与DSH用户Skill；复用原插件组合 |
| 其他宿主 | 已知用户级路径与支持的JSON／TOML格式时使用custom安装；WorkBuddy／TRAE等已有生成材料不代表自动用户级安装或真实宿主验收 |


OpenCode事件仅提示读取当前宿主视图；录制器先提取有限事实并冻结一致快照，再交Go事务去重。宿主没有提供完整版本的来源由本机事务分配观测修订，原时间只表示发生时间，不冒充上游全序；未选原件不会复制或传输完整消息及附件。支持独立整理的宿主在有实质增量的阶段调用用户已选模型，其余宿主由当前 Agent 在正常回合通过 MCP 整理；调用和保存机制见 [经验机制](native-learning.md)。网页接续资料通过普通MCP按需读取，由Agent在原聊天处理。其他宿主按实际事件接口记录，MCP Apps使用compact-app；无Apps时保留同义MCP与聊天操作。

宿主MCP与私有持久通道分别通过薄连接访问共用服务；单个连接结束不关闭服务。连接中断后可以为后续请求重连，不自动重发结果未知的业务操作；本人选择、原操作和回执沿其实际作用域接续，不设固定选择轮数。OpenCode插件的诊断走宿主[公开日志SDK](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/sdk/js/src/v2/gen/sdk.gen.ts)，不向TUI的stdout/stderr打印JSON；缺少日志能力不阻断工作，也不回退污染终端。

既有 Claude `watchHost` 是专用只读驱动的可选兼容路径，不是当前Agent使用房间工具的前提，也不表示默认后台Watch已接通。历史基线中 `galaxy_watch_host_capabilities` 只查询版本/help，缺有效配置证据时 activate 返回 foreground-fallback；该历史结果不能代替现行版验收。普通 `galaxy_watch_check`/`ack` 处理对应关注材料及 Agent 游标；reconcile 的 unknown 不等于原模型已停止。

既有证据包括隔离 OpenCode 的实际 TUI 操作及 Codex/Claude CLI 工具发现；它们使用合成数据或有限发现范围，且须保留其记录的版本／运行内核，不能自动归于现行 Go 发行，也不能扩成所有宿主、桌面 UI、真实模型与后台循环都已验收。

根管理的服务信任是显式选择：`service-config prepare` 的 `--root-pins-file` 与 `--trust-directory` 须成对提供绝对路径，`--network-type` 可选 `official` 或 `hub`。根 pin 文件为 `kid → {publicKeyPem,notBefore,notAfter,revoked}` 的公开 JSON，根信任不会从服务响应自行建立。先在服务信息中明确读取，Go 验证 Manifest 和 keyring、持久化公开信任序列后才采用；回滚、冲突、撤销复活及过期均拒绝。更新采用后使旧内存连接失效，沿原身份重新连接；根 keyring 过期不能继续使用旧会话。静态 `trustedKeys` 配置继续沿原方式工作。

## 本机数据、同步与接续

本机准备与远端连接分别处理。手动加载且缺身份时提供一次实际选择，延后选择会保留。已有同身份/设备/服务的有效连接范围可恢复；明确断开、换身份、换设备/服务使旧连接及迟到结果失效。会话 token 仅在进程内，Native 私钥是用户目录独立 PEM，不能声称具备浏览器不可导出 CryptoKey 的属性；旧身份初升沿用 Genesis，新增设备走批准协议，邮箱不能接管 GUID。

`galaxy_local_work_list/get/pending`、`galaxy_command history`和`galaxy_local_panel`读取本机事实，`galaxy_local_work_summary`保存当前Agent的整理。`pending`及连续覆盖下一段未整理材料的`get`页返回`summaryInput`：`workId`、`expectedRevision`、`throughSequence`和当前身份；上界是本页最后实际返回的观察，不是工作最新序号，空页不生成提交位置。Agent按需要组合读取和整理，无须固定先调用pending。

`SubmitWorkSummary`在原`BEGIN IMMEDIATE`事务中核对owner、摘要修订及准确覆盖窗口，派生上次已整理位置之后到`throughSequence`的全部真实观察ID。`sourceObservationIds`省略、空数组或合法部分列表均可；非空列表作为额外来源，核对属于本工作且不晚于覆盖上界后合并去重保存。每个观察版本保留独立来源，新到或新修订的后续材料继续待整理。模型和execution只记录实际可知来源，摘要不冒充宿主观察，工具完成不自动成为整体成功。四档由`galaxy_local_upload_privacy_get/set`保存：

| 档位 | 上传投影 |
|---|---|
| local-only（默认） | 不上传本机工作资料 |
| history-overview | 类型、角色、时间、结果状态、来源标识及主要版本；不含标题、自由摘要、路径、私人项目名或正文，也不能称匿名 |
| work-content | 另含所选说明、摘要和实际保留材料；有大小/条数窗口及 coverage |
| conversation-archive | 另行启用并选定原会话，才含实际采到的 message/parts；升档不自动全量回填 |

档位只允许数据类型，同步还要选服务、关联账户和具体工作/会话范围；默认不主动上传。凭据始终排除并保类别/位置，白名单投影与输入检查不保证全面匿名化。`galaxy_local_archive_configure/list/export/delete/cleanup` 管理选定原件，可设清理天数；导出报告 coverage/exclusions，不补未采消息或附件。重置身份配置保留独立资料目录。Codex／Claude仅在已选host＋session后读取hook给出的准确transcript路径，核对实际会话，保存原JSONL记录；归档索引用`transcript-record:`明确标示派生来源，不假称宿主消息ID。不识别的格式与未完成尾行保持未覆盖，读取失败不阻断宿主工作。

同步按身份/来源隔离；新工作范围默认只含以后资料，旧资料另选。断网保原操作/快照，云端本人删除不会被旧范围自动恢复，到期快照停止重传，新版本可按有效范围接续。超容量明确未同步，不截断冒充完整；云原会话导出格式 `galaxy-private-conversation-v1` 含实际 session/messages/parts/exclusions/coverage。本机、宿主、云副本删除分别办理。

`galaxy_work_continue`从网页接续链接的服务、同身份、对象和精确版本重读；链接只带定位与返回位置，不复制私人草稿或全聊天。没有当前权限时`current:false,data:null`并保留来源错误，不重放旧正文。

`galaxy_open`打开稳定网页对象并在本机保存原workRef。网页操作后，Agent用原`navigationId`调用`galaxy_return`重读同对象；官网提供的“用自己的AI继续”链接由`galaxy_work_continue`读取所选材料，接着在原聊天处理。接口提供定位、当前可读内容和来源，不管理宿主聊天或未发送草稿。身份或endpoint／website变化后不沿用原归属；方法引用、网页接续和设备接续不记录成功复用。

## 本人选择、设备与关注

正式 Native 的初始化工具在本机准备完成后，若配置了所选服务，会继续调用技术连接；无服务配置的 local-only 工具只办理本机部分。底层 `Store.Initialize` 的本地结果不能替代外层初始化工具最终的 `serviceAccess`。技术连接、持久账户关联与上传选择仍是不同状态，不能让旧 local-only Integration Pack 的说明覆盖正式客户端行为。

状态读取与公开查询按工具支持直接使用；需要本机身份的操作复用已有ID，没有时再初始化。需要本人权限的服务操作通过`galaxy_native_connect`连接所选服务，已有有效连接继续使用。尚无所选设备时，该入口复用身份控制协议登记本机首个控制设备，再完成原绑定与设备会话；已有设备仍使用原连接路径。登记前保存原操作号、设备号与安装号，已签提交结果不明时只查原回执，重启后继续同一操作。`status`／恢复已有连接不代替首次选择，也不创建新身份。官网账户注册沿用现有网站入口。`galaxy_native_connect` 仅办理技术连接；`access={kind:service,state:ready/disconnected}` 表示服务连接状态。需要官网账户功能时使用 `galaxy_native_account_connect` 办理登录与本人关联确认；`officialAccount` 保留持久关联信息，`accountAccess={kind:official-account,state:ready/account-required/unknown}` 单独表示账户访问。`galaxy_identity_account_read` 的 `query` 读取持久关联，`status` 查询已有登录流程。

`addNativeTool`先从原schema建立执行校验器，再对独立发布副本投影。发布副本补出联合对象字段，并将非字符串const／enum表达为兼容的类型、数字界限或允许值说明，oneOf按模型兼容需要投影为anyOf；原JSON值类型不变，实际调用仍经原联合及精确取值校验，操作权限不变。宿主可以按工作所需选择工具；完整工具目录与单次模型调用的实际兼容范围分别说明，不以工具发现成功代替模型使用验收。

新范围优先 MCP elicitation，缺失时开 `127.0.0.1` 随机端口的临时审阅页，显示准确内容/用途/接收者/范围，5分钟失效，按原请求生命周期清理；模型的 confirmed 不算批准，关页不批准。页面只接受精确 loopback Host/Origin，同源 referrer；null/跨源仍拒绝，不为403放宽。共用服务主动退出时停止新调用、清理预览并处理在途回执与保存；单个stdio连接结束只释放该连接，不关闭核心。

`galaxy_identity_web_connect/status` 从原 Native 身份准备受控握手，官网自建设备钥，原设备须本人核对同 GUID/设备/范围后授权；仅交换用途受限公开证明，不跨窗传私钥/token/恢复码。握手180秒，与普通5分钟页不同；弹窗/窗口丢失/关页不表示批准。已登记同 GUID/deviceId/keyId 可复用，新增远端批准不自动替换网页当前设备，须本人采用。恢复坐标为requestId/handoffId与设备journal，存在未决授权时禁用设备复用途径。

设备工具 `galaxy_identity_device_native_read` 的 current/list/pending/reconcile 只核对，prepare_revoke 登记未签挑战并给进程内 previewId，confirm 再经真实选择。控制版本/期限/连接变化重核；撤销只作用所选服务、拒绝目标旧连接，不删除数据或声称全网撤销。最后管理设备须已登记恢复依据才可自撤，登记不证明本人仍持有码。stop_retry 只停止本机继续提交，已签未知操作保留，不等于服务取消。

Native 身份恢复码的当前源码入口是 `galaxy_identity_recovery`：`set` 为当前身份准备新码，`recover` 打开原码输入页，`resume` 以原 `operationId` 接续未完成操作。工具只返回临时本机页面定位，恢复码仅由本人在该页输入或查看，不放入工具参数、工具结果或公开配置。恢复在所选服务的同一 GUID 上执行控制操作，会撤销该服务原设备与绑定、选择新设备并轮换下一代恢复码；本人须在本机保存并确认新码，重新连接另行选择。它不自动恢复历史私有内容或本机资料。页面十分钟有效，关闭或过期不代表服务操作取消；结果未知先查询原回执，只有服务仍记录为待提交时，才可由本人确认重试原签名字节。此流程本机定向联测已通过，不能据源码接线推断所有宿主与平台验收通过。

关注需当前房间 Agent grant、用途和结束时间；当前Agent可按任务使用 check/ack/stop，nextCheckAt 是读取时机提示，不代表已启动专用后台作业。绑定变更停止旧关注，不复制权限；本机保存定位并重读来源，人类已读与 Agent 游标分开。无事件不调用模型；停用 grant 不等于宿主原模型进程已停止。

## 协作能力与实际覆盖

| 能力 | 当前源码事实 | 仍需完成或明确的范围 |
|---|---|---|
| 自然求助 | Skill／宿主上下文说明实际受阻入口；help 工具从业务字段准备独立请求，经原选择发布，读取请求及评论后接回原工作 | 自然触发仍由当前 Agent 判断，不承诺每个模型或宿主都会正确采用；具体已验范围见 WORK_STATUS |
| 经验使用 | 原 SQLite FTS5、完整读取及修订；共用查询准备对整段请求去重、覆盖不同位置，条件作为相关线索 | 仍是词面召回，未部署语义索引；未检索、无结果和读取失败分别表达，见[经验机制](native-learning.md#再次使用保存之后必须有真正消费者) |
| 参与者发现 | 独立参与者查询汇合可读 Profile、Project、Builder 与 Recruitment，返回来源、匹配依据及实际联系状态，无项目也可查询 | 有限来源扫描分页，不是全库语义排名；接受本次工作、专业能力和当前可调用性不凭声明推定，见[发现适配](discovery.md#参与者发现与内容推荐的区别) |
| 人与 Agent 混合房间 | `go/internal/chat` 维护成员、父房间、Agent grant 及消息作者，区分读取、起草和回复 | 有业务基础不代表全部宿主连续协作已经实测；普通 MCP 房间参与不要求 A2A |
| A2A 调用 | 已配置或从 Builder 实际 AgentCard 解析对端；以本机工作、独立请求或既有 Case／Attempt 为来源，保留原 Task 多轮接续 | 当前为 JSON 请求／响应，未接流式／推送或通用宿主自动唤醒；配置见下节 |

通用中间件提供渠道与可靠操作，用户的 Agent 决定如何组织工作。原专用 `watch-driver-*` 的 Codex／Claude 路径仍是受限分析驱动，不代表已接通使用宿主工作区工具的通用持续协作，也不限制前台 Agent 正常使用 MCP。共用服务存活不等于宿主模型在执行。需要扩展时应按既有委托与宿主能力接通，不把旧驱动限制扩大成产品规则。

## A2A 与已选 Worker Pack

当前 Native 传输只接收经公网地址检查的 HTTPS 443 对端，使用 JSON 请求／响应，支持 SendMessage、GetTask、CancelTask；不据上游 SDK 能力宣称已接流式或推送。来源可以是真实本机工作、当前可读请求或既有 Case／Attempt。Message 保留完整往返，Task 按原 taskId／contextId 接续；非终态可继续补充，协议完成与用户目标完成分别记录。这不是普通房间参与的前置条件，也尚未覆盖局域网／离线组织协作。登记 AgentCard 或安装 MCP 不会自动把当前宿主变成对外 A2A 服务；协议探测不证明专业能力或接单可用性。

没有预配 `a2a.peers` 时仍可通过 `galaxy_a2a_resolve({builderId})` 读取当前 Builder 的实际 AgentCard。解析区分公开可调用、需要认证和协议不兼容；未满足认证时不发送。已配置 peer 保留精确 endpoint／tenant、peerPrincipal、AgentCard、卡摘要及信任期限；解析产生的非秘密元数据随原关联保存，重启后可读取原 Task。仅接受实际支持的 A2A1.0 JSONRPC 接口，不自动借用官网账户凭据或更新接口。

authentication默认none，或用`bearer-environment`指定该peer的`GALAXY_A2A_PEER_<名称>_TOKEN`；Go传输实际调用时读取，缺失不降匿名、不借Official token。不支持OAuth、任意headers和自动凭据发现。prepare／execute沿原业务选择，对端状态保持peer-reported。当前业务入口是`go/internal/native/a2a-*.go`与`worker-*.go`，公网请求复用`go/internal/publicfetch`；原自定义JS SDK不再作为运行入口或Go实现的比较基准。

`workerPacks.workers` 固定已有 peer 与真实 pack（builderId/manifestId/manifestHash、sourceHash/version），id 为1—80字母数字/下划线/连字符，最多32项。不接受 shell、下载地址或模型程序路径，不安装启动任意程序。`galaxy_worker_host_read/prepare/execute/abort_local` 需准确可读 Attempt/Configuration/用途，执行经原预览/本人选择；面板自动轮询进度及回执。对端Task、participant-reported Result与PackUse保留独立关联和记录，abort_local只结束本地等待，远端CancelTask另行确认。当前回归分别核对 Go 执行与宿主协议；受控协议端不等于外部 Worker 或真实宿主平台验收。

第三方`@a2a-js/sdk` 1.1.0独立固定在[参考Worker](../../integrations/reference-worker-pack/README.md)的`package.json`和锁中，用于真实独立协议端及相应Go互通夹具。该Worker是可选算术参考，Node进程不会被普通客户端安装自动启动。它保留第三方协议解析与服务端SDK，不恢复银河自定义的JS journal、事实判断或宿主业务流程；SDK协议互通不代表独立Worker供给或真实模型任务已验收。

## 核心求助与协作的实施设计

**2026-11-06 实施结构。** 主要入口、独立请求及默认持续开放已经用户确认；实现及实际检查进展集中在 WORK_STATUS。保留 Go Native／MCP、现有业务服务和各宿主界面；不另建 Agent 引擎，也不把能力组合写成强制流水线。下列工程安排不增加用户业务要求。

### 共同结构与数据归属

```text
用户在原 Agent 工作
  ├─ 宿主薄适配：实际消息、尝试、环境、模型及原工作定位
  ├─ Skill／短上下文：让当前 Agent 知道银河何时有用
  └─ 当前 Agent 按需选择（可组合，不要求依次执行）
       ├─ 读本机经验／查公开资料 → 继续原工作
       ├─ 发现人、组织、Agent、工具 → 读依据／联系
       └─ 用户同意对外求助 → 独立请求及实际回应
                                    ├─ 直接给出建议或材料
                                    ├─ 按需进入人＋Agent 的房间
                                    └─ 适合时接入对方 A2A 能力
                         有用进展 → 当前 Agent 继续原工作
                         有价值的经验 → 按既有选择保留、修订
```

本机沿用原身份、工作、会话定位、经验与原操作记录；线上请求沿用 Task v2 的独立请求、评论和进展能力。HelpSession 只承担需要持久接续时的本地关联，不能成为每次公开搜索或读取的前置步骤。候选、已联系、对方回应与已执行结果分别保存，不再复制一份相互竞争的工作状态。查询或打开网页不自动发布、建房间或启动模型。

Help 的普通查询、刷新和返回只附会话定位及状态，不重复传入累积查询、依据和方案；完整进度由既有 get 按需读取。prepare 已返回预览，常规路径直接继续 execute，独立 preview 用于恢复或更新。模型预览只保留一次业务正文及执行引用，原始签名字节由原操作保存。A2A purpose 同样只呈当前结果和必要接续定位，完整历史仍可通过低层 get 取得；当前来源由共用读取核对一次，身份变化后的限制保持。

### 自然触发与上下文

- 共用能力说明突出“实际尝试仍受阻时可以从银河获得帮助”，保留主动评审、资料、项目和兴趣等入口。修改 Skill 与短上下文的过泛导向，不设置失败次数、固定轮数或所有任务必查银河的规则。
- 当前 Agent 判断是否需要外部帮助；宿主提供真实可用的当前请求、工具结果及原工作定位。错误和尝试可以作为事实，单个工具失败、模型重试或缺少某段历史不直接成为求助决定。
- 区分原任务、后台经验整理、标题生成和上下文压缩，不把辅助模型调用当成新的用户工作、失败或对外求助意图；不让经验整理递归触发另一轮整理与求助。
- `integrations/host-adapters/shared` 集中维护能力说明与必要状态投影；OpenCode 的 `prompt/context`、其他宿主的实际 hook／Skill 使用同一语义。只更新当前范围，不把旧说明、全部工具正文和历史逐轮追加到上下文。
- 返回资料始终关联原宿主／会话／工作及当前 ID。宿主支持的事件可以提示有新回应；不支持时由当前 Agent 经 MCP 读取。网页返回不自动填充聊天输入、改写草稿或触发下一轮模型。

### 经验检索与参与者发现

经验继续沿 `work-history/history.sqlite`、`work-experience*.go` 和既有检索工具，不先部署新的向量数据库。当前宿主直接发送整段问题的预取方式改为共用查询准备：优先采用实际当前问题的简短表达及必要标识；日志、代码和重复历史不整段作为搜索词。无法可靠准备查询时保留未检索状态，让当前 Agent 用正常工具表达查询，不能返回空列表冒充没有经验。普通模型推理中可形成同义表达，不为每条消息单独启动一个“查询规划模型”。

FTS 负责候选召回，当前 Agent 读候选正文与形成依据、判断适用性。环境条件区分明确必需条件与相关性线索，不把自由条件整句作为必须命中的字符串。保留请求代次、经验修订去重及迟到结果隔离；统一表达成功有结果、成功无结果、未读取与实际失败。相近表达仍漏匹配时，再根据实际漏例评估语义索引，不声称模型重排能找回未召回的资料。具体经验保存规则仍见[经验机制](native-learning.md)。

参与者发现复用 `opportunities`、`searchv2`、Builder 声明、公开资料及可读履历。内容推荐与找专家分别投影，不能直接把 Gorse 内容推荐当作专家匹配。现有机会标签匹配保持原用途；补充按当前问题查人、组织、Agent 与工具的入口，不要求用户先登记一个项目。公开可读、愿意被联系、接受本次工作、当前可调用四种事实分别呈现。

第一版由程序召回可读候选、当前 Agent 结合目标和依据比较；需要文本索引时复用已有搜索服务，仍由 Go 裁剪可读范围。私有本机经验不上传给公共专家索引，不把私聊、举报材料用于公开匹配。已有社区成长／权重设计按所属模块衔接，本轮不自建通用信誉分，也不以缺少银河历史排除新参与者。

### 独立请求、回应与页面

复用 `go/internal/taskmaterials` 的 Task v2、`comments.go`、请求进展及现有 `features/tasks` 页面。请求可以没有 Case、项目或正式 Participation，正文、回应和更新直接可用；正式承接保留为需要时使用的已有能力。发布前只说明实际请求内容、可见范围与外发材料，代码负责原操作号、精确载荷和签名，Agent 不再手工拼接协议 JSON。沿现有 help／task 入口补业务字段准备能力，不再平行增加另一套发布流程。

普通求助的创建、列表、发布编辑与进展采用可选截止时间，未设期限持续开放；管理页可后设期限或移除期限，已有数字期限仍按原业务延长。旧请求原有期限、签名及回执不重写，不补无限远日期。账户评论所需结构统一登记在数据库迁移148，业务Task仍保存原结构。

请求评论已有实现，优先接通而非复制论坛评论。独立请求可关联社区讨论；不自动为每个请求发论坛帖或创建房间。页面以问题、已尝试内容、回应和实际进展为主，正式分工和交付信息按需要展开。请求背景组件已接既有查询／事件机制：临时错误保留当前可读内容，新内容就绪后局部更新，真实失权仍隐藏相应背景。

**已确认的账户回复：** 用户于 2026-11-06 确认，官网人类用户登录在线账户即可直接回复独立求助建议，不要求先安装客户端或关联本机 ID；正式承接和代执行按各自要求办理。当前源码通过独立账户入口复用既有会话、评论内容、分页、进展及治理；账户作者可修改、更正、撤回和申诉自己的评论。账户与设备主体作者分别记录，既有 ID 评论保留原归属，不生成虚构 GUID，不借管理员身份签发。写入核对当前请求可见与参与范围、账户状态及实际正文，程序关联原操作与结果。允许普通回复不顺带授予请求者私有背景、设备控制、正式参与或执行权限。

### 混合房间、回应接回与 A2A

复用 `go/internal/chat` 的成员关系、Agent grant、消息作者、邀请与通知。人类可在网页回应，Agent 可用 MCP 参与同一房间，不新增只允许 AI 的协作主路径。当前工作只保存所选请求、房间及原会话关联和读取位置；回复到达不代替对方承诺，不把接收消息写成问题已解决。

持续参与采用当前宿主实际支持的模型执行方式。新的明确委托按既有用户选择使用宿主已有工具和权限，不能继续把旧分析驱动的“禁止工作区工具”限制当作通用协作规则；同样不能因共用服务存活就声称 Agent 仍在工作。后台不可运行的宿主保留供下一次 MCP 读取的进展，不伪造自动唤醒或向原聊天注入输入。

A2A 适配按“可用对端、当前工作、必要输入、协议会话与原操作”组织。已配置对端仍可直接使用；从 Builder／目录发现的服务，由程序读取和核对实际 AgentCard、接口及认证要求，用户只需理解联系谁、做什么、带哪些内容。公开声明不自动成为可执行对端。优先评估复用已研究的官方 Go SDK 收束重复传输，保留银河自己的身份、业务许可和操作记录。

协议 Message、外部 Task、银河独立请求和内部 Case／Attempt 各有含义。简单往返可返回 Message，长工作按协议 Task 接续；不为发一条消息补造 Case／Attempt。需要放宽当前关联限制时，应为真实本机工作／已选请求增加来源适配，保留原授权和结果归属，不能仅删除检查。原正式工作已有 Case／Attempt 时继续关联。公网调用与企业内网／离线部署分别处理实际网络和认证配置，首批公网接线不冒充完整企业覆盖。

### 实施批次与必要检查

| 批次 | 修改归属 | 可观察交付 |
|---|---|---|
| 1．原工作取得帮助 | 共用 Skill／上下文、Native 经验／help、Task 发布／评论、请求主页面 | 在原 Agent 实际受阻后，按用户选择发布独立请求；取得真实回应并用 MCP 接回原工作。包含长请求、默认无期限及原操作接续，不以草稿或候选出现作完成 |
| 2．相关帮助与混合参与 | Go 发现投影、可读候选、现有请求／房间及宿主通知 | 可以按当前需要发现人或 Agent、解释依据、联系及共同交流；不强制正式承接，不把未知意愿写成愿意合作 |
| 3．A2A 实际工作 | Native A2A 适配、实际对端、当前工作来源及结果读取 | 从选择可用服务到真实输入／输出、多轮补充、必要取消和原工作继续；普通房间路径独立成立 |
| 4．宿主与发行收束 | 同一 Go 核心、各薄适配、安装 Skill 与发行材料 | 共用能力在支持宿主交付；界面与唤醒差异准确说明，退出已被替代且无消费者的旧路径 |

第 1 批使用已有覆盖最强的 OpenCode V2 观察自然触发及完整接续，但共同能力从开始就放在 Go／MCP／共享说明中，不开发成 OpenCode 专用产品。随后按实际宿主能力接通；MCP 工具可用与宿主自动发现／后台执行分别验收。

每批形成完整成果后集中做必要真实模型与独立无头流程检查。覆盖普通工作无需求助、真实受阻后求助、拒绝后继续原工作、长问题检索、直接回应、混合参与及未知写入不重复；不规定模型必须调用几次或必须选哪条帮助路径。协议互通检查与真实协作结果分开。尚需用户决定的仅是新增使用方式或权限变化，不把工程参数逐项变成用户选择题。

## 系统提醒与平台范围

提醒默认关闭，重启重新明确启用；status 不开进程/定时器/模型，enable 经选择后每60秒查收件箱，disable/断开/退出清理。配置只含 `hostNotifications.kind`（linux-freedesktop/windows-notify-icon/macos-user-notifications）与可选绝对 command，不接受 enabled、参数、脚本或正文。省略时按 OS 选择通道，缺依赖保前台入口，不自动安装或启动 session bus。

Windows 固定 NotifyIcon 仅收到 BalloonTipShown 才记观察到展示。Linux 用同用户本地 Unix D-Bus/Python3/PyGObject/GIO，helper 仅收模式和数量，不收私有标题/正文/URL/收件人/对象ID；Notify 返回仅受理，`displayed:false`。固定服务唯一名称/通知ID撤回不重连猜测，未知尝试重启不重发。Windows 中的 Linux 检查使用受控 Node 替身，不是实体 Linux 桌面验收。

macOS保留helper源码及可选预编译App的整包准备入口；尚无对应机器的编译、签名、公证与真实桌面验收。command 必须为 `.../GalaxyNotifications.app/Contents/MacOS/GalaxyNotifications`，不退 AppleScript。已有 macOS SDK 时可用源码 `notifications/macos-helper/build.mjs` 向新绝对目录构建，仍不签名/安装/启动。permission 工具每次独立本人选择，仅未决定时请求系统 alert 权限；普通 status/enable 不弹窗，也不标已读。UNUserNotificationCenter.add 仅受理、展示未知；撤回请求与之后观察列表消失分开。Swift 编译、真实 Notification Center 和发行适用性需对应机器验证。

安装和维护命令在交互终端输出简明结果；脚本可使用 `--json` 明确请求机器可读结果，非交互输出保留原有 JSON 格式。`galaxy version` 或 `galaxy --version` 显示该客户端包的版本。`setup` 自动预检并应用用户请求的配置；只有无法确定宿主时才询问宿主选择，内部校验和配置细节由程序处理。
