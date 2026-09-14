<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/de/de13799554a7be80cdb9bc5f29cf9df79148ce5944be9ac4af1a39e1485064d5.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Linux 运行准备 v1

2026-09-11当前实施：同机Linux的local/pilot已完成独立材料、用户和数据库安装；三环境隔离通过，local启动及keyring刷新再启动通过。全部数据库/API/Worker现已停止；pilot运营字段待补、业务未启动、公开信任未发布。不是Windows本机Linux服务，也不是三个独立故障域。[当前操作与证据](isolated-environment-operations-v1.md)。以下保留各早期批次记录，未配置/未应用等描述只代表其当时状态。

2026-09-11模板更新：准备入口新增 local，并补齐三套独立运行策略和可选公开设置。新候选共43文件；API/Worker分别引用自己的环境策略，未提供运营信息时保留缺项。旧四参数调用仍有效，第五参数可提供设置文件。新候选没有应用到服务器，下文已实施 integration 与未实施 pilot 的边界不变。三环境端口、文件及用法见[运行模板说明](runtime-template-settings-v1.md)。

2026-09-11新增：保留实际官网配置的完整Official代理候选已在目标机生成，并以Caddy服务用户校验通过。systemd覆盖也已准备但未安装；Caddy PID和原配置不变，DNS未改。候选路径、摘要和首切/回退见[公开代理候选](pilot-proxy-candidate-v1.md)。

2026-09-11私有integration：已安装监控并验证四目标/22规则、启停及历史保留；已运行restic定时备份、Schema41/44表7文件隔离恢复与API备份状态采集。最终停止，异地仓库和真实通知未配置。当前路径、版本和限制见[运行说明](integration-operations-v1.md)。

2026-09-11当前发行：integration 已安装并选中 `official-2026.09.11-cost`（363文件，Schema41，清单SHA256 `2f200f5a140c0c56b1455a061a0992014eda19cd50210f98a00873a820f1743b`）。实际费用进入API和Prometheus，新→drain旧版→新三次启动均通过，9张选定事实/授权表摘要不变。最终API/Worker/数据库及依赖监控、备份timer停止；旧drain和schema发行保留。具体费用归属、配置及回退见[私有费用接线](integration-cost-v1.md)。

选定主机的 `/opt/galaxy/operations/integration-release.mjs` 统一发现三份环境配置中的发行目录、摘要和配置版本。刷新keyring、启动后检查和既有smoke入口均使用当前选择；没有把integration身份转换为公开运营身份。人工启动仍使用 `sudo sh /opt/galaxy/operations/start-integration.sh`，运行验证为 `sudo /opt/galaxy/runtime/node-v24.19.0-linux-x64/bin/node /opt/galaxy/operations/integration-release.mjs verify`。

私有发行切换时先停止API/Worker并启动数据库，再执行上面的Node入口加 `switch official-2026.09.11-drain`（回退）或 `switch official-2026.09.11-cost`（升级），然后运行启动入口与verify。switch复用发行/Schema兼容预检，管理三份环境文件中的三个发行字段，并为cost发行配置API的费用路径、在旧版回退时移除该路径；Worker/迁移不采集费用。原文件保留在 `/etc/galaxy/integration/release-switches/<操作ID>/`，不回退信任序号、不降级数据库、不删除卷。操作中断时保持进程停止，以该备份恢复三份一致配置后再启动；不要打印备份环境内容。

2026-09-11实施补充：Oracle integration 已按本候选完成固定 Node/源码/依赖安装、独立账号与数据库迁移，并通过真实 HTTP 签名绑定/Case/撤销、数据库和进程重启验证。测试结束后服务停止、数据卷保留；pilot 未配置，公开 Official 未发布。目标机现有 `/opt/galaxy/operations/start-integration.sh` 可用既有测试键刷新 keyring 后启动，限定该主机的 integration。首次准备记录和通用模板继续保留在下文。

2026-09-11。C01-02/04 的目标配置与操作说明；integration 已实施验证，pilot 保留为候选。复用已有 systemd、Docker Compose 与 Caddy：API/Worker 使用主机上的固定 Node；每个环境使用独立 PostgreSQL 容器、数据库、卷和登录角色。API、Worker、迁移也使用不同 Linux 用户。没有引入新的常驻发布控制器。

## 生成准确部署包

在代码仓根运行，所有参数使用绝对路径：

```text
node packages/galaxy-official/scripts/prepare-linux.mjs <已冻结服务发行目录> <manifest-sha256> <Linux运行时pins.json> <全新部署包目录>
```

生成前复用现有发行校验，逐文件核对已冻结源码。输出 integration/pilot 的三类环境文件样例、数据库 Compose、首次登录角色 SQL、精确 Caddy 路由片段、四个 systemd 模板、目录准备和 Node 安装脚本、部署说明 JSON 及文件摘要。生成器只写新目录，不连接服务器、不读取真实凭据、不激活服务。

当前候选固定 Node 24.19.0 linux-x64 压缩包 SHA-256 与 PostgreSQL 18.6 bookworm 的 linux/amd64 镜像摘要。上游返回的摘要记录在独立 pins 文件；安装脚本实际校验下载内容。版本是本项目已测试的候选，未声称最新；目标 integration 的 Linux 程序运行验证见上方实施补充，pilot 仍待实施。

| 项目 | integration | pilot |
|---|---|---|
| 数据库端口（仅 loopback） | 15432 | 15532 |
| API 端口（仅 loopback） | 3101 | 3201 |
| API / Worker 指标端口（仅 loopback） | 9311 / 9312 | 9411 / 9412 |
| 数据库 | galaxy_integration | galaxy_pilot |
| Compose 项目 | galaxy-integration | galaxy-pilot |
| 配置入口 | /etc/galaxy/integration | /etc/galaxy/pilot |
| API 私有目录 | /var/lib/galaxy/api/integration | /var/lib/galaxy/api/pilot |
| API 用户 | galaxy-api-integration | galaxy-api-pilot |
| Worker 用户 | galaxy-worker-integration | galaxy-worker-pilot |
| 迁移用户 | galaxy-migrate-integration | galaxy-migrate-pilot |

integration 使用保留域名 `https://official.integration.invalid`，配合隔离测试入口；不创建公开 DNS。pilot 候选目标为 `https://official.agigalaxy.org`，目前 DNS 未创建。端口不同不代表故障域独立；两套环境仍在同一主机。

## 首次准备和启动顺序

1. 核对目标、部署包摘要及原服务器记录。将已核验包放到单独目录，执行 `sh prepare-layout.sh integration`。它创建限定目录/非登录用户、安装四个单位模板及该环境的 Compose，执行 daemon-reload；不 enable 或 start 任何服务。已有不同单位/Compose 文件会停止，需审阅差异后更新。对 pilot 使用独立命令。Node 只需运行一次 `sh install-node.sh`；已有目标版本目录时停止，不覆盖它。
2. 将固定服务发行安装到 `deployment.json` 指定的 `/opt/galaxy/releases/<release-id>`，目录 root:root 0755，普通源码文件 0644。在该发行 `packages/galaxy-official` 中用固定 Node 所带 npm 执行 `npm ci --ignore-scripts --omit=dev`；为调用 npm 的进程显式设置该 Node 的 PATH。源码与依赖均不允许 API/Worker 用户写入。复制发行不能重新改写 `service-release.json`。
3. 通过已选凭据渠道填入该环境独立的数据库口令和三份环境配置，不在聊天、命令行或报告中展示值。样例不是可启动配置，不要直接复制含 REPLACE 占位值的文件。`api.env`、`worker.env`、`migration.env` 在 `/etc/galaxy/<环境>` 由 root 以 0600 保存，systemd 读取后分别传给进程。数据库 URL 的口令需 URL 编码；`database.password` 是对应迁移数据库账号的原始口令，由容器挂载读取。Compose 的密码文件不是秘密保险库，应保护源文件及 Docker 管理权限。
4. API 使用该环境自己的签名键、根 pins、keyring；签名键由该 API 用户以 0600 持有，公开信任文件也应限制写入。`trust` 子目录和各进程日志目录可写，其他源码/配置在服务中只读。Worker/迁移环境不放 API 签名字段。迁移数据库账号是**该独立 PostgreSQL 集群的初始化管理员**，不能交给 API/Worker 或复用到其他环境。
5. `systemctl start galaxy-database@integration`；Compose 按摘要拉取 PostgreSQL 并等待容器健康。PG18 卷挂载点为 `/var/lib/postgresql`，避免升级后挂错数据目录。`systemctl start galaxy-migration@integration` 显式运行当前固定发行 Schema 与三套 NOLOGIN 权限角色 SQL；失败时按现有迁移说明处理。
6. 使用独立管理员连接执行该环境 `database-logins.sql`，它仅用于首次创建 API/Worker LOGIN 及权限成员关系，不生成或修改已有密码。通过同一凭据渠道设置两个新登录的独立密码并填入相应配置；数据库角色已经存在时应核对现状，不能反复执行创建脚本当作轮换。API/Worker 均不是数据库或 Schema 所有者。密码未设置时不能通过 TCP 登录。
7. 启动 `galaxy-api@integration` 和 `galaxy-worker@integration`，检查真实 UID、loopback 监听、readiness、实际发行头/签名、写入/撤销和停止后恢复。确认后才按目标要求 enable 持久启动。pilot 重复同一过程，使用独立材料，不能复制 integration 密钥、数据库或身份。开启公开能力时另行提供相应治理/认证配置；本候选不自行打开搜索或账户提供者。

API 内存上限 1 GiB、Worker 2 GiB，每个进程 CPU 上限 2 核；每个数据库上限 4 GiB/2 核。两环境常驻服务的内存上限合计约 14 GiB，迁移进程各另限 1 GiB；主机本轮约 19.5 GiB 内存，仍须留给现有系统服务与缓存并实测，不能据此宣称容量达标。API/Worker 保留原 15 秒退出截止，systemd 给 25 秒再终止；日志轮转复用已有实现。

## 这台服务器的 Caddy 差异

实时检测到 Caddy 2.6.2 的 `admin off`；现有通用 `caddy reload` 流程在此状态下不可执行。当前官网仍是独立静态站。

部署包中的 `official-routes.json` 仅为精确 Official Host 的路由数组，不能直接覆盖 Caddyfile。先把现有配置适配为 JSON，在保留官网路由/监听/TLS 的候选副本中合并它并 validate。最直接的首次切换是：保存旧配置及摘要，采用目标已核验的 systemd 服务配置执行短时重启；验证官网与 Official，再在失败时恢复旧配置并重启。它会短暂影响同一 Caddy 承载的官网，应纳入该次公开部署范围。

若需要后续热重载，可在同一次明确配置变更中把管理监听设为受保护 loopback/Unix socket，首次仍需重启；验证管理入口后才使用通用 reload 流程。当前不打开该接口、不改 DNS、不替换官网配置。两种方式都保持数据库/指标/管理端口不公开；共享 OCI 安全列表的收窄不混入应用部署。

## 恢复与 AI-agent 操作注意

停止 API/Worker 或 `systemctl stop galaxy-database@<环境>` 不删除命名卷。禁止用 `docker compose down -v` 充当回退。应用回滚复用准确发行/Schema 预检；必要时在新数据库恢复并重放撤销/删除状态。两环境同机和已有官网备份不等于异地业务备份。

先确认实际发行、环境和凭据来源，再执行对应阶段；不要读取或打印环境文件、Docker inspect 中的秘密或私钥。模板解析只能证明文件格式，不能代替真实 UID、密码登录、持久化、重启、资源限制和公共 TLS 验收。当前已有单元中出现未知配置、已有目录符号链接、迁移或配置失败时修正具体问题；不要自动清库、关闭证书校验或恢复退役代理。

依据：[Docker Compose 服务配置](https://docs.docker.com/reference/compose-file/services/)、[Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/)、[PostgreSQL 官方镜像 PG18 数据目录](https://github.com/docker-library/docs/blob/master/postgres/content.md)。这些工具行为不等于本项目已部署。
