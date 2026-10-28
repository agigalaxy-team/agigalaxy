# Go core 发行与运行接线

此目录提供 Go 产物的构建和直接运行接线。`go-core-artifact.json` 记录实际入口、目标平台及文件摘要；正式 Go release 与本地 candidate 使用不同 kind，旧 Node `service-release` 部署器不接受这两种 Go 格式。构建不启动服务、不迁移数据库、不采用旧队列、不修改正式安装。实际部署仍按选定产物和当前进程配置办理。

在源码根目录构建新的绝对候选目录，例如：

```powershell
node scripts/build-go-core.mjs --output C:/absolute/new-go-candidate --go C:/absolute/go.exe --release go-core-local-1 --configuration-version local-1
```

正式 Hub 发行在同一构建口显式选择 `release` 模式。Linux x86_64 服务器示例：

```sh
node scripts/build-go-core.mjs --output /absolute/new-go-release --release go-VERSION --configuration-version CONFIGURATION --mode release --goos linux --goarch amd64 --without-native
```

缺省模式仍是 `candidate`。正式模式输出 `kind: galaxy-go-core-release`、`mode: release`，不会把 `migrationComplete`、`deployed`、`defaultInstallationChanged` 改成 true；这些构建观察不代表已经切换或完成平台验收。`publicRelease:false` 表示该构建没有创建 GitHub Release，不表示源代码必须非公开。GitHub 源码公开与实际服务激活是独立操作。构建输出中的 `manifestSha256` 对应完整 `go-core-artifact.json` 字节，供原 `GALAXY_RELEASE_SHA256` 引用。

`--go` 可省略，缺省通过 PATH 直接执行 `go`；也可指定命令名或编译器绝对路径。可用 `--goos linux --goarch amd64` 选择目标，或 `--without-native` 只构建服务程序。跨平台编译不表示目标平台运行已验收。默认 Native 使用既有 Go Native builder，保留独立 `native/` 包内宿主依赖；构建机须已有该 builder 的依赖。脚本固定 `-mod=readonly`，不修改模块锁。

## 运行与配置发现

产物根目录包含 `galaxy-api`、`galaxy-worker`、`galaxy-information-worker`、`galaxy-publisher`、`galaxy-migrate`、`galaxy-lifecycle`（Windows 使用 `.exe`）。原 Go 邮件模板和内部 SQL/JSON 已嵌入对应二进制；`public-docs.json` 放在 API 二进制旁，或用绝对 `GALAXY_PUBLIC_DOCS_FILE` 指定。配置、凭据、签名钥和运行数据都不在包内。

这里的 systemd 文件是通用运行样例。把 `ExecStart` 中的 `go-REPLACE_VERSION` 替换为已选的不可变发行目录；不要把 Go 程序放回旧 Node 发行命名空间。保留实际进程用户、group、supplementary groups、现有受保护环境文件和 `LoadCredential`。不经过 shell 展开 credentials 路径，不用 API 环境覆盖 Worker 或 Publisher 环境。

每个进程沿原三项引用绑定发行：`GALAXY_RELEASE_DIRECTORY`、`GALAXY_RELEASE_SHA256`、`GALAXY_CONFIGURATION_VERSION`，示例值见 `release.env.example`。它们应合入既有角色环境文件，而不是增加一个自动加载的配置体系。Go 在启动时核对 pin、完整文件 inventory、目标平台、配置版本以及当前二进制是否属于该角色；同一 manifest 的 API 程序不能冒充 Worker。实际 systemd `ExecStart` 使用同目录下的 Go 程序，不调用 Node service-release host。

各环境文件独立，保留既有数据库角色：

| 进程 | 环境文件 | 数据库/身份边界 |
|---|---|---|
| API | `/etc/galaxy/api.env` | 原 API 角色、原账户与管理门户配置及设备签名配置 |
| Worker | `/etc/galaxy/worker.env` | 原受限 Worker 角色、其实际作业配置 |
| Information Worker | `/etc/galaxy/information-worker.env` | 同库两池：API 源读取与独立受限 Worker River 传输；无管理 Cookie、无设备签名私钥 |
| Publisher | `/etc/galaxy/publisher.env` | 原 Publisher 连接、内容发布配置及原发布权限配置 |

Information 的环境变量名见 `information-worker.env.example`，只复用现有配置文件引用。API、普通 Worker、Publisher 的完整条件配置以各 Go owning loader 和已批准配置为准；这里不制造一份全部填好的通用配置。缺失配置、未登记政策/服务版本、未采用 River 或源不可用应保留原错误。政策采用实例仅报告本进程实际政策，不代表总 API readiness。

普通 Worker 和 Information Worker 都使用 runtime log 的 `worker` component，必须用不同 `GALAXY_RUNTIME_LOG_INSTANCE`。样例分别固定为 `primary` 与 `information`，避免共写同一轮转文件。修改实例名时同时核对路径，不能给两个进程相同实例。SIGTERM 由各命令原停止流程接收，Information 停止会收尾队列、源政策刷新和 Chat transport。

当前部署实例（2026-10-28 实机读取）为 Linux x86_64：API 是 `galaxy-api@pilot.service`，沿 `galaxy-api-pilot` 用户/group 和 `/etc/galaxy/pilot/api.env`、`api-workflow-release.env`；Worker 是 `galaxy-worker@pilot.service`，沿 `galaxy-worker-pilot` 与 `/etc/galaxy/pilot/worker.env`；Publisher 是 `galaxy-content-publisher-pilot.service`，沿 `galaxy-content-publisher-pilot` 用户、`galaxy-site-public` group 及 `galaxy-content-publisher-pilot`、`galaxy-site-publisher`、`galaxy-cms-media-readers` supplementary groups，环境文件为 `/etc/galaxy/operations-pilot/publisher/publisher.env`。三者已有 systemd credentials。选定 Go 目录使用 `/opt/galaxy/releases/go-<version>`，工作目录保留 `/opt/galaxy`；这只是当前实例，不是以后部署的固定命名规则。Information Worker 已作为 `galaxy-information-worker-pilot.service` 独立运行，使用专属 Unix 用户及现有 API／Worker 数据库账户的受限基础角色，配置为 `/etc/galaxy/pilot/go-information.env`；不加载 API 签名私钥或门户 Cookie。Go 的最后生效覆盖文件为各角色的 `go-*.env`，旧发行环境不会盖过该配置。Next 网站、后台 Next/Payload 及专业组件保持独立进程和入口。

## 显式维护入口

`galaxy-migrate business-up` 承接原业务 schema 的初始化和升级，沿用原 SQL、`schema_migrations` 和事务锁；可显式附加 `--roles=api,worker,deletion-review,content-publisher` 中所需角色，省略时不设置角色。`--help` 同时列出 jobs/storage 技术迁移及角色供应动作。服务启动不执行这些命令，也不自动采用旧 Node 任务。迁移和队列切换另行安排，并停止旧领取者，再沿原业务 ID/回执接续；不能同时让 Node 与 Go 领取同一工作。

旧 pg-boss 工作由显式 `jobs-adopt --endpoint URL --ids-file ABS_JSON` 接手选定的未领取原 UUID；`jobs-adopt-schedule --endpoint URL --key messaging:PLAN_UUID` 接手一份原消息周期定义，按实际旧时间槽避免重复。两者都不启用 River，也不导入已发出或结果未知的工作。停旧进程须包括旧 API 内的信息订阅领取、Worker 和独立 Publisher；Go 的队列配置不能证明旧进程已停止。Evidence／CI／Probe／搜索的原自有 jobs 表沿原 lease 和 ID 接续，不混入 pg-boss 导入。

`galaxy-lifecycle` 保留原 `review`、`execute`、`minimize` 及 `ledger capture|validate|replay`。这些是显式维护命令，不应安装为常驻服务。使用原维护连接与已批准命令；不要给维护进程加载 API 签名材料。DB 执行回执不表示外部对象、备份和全站物理删除已完成，未知外部结果仍查原对象/操作。

Native 入口为 `native/galaxy native`，使用明确的 `GALAXY_NATIVE_CONFIG`；宿主安装与平台限制见该子包 README。不要用新建身份、覆盖数据目录或重发操作处理升级/未知回执。

Native 平台资源由同一个 `buildGoNativeCandidate` 构建口复制，独立 Native 候选和 core 内的 `native/` 使用相同布局。Windows 原 helper 位于二进制同级的 `notifications/windows-notify-icon.ps1`，不要单独搬走可执行文件；实际 PowerShell 命令仍来自显式可信配置。Linux 原 Python helper 嵌入 Go，目标机须有选定的 Python（缺省 `/usr/bin/python3`）。macOS 继续要求显式配置已签名 `GalaxyNotifications.app/Contents/MacOS/GalaxyNotifications`，候选不自动构建、签名、安装或选择 App。复制资源不启用通知，也不证明目标平台通知已验收。包内 `native-v2.json` 的资源归属及 root `go-core-artifact.json` 文件摘要对应实际候选；Native 子包仍如实保留其本机平台验收状态，root manifest 也不从构建推断 `migrationComplete:true`。

## AI Agent 部署核对

沿选定 Go manifest 的 pin、目标平台、原配置引用和数据库角色运行。构建完成只说明编译和资源打包完成；平台、专业组件、业务接续和激活结果以实际运行观察为准。发生未知结果继续核对原操作，不重发旧工作。银河自有代码统一采用 Apache-2.0；产物根目录的 `LICENSE` 和 `NOTICE` 从源码根目录逐字节复制并纳入文件 inventory。构建观察单列在 `BUILD_INFO.txt`，不会覆盖项目 `NOTICE`。第三方继续遵循各自原许可证；实际 Go 依赖许可文本位于 `third-party-licenses/`，缺失项在清单中明确记录。

## 独立 Information Worker 的 Prosody 接线

API 与独立 Information Worker 不能使用同一 XEP-0114 component 身份建立各自的连接。Go factory 已按各进程的 `GALAXY_CHAT_CONFIG_FILE` 读取独立配置，不需要更换二进制；Information Worker 使用 `information-chat.json.example` 的字段形状，将 `service` 和 `roomsDomain` 保持为实际既有值，仅选择独立 component domain 与 secret 引用。

在原 Prosody 配置的外部 component 区域增加一份独立定义，例如：

```lua
Component "information.galaxy.internal"
 local information_key = Lua.assert(Lua.io.open("/etc/prosody/information-component.key", "r"));
 component_secret = information_key:read("*a"):gsub("%s+$", ""); information_key:close();
```

在**现有** MUC Component 配置块内增加以下值，不另建 MUC 或 archive，不替换主 `galaxy_gateway_host`：

```lua
 galaxy_reader_gateway_hosts = { "information.galaxy.internal" };
```

`mod_galaxy_rooms_v2.lua` 默认空集合，保留原主 gateway 行为。附加 reader 仅接受 `project` 与 `read`；`send`、`edit`、`erase`、`export-own` 等动作仍拒绝。`project` 是原 `ReadSelectedWithin` 的必要前置步骤：Go 先做原设备、当前房间成员、消息版本、有效期和治理权限检查，再同步数据库当前的 revision/members/state/title，随后读同一个 MAM archive。投影的成员 JID 仍由主 gateway 域构造，不能改成 reader 域；读取后 Go 原晚到权限检查也保留。原 read 中的到期内容处理不变。

Prosody 与该 Info component 配置应使用同一份 **Info 专用** secret，但不要与 API 主 gateway 共用 secret，否则 reader 凭据仍可用于主 gateway 握手。Go 的 `secretFile` 指向该进程可读、权限仅属该进程的实际私密文件或 systemd credential 路径；Prosody 使用自己的对应受保护挂载路径。示例文件名不是新的凭据值，也不改变已有门户、device、账户、房间或数据库权限。部署时由原运维流程新增 component 配置并重载 Prosody，再启动独立 Info 进程；不启动第二个 API domain 连接来试探。
