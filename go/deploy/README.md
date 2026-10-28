# Go core 开发候选运行样例

此目录是候选运行接线说明，不是完整 Go 发行版或生产切换授权。构建不启动服务、不迁移数据库、不采用旧队列、不修改正式安装。`go-core-artifact.json` 记录实际入口、目标平台及文件摘要；旧 Node `service-release` 部署器不能直接使用它。

在源码根目录构建新的绝对候选目录，例如：

```powershell
node scripts/build-go-core.mjs --output C:/absolute/new-go-candidate --go C:/absolute/go.exe --release go-core-local-1 --configuration-version local-1
```

`--go` 可省略，缺省通过 PATH 直接执行 `go`；也可指定命令名或编译器绝对路径。可用 `--goos linux --goarch amd64` 选择目标，或 `--without-native` 只构建服务程序。跨平台编译不表示目标平台运行已验收。默认 Native 使用既有 Go Native builder，保留独立 `native/` 包内宿主依赖；构建机须已有该 builder 的依赖。脚本固定 `-mod=readonly`，不修改模块锁。

## 运行与配置发现

候选根目录包含 `galaxy-api`、`galaxy-worker`、`galaxy-information-worker`、`galaxy-publisher`、`galaxy-migrate`、`galaxy-lifecycle`（Windows 使用 `.exe`）。原 Go 邮件模板和内部 SQL/JSON 已嵌入对应二进制；`public-docs.json` 放在 API 二进制旁，或用绝对 `GALAXY_PUBLIC_DOCS_FILE` 指定。配置、凭据、签名钥和运行数据都不在包内。

这里的 systemd 文件只是进程运行样例，路径、用户和受保护环境文件须由部署负责人明确配置。不要直接批量 enable/start。各环境文件独立，保留既有数据库角色：

| 进程 | 环境文件 | 数据库/身份边界 |
|---|---|---|
| API | `/etc/galaxy/api.env` | 原 API 角色、原账户与管理门户配置及设备签名配置 |
| Worker | `/etc/galaxy/worker.env` | 原受限 Worker 角色、其实际作业配置 |
| Information Worker | `/etc/galaxy/information-worker.env` | 同库两池：API 源读取与独立受限 Worker River 传输；无管理 Cookie、无设备签名私钥 |
| Publisher | `/etc/galaxy/publisher.env` | 原 Publisher 连接、内容发布配置及原发布权限配置 |

Information 的环境变量名见 `information-worker.env.example`，只复用现有配置文件引用。API、普通 Worker、Publisher 的完整条件配置以各 Go owning loader 和已批准配置为准；这里不制造一份全部填好的通用配置。缺失配置、未登记政策/服务版本、未采用 River 或源不可用应保留原错误。政策采用实例仅报告本进程实际政策，不代表总 API readiness。

普通 Worker 和 Information Worker 都使用 runtime log 的 `worker` component，必须用不同 `GALAXY_RUNTIME_LOG_INSTANCE`。样例分别固定为 `primary` 与 `information`，避免共写同一轮转文件。修改实例名时同时核对路径，不能给两个进程相同实例。SIGTERM 由各命令原停止流程接收，Information 停止会收尾队列、源政策刷新和 Chat transport。

## 显式维护入口

`galaxy-migrate business-up` 承接原业务 schema 的初始化和升级，沿用原 SQL、`schema_migrations` 和事务锁；可显式附加 `--roles=api,worker,deletion-review,content-publisher` 中所需角色，省略时不设置角色。`--help` 同时列出 jobs/storage 技术迁移及角色供应动作。服务启动不执行这些命令，也不自动采用旧 Node 任务。迁移和队列切换另行安排，并停止旧领取者，再沿原业务 ID/回执接续；不能同时让 Node 与 Go 领取同一工作。

旧 pg-boss 工作由显式 `jobs-adopt --endpoint URL --ids-file ABS_JSON` 接手选定的未领取原 UUID；`jobs-adopt-schedule --endpoint URL --key messaging:PLAN_UUID` 接手一份原消息周期定义，按实际旧时间槽避免重复。两者都不启用 River，也不导入已发出或结果未知的工作。停旧进程须包括旧 API 内的信息订阅领取、Worker 和独立 Publisher；Go 的队列配置不能证明旧进程已停止。Evidence／CI／Probe／搜索的原自有 jobs 表沿原 lease 和 ID 接续，不混入 pg-boss 导入。

`galaxy-lifecycle` 保留原 `review`、`execute`、`minimize` 及 `ledger capture|validate|replay`。这些是显式维护命令，不应安装为常驻服务。使用原维护连接与已批准命令；不要给维护进程加载 API 签名材料。DB 执行回执不表示外部对象、备份和全站物理删除已完成，未知外部结果仍查原对象/操作。

Native 入口为 `native/galaxy native`，使用明确的 `GALAXY_NATIVE_CONFIG`；宿主安装与平台限制见该子包 README。不要用新建身份、覆盖数据目录或重发操作处理升级/未知回执。

Native 平台资源由同一个 `buildGoNativeCandidate` 构建口复制，独立 Native 候选和 core 内的 `native/` 使用相同布局。Windows 原 helper 位于二进制同级的 `notifications/windows-notify-icon.ps1`，不要单独搬走可执行文件；实际 PowerShell 命令仍来自显式可信配置。Linux 原 Python helper 嵌入 Go，目标机须有选定的 Python（缺省 `/usr/bin/python3`）。macOS 继续要求显式配置已签名 `GalaxyNotifications.app/Contents/MacOS/GalaxyNotifications`，候选不自动构建、签名、安装或选择 App。复制资源不启用通知，也不证明目标平台通知已验收。包内 `native-v2.json` 的资源归属及 root `go-core-artifact.json` 文件摘要对应实际候选；两者均保留开发候选状态，`migrationComplete:false`。

## AI Agent 部署核对

先发现选定候选清单、目标平台、原配置引用和数据库角色，核对实际文件 SHA-256，再安排隔离启动与实际入口检查。构建成功只证明编译和资源打包完成，不证明配置有效、专业组件在线、平台功能、业务迁移或生产就绪。正式安装器、旧部署器迁出及 Hub 公开发行许可仍待后续统一处理；本包没有授予未公开服务代码的新许可。实际 Go 依赖许可文本位于 `third-party-licenses/`，缺失项在清单中明确记录。
