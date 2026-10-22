# 运营监控与备份

运营后台是业务管理入口；Grafana、Alertmanager 和备份命令承担各自的专业工作。本目录部署材料面向 Linux 单机，复用已有 PostgreSQL 18、Keycloak、Prosody、Garage 和 ClamAV，不替换业务权限，也不另建账户系统。

源码入口为 `packages/galaxy-official/deploy/operations-stack/manage.mjs`。本批提供配置和操作实现；是否已经部署、收到了指标、投递了告警或完成过恢复，以实际运行结果为准。

## 拓扑与访问

| 组件 | 本地入口与数据 | 用途 |
|---|---|---|
| Grafana OSS | `127.0.0.1:13000`；`/var/lib/galaxy/operations/grafana` | 通过 `https://admin.agigalaxy.org/monitoring/` 访问指标、诊断和告警 |
| Loki | `127.0.0.1:13100`；本地 TSDB/文件存储，pilot保留14天 | 保存结构化运行诊断并支持请求定位 |
| Alloy | `127.0.0.1:12345`；独立持久游标 | 读取指定日志文件和 systemd journal；不用 Promtail |
| 组件日志适配器 | 宿主 `galaxy-component-logs.service`；私有轮转文件 | 只读指定 Docker 容器日志，先提取安全诊断再交给 Alloy |
| Prometheus | 配置指定的 loopback 地址；已有二进制与持久目录 | 读取现有 API/Worker 指标和 Blackbox 探测，执行现有规则 |
| Alertmanager | loopback 地址；接收者配置为受保护文件引用 | 按 operations/identity/data 等现有职责路由 |
| Blackbox Exporter | loopback 地址 | 官网、存活与就绪探测 |
| pgBackRest | 每个现有 PG 集群一个 stanza、独立加密仓库 | 在线物理备份和连续 WAL 归档 |
| restic | 受保护仓库和密码文件引用 | 保存相匹配的数据库备份链、文件、配置及发行资料 |

三个 Compose 服务合计内存上限1472MiB；managed 模式三个指标服务另设256/96/64MiB，组件日志适配器128MiB，总上限约1.97GiB。容器使用 Linux host network 访问仅绑定 loopback 的指标接口，所有监听仍限定 `127.0.0.1`。Loki 的 `common.instance_addr` 同时把查询frontend和ring的通告地址限定到loopback，避免多网卡主机把结果回传到未监听的私网地址。Loki、Prometheus 和 Alloy 不直接通过公网反向代理；日志适配器只使用本机 Unix socket，没有监听端口。

`monitoring.mode=managed` 会生成独立 systemd 服务；`existing` 则仅接已有指标系统，不启动第二套。已有规则直接来自 `docs/alerts/galaxy.rules.json`、`docs/monitoring/external.rules.json` 和 Blackbox 配置，生成时引用同一来源。Alertmanager 的旧示例没有有效接收者，不能把它当作实际投递配置。

## 一次配置与安装

以 `configuration.example.json` 创建目标主机的配置，放在受保护配置目录。配置只含路径、版本、角色、端口及数据范围；密码、客户端 secret、仓库密钥留在各自受保护文件。`plan` 不读取这些值，也不连接服务：

```sh
node packages/galaxy-official/deploy/operations-stack/manage.mjs plan --config /etc/galaxy/operations-input.json
```

首次部署需要填入主机名、API/Worker 实际指标端口、可执行文件路径、Alertmanager 接收者引用及 Keycloak 专用客户端引用。目标主机名必须与运行主机一致。两个 PG 的实际数据库名、角色、compose 路径及容器范围需匹配；`prepare-pitr` 会自动读取原 command、postgres UID/GID 和 cluster system identifier，保留已有参数，不要求人工抄录这些值。

当前材料使用 Grafana 13.2.4、Loki 3.7.8、Alloy 1.21.0、pgBackRest 2.60.0 和 restic 0.19.1。Prometheus 二进制沿现有3.13.3；告警工具采用官方 [Alertmanager 0.34.1](https://github.com/prometheus/alertmanager/releases/tag/v0.34.1) 与 [Blackbox Exporter 0.29.0](https://github.com/prometheus/blackbox_exporter/releases/tag/v0.29.0)。`manage.mjs` 使用已安装的绝对路径；目标专用 `stage-linux.py tools` 才会下载这两个固定版本、拉取三个固定镜像并构建 pgBackRest 镜像，不启停产品服务。

`configuration.pilot.json` 是本机部署的公开拓扑，包含实际9411/9412指标、私有结构化日志路径、两集群及同机加密 restic 引用。以现有授权身份把本模块、所引用的 `docs/monitoring`/`docs/alerts`、`backup-status.mjs` 与 `galaxy-mail/src/layout.mjs` 及其运行依赖放到目标专属目录后，可以执行：

```sh
python3 packages/galaxy-official/deploy/operations-stack/stage-linux.py tools
python3 packages/galaxy-official/deploy/operations-stack/stage-linux.py prepare
```

该专用准备入口保留已有私有密钥，仅在不存在时生成 Grafana 稳定密钥、bootstrap 密码、两集群 cipher 和 restic 密码；创建同机 `/var/lib/galaxy/backups/product-restic` 并安装未启动的 units。它不更换现有数据库镜像、不启用归档，也不启用备份 timer。工具与配置准备状态保存在目标私有状态目录；同机仓库为 `offsite=false`，离机目的地稍后独立确定。

安装阶段按一个完整批次完成：

```sh
node packages/galaxy-official/deploy/operations-stack/manage.mjs prepare --config /etc/galaxy/operations-input.json
node packages/galaxy-official/deploy/operations-stack/manage.mjs install-units --config /etc/galaxy/operations/configuration.json
```

`prepare` 只生成自身配置、持久目录及专用监控用户；`install-units` 只安装带本工具标记的具名单位，遇到同名无关单位会停止。非空既有目录的所有者不匹配时不递归修改。专用准备入口将原秘密留在 root0600 文件中，在 root0700 的独立目录内生成精确 UID472/原 postgres UID可读的只读副本，供单文件 bind mount。Alertmanager 通过 systemd `LoadCredential` 读取 root 私有 receiver，监控用户不直接读取原凭据目录。

将生成的 `caddy-monitoring.fragment` 合并到既有 `admin.agigalaxy.org` 站点、后台 catch-all 之前。保留 `/monitoring/` 路径，不使用 `handle_path` 去掉前缀。域名和 TLS 由现有 Caddy 管理，脚本不覆盖整个 Caddyfile。

```sh
node packages/galaxy-official/deploy/operations-stack/manage.mjs up --config /etc/galaxy/operations/configuration.json
```

这一步启动指标服务、组件日志适配器及三个容器，未开启备份定时器。首次运行集中观察受限登录、实际指标/日志和已经授权的测试告警；已有投递结果直接沿用，不重复发信。启动命令正常返回本身不证明外部通知已送达。

## 独立管理登录

管理身份使用 `galaxy-operations` realm，与普通 `galaxy` 账户、凭据和会话分开。Grafana 使用专用 confidential client `galaxy-operations-grafana`，Authorization Code + S256；禁用 implicit、password grant 和 service account。唯一回调为 `https://admin.agigalaxy.org/monitoring/login/generic_oauth`。

管理 issuer 在管理域名下，当前配置为 `https://admin.agigalaxy.org/realms/galaxy-operations`。`grafana.roleSource` 明确选择 client 或 realm 角色；独立部署默认使用专用 client roles，pilot 则复用已有管理域的 administrator/reader 两个角色及受限 scope mapping，分别映射 Admin/Viewer。生成的 `keycloak-grafana.json` 对应所选角色来源；它是接线合同，不在准备时创建或修改 Keycloak 身份。相应 mapper 必须把限定角色加入签名 ID Token。普通银河用户和同邮箱账户不因此取得监控身份。

Grafana 显式验证 ID Token、issuer/JWKS，并以有界的专用 Viewer/Editor/Admin 角色映射。没有匹配角色拒绝登录，不降为默认 Viewer；Admin 只是 Grafana organization 管理，不授予银河业务权限或 Grafana server admin。这里采用 OSS Generic OAuth，不依赖企业 Team Sync。[Grafana Keycloak 配置](https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/keycloak/)、[Generic OAuth 配置](https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/generic-oauth/)。

## 管理告警邮件

`prepare-alertmanager.py --recipient <管理收件人>` 只在授权主机进程内读取既有 `galaxy` realm 的 SMTP 连接，写入 root 私有 receiver，不改变普通账户或原 SMTP 设置。发件身份另取共享包生成的 `monitoring/mail-identity.json`：`AGI Galaxy 通知 <notice@agigalaxy.org>`，Reply-To为`AGI Galaxy 团队 <team@agigalaxy.org>`，不沿用账户发件人。模板／身份文件须先随本批配置生成和部署；对应SMTP供应商必须已允许notice@发件。若 Admin API 返回 mask，按明确授权精确读取该 realm 的 SMTP map；mask 不能充当密码。配置保留原连接的 STARTTLS 或 implicit TLS，并使用 Alertmanager 对应 TLS 选项；不禁用证书核验。[Alertmanager 邮件配置](https://prometheus.io/docs/alerting/latest/configuration/#email_config)。

告警与测试邮件都通过 `galaxy-mail` 的同一品牌信笺生成头尾。系统邮件／团队联系说明在正文后、品牌分隔线之前，最底部保留银河品牌与官网／隐私。`--send-test` 仅向显式指定的管理收件人发送一封清楚标注的测试，并保存无地址、无秘密的结果；已有发送请求记录不会自动重发。SMTP 接受只说明服务器收下该邮件，不表示已核实收件箱，也不等同完整 Alertmanager 调度链已经运行。

## 日志范围

`logs` 列出 API/Worker 的私有结构化文件和 Caddy 安全访问日志；`journals` 列出后台、发布器、Caddy 系统服务、Prometheus、Alertmanager、Blackbox、备份及采集器的精确 unit。`dockerLogs` 只列本产品的两 PostgreSQL、Keycloak、Prosody、Garage、ClamAV 和 Grafana/Loki/Alloy 容器。新增或改名组件须同步实际配置；版本不能取得时明确为 `unreported`，不把镜像摘要假称产品版本。

Alloy 不挂 Docker socket。宿主适配器仅执行固定本机 daemon 的 `docker ps` 和指定容器的 `docker logs --follow --timestamps`，不读取容器环境、配置、文件或执行容器命令；进程自身的 Docker 配置目录为空且私有。适配器将每行重建为安全 NDJSON 后写入 `component-logs`，默认每组件10MiB、3个文件，断线后按实际容器与时间游标重接，容器重建自动接新实例。游标采用包含起点的读取，崩溃边界可能重复末尾日志，避免为去重丢失同时间记录；源容器已删除或源轮转前未读到的内容无法补出。

文件和 journal 也经过同一白名单投影。保留受限的 event/code/phase/stage/action、等级、HTTP方法/状态/耗时/大小、清理后的路由形状、任务队列/次数/结果、机器错误码及SQLSTATE。API与后台已清理的堆栈最多12帧、cause最多两层，帧只保留允许的源路径或文件名及行列；`GET /...` 路由和后台的 `statusCode`/`frames` 会归一化。第三方普通文本仅提取错误类别和异常类等诊断线索，原文不转存。Error.message、SQL/detail、请求体、聊天 stanza/正文、邮件地址、cookie、验证码、token、密码、任意 headers 与 OAuth 参数均不进入 Loki；不通过打开全量 debug 补采内容。无法安全归类的记录保留组件、时间和等级，不承诺保存供应商完整错误原文。

`component`、`environment`、`release` 与有限 `level` 是查询标签。真实 `requestId`、Caddy 生成的 `edgeRequestId` 及 `jobId`/`resourceId` 只接受UUID，仅作结构化元数据，不建立高基数索引，也不为没有关联ID的第三方记录编造同一请求。Grafana 的“运行日志”可筛组件和版本，并以已取得的任一请求ID定位 API/后台/Caddy 记录；Caddy 的 `requestId` 取上游实际响应，未取得时保留未知。同一文件或journal可能混有旧版本，只有实际记录声明的版本才进入release标签；容器投影使用其精确来源版本，无法取得时为unreported。业务审计仍由业务域保存，不以运行日志代替。

Alloy 持久化文件与 journal 游标，初次 journal 最多回看24小时，文件从现存开头接收。Loki 的 pilot 保留期为14天，源日志按各组件实际轮转；Caddy安全访问日志由其配置负责25MiB、10个文件、14天。缺少请求ID、组件尚无事件、权限/轮转和停机期间均可能影响覆盖，运行结果必须按实际组件说明。[Alloy journal](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.journal/)、[Alloy 文件读取](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.file/)、[结构化元数据](https://grafana.com/docs/loki/latest/get-started/labels/structured-metadata/)。

## 启用 PostgreSQL 时点恢复

主业务与 Keycloak 是两个物理集群，均需独立 stanza。CMS 独立逻辑数据库若位于主集群，会随该集群物理备份。现有 PG18 数据卷与内部账户 UUID、固定 UID、本地身份和业务表不改写。

```sh
node packages/galaxy-official/deploy/operations-stack/manage.mjs build-postgres --config /etc/galaxy/operations/configuration.json
node packages/galaxy-official/deploy/operations-stack/manage.mjs prepare-pitr --config /etc/galaxy/operations/configuration.json
node packages/galaxy-official/deploy/operations-stack/manage.mjs activate-pitr --config /etc/galaxy/operations/configuration.json
```

衍生镜像沿现有精确 PostgreSQL18 Debian 镜像，只加 pgBackRest；源构建在 build stage，运行镜像不带完整编译环境。`prepare-pitr` 不重启数据库。`activate-pitr` 才在**精确原 JSON compose**中合并该 DB 服务的镜像、仓库挂载与3项 archive 设置，保留其他环境、卷和命令；旧 compose 保存在私有 `compose.before-pitr.json`。这样原开机单位仍会加载正确配置。此步重启选定数据库容器，需安排实际服务维护窗口；失败不自动切回会中断 WAL 链的旧配置。

归档为 `archive_mode=on`、`archive_timeout=60s`，archive command 通过薄 wrapper 读取 cipher 引用；两仓库默认 AES256 加密。`stanza-create` 与工具自身的归档检查成功后才返回 activated；仍需完成首个全量备份。未声明外部 tablespace 时发现其存在会停止，不能把 tablespace 恢复到旧生产路径。物理备份、归档和恢复采用 [pgBackRest 官方命令](https://pgbackrest.org/command.html)与[PG18示例](https://pgbackrest.org/user-guide.html)。

## 全产品备份与日常接续

restic 仓库和密码使用原生 `RESTIC_REPOSITORY_FILE`、`RESTIC_PASSWORD_FILE`；远端 backend credential 可另用私有、逐行 literal 的环境文件，支持的变量在 `host.mjs` 列出，不执行 shell 或 password command。仓库密码及 pgBackRest cipher 另存受保护的灾备副本，不能只留在需要它们解密的同一仓库里。[restic 仓库准备](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html)。

`backup.sources` 包含实际配置、Caddyfile与其TLS/ACME状态、精确运行 units/drop-ins、API私有状态、Prosody、Garage、CMS media、admin 与 operations 源，以及所需 API/site/auth 发行目录；符号链接在所有写入者暂停后解析到本次真实发行目录并记入捕获说明。当前pilot来源为 API0.1.22、后台0.1.2、不可变网站0.1.34及current所指的CMS发布产物，并包括publisher、日志采集和备份单位。版本目录按实际发布更新；Loki/Alloy/collector日志数据本体和隔离恢复副本不重复纳入产品备份。不得将 PGDATA 再作为普通目录复制，数据库走物理备份；客户端其他设备上的本地资料不属于服务器备份。`backup.writers` 同时包含 API、Worker、Keycloak、Prosody、Garage、CMS/publisher 等实际写入者和 Grafana，精确列出 unit/container，不停整个混有数据库的 Keycloak compose unit。显式 optional 的缺失来源会记录为 omitted，不能把它说成已备份。

```sh
node packages/galaxy-official/deploy/operations-stack/manage.mjs repository-init --config /etc/galaxy/operations/configuration.json
node packages/galaxy-official/deploy/operations-stack/manage.mjs backup --config /etc/galaxy/operations/configuration.json --type auto
```

一次备份依次在线备份两集群、预复制已完成的仓库文件、暂停明确写入者、分别写 named restore point 并等待对应 WAL 归档、捕获文件，再恢复原先运行的服务。默认暂停上限180秒；空间不足或超时会失败并恢复服务，不发布虚假的成功恢复点。`cp --reflink=auto` 可利用支持 CoW 的文件系统；其他文件系统会真实复制，所需暂停时间必须符合实际数据量。文件较大时应采用适合该主机的快照/分离存储安排，不能用“短暂停写”的文字承诺掩盖复制时间。

服务恢复后才 restic 上传。`last-capture.json` 保存工具返回的 snapshot ID、捕获子目录和各数据库标签；没有另造逐文件指纹清单。只有全部必要数据捕获并成功进入所配仓库才将 `create` 状态记为成功。若仓库仍在同机，它只提供本地恢复，不能称为离机灾备。

`auto` 首次全量，之后周日全量、其他日差异；显式 `--type full` 可手工全量。PG 仓库默认保留2个全量及其所需归档链。restic 保留策略默认14天/8周/6月，可在配置调整；执行下面命令才清理本产品 tag 和 host 的旧快照，不触其他产品：

```sh
node packages/galaxy-official/deploy/operations-stack/manage.mjs retention --config /etc/galaxy/operations/configuration.json
systemctl enable --now galaxy-operations-backup.timer
```

定时器需首个有效备份后再启用。状态使用现有 `backup-status.mjs` 格式；API 配置 `GALAXY_BACKUP_STATUS_DIRECTORY` 指向本批 status 目录，`GALAXY_METRICS_BACKUP_ACTIONS=create` 只监测已接动作。`backup.statusGroupId` 设置 API 实际组，只让其读取短状态文件，不开放仓库、捕获回执或秘密。现有 BackupFailed/Stale 等规则继续使用。

进程正常失败时会恢复原活跃服务；systemd 的 `ExecStopPost` 还会消费私有暂停记录，恢复被中断任务的写入者。需要手动接续时只运行 `resume-writers`；它不会启动原本未运行的服务，也不会重放备份。未完成暂存留在私有 capture 目录，不能冒充有效备份。

## 隔离恢复

完整产品恢复必须选择同一 `last-capture.json` 对应的 restic snapshot 和 named database points。任意时点的 WAL 恢复是另一种数据库能力，不能宣称每秒都存在与之匹配的 Garage/Prosody 文件副本。

```sh
node packages/galaxy-official/deploy/operations-stack/manage.mjs restore --config /etc/galaxy/operations/configuration.json --receipt /protected/capture-receipt.json --directory /var/lib/galaxy/restores/incident-copy
```

目标必须为恢复根内的**新目录**。restic 使用其原生 snapshot 子目录选择，文件留在新目录的 bundle 中；各 PG 恢复到同次捕获点，使用全新 data tree、只读仓库挂载、`--network none`、无端口和 `archive_mode=off`。在隔离容器内恢复完成后清空官网、运营和 OIDC 登录事务/会话表；principal 映射、固定 UID、业务数据及审计保留。没有将原 API、Keycloak、Caddy 接向这些新容器。

若仅需数据库误操作前的副本：

```sh
node packages/galaxy-official/deploy/operations-stack/manage.mjs restore-database --config /etc/galaxy/operations/configuration.json --stanza business --at 2026-10-20T08:00:00Z --directory /var/lib/galaxy/restores/database-copy
```

程序选完成时间早于目标的备份，仍只启动隔离新容器。目标需在实际可用 WAL 范围内；缺失 WAL、未到目标或恢复失败不会返回 ready。此命令没有对应文件副本，不用它直接替换整站数据。[restic 子目录恢复](https://restic.readthedocs.io/en/stable/050_restore.html)。

`restore.json` 记录确切新容器、目录及尚未执行的激活动作。切回真实服务前，需在受控恢复环境对 **galaxy 与 galaxy-operations 两个 Keycloak realm 分别 logout-all**；清官网表不等于已清 Keycloak SSO。CMS 若启用自身认证会话，也应按其实际机制失效。确认恢复内容后由现有部署流程切换，本文命令不会覆盖生产卷、自动修改 DSN、替换 Caddy 或自动激活还原文件。

## AI Agent 部署

先读取目标配置和已授权的最小主机元数据：当前 units/容器名称、compose 服务与路径、两个 PG 的数据库/角色/PGDATA、实际指标端口、运行日志方式、CMS/Garage/Prosody 持久根及离机仓库引用。只读取字段和引用，不打印环境全文、容器 Env、JWT、验证码、SMTP 或模型凭据。

按 `plan` 填齐未知项，再集中完成所需部署动作。监控是独立管理身份域，不能拿普通账户或关联本地ID的权限替代。PG 显式激活会重启已选容器；写入者列表必须涵盖实际新服务，不能用不完整列表宣称全站一致。备份密码与恢复所需授权由受保护配置提供，不写入仓库或命令行。

常见故障：Grafana 跳转前缀错误时看 `root_url` 与不剥前缀的 Caddy；已登录但无权进入时看已选角色来源、scope mapping 与签名 ID Token mapper；日志没有数据时看精确文件/unit/container、只读绑定和读取权限，以及适配器的有限 `log_source_*` 事件，不能打印原始日志或打开认证 debug 排障。修改采集配置后只重载本日志组件，不为此重启 API、认证或数据库。pgBackRest 无法归档时看 cipher 文件对原 postgres 用户的可读性及同 major 镜像；捕获超时时保留失败目录并调整真实存储方案，不放宽为不一致备份；restore 只能使用尚存在的备份和 WAL，不能凭恢复码补出未保存的数据。

本模块定向测试入口为 `node --test packages/galaxy-official/deploy/operations-stack/operations-stack.test.mjs packages/galaxy-official/deploy/operations-stack/log-record.test.mjs`。测试证明命令编排、生成合同和安全投影，不等同真实 Grafana OAuth、日志覆盖、告警投递、PG归档或离机恢复；阶段完成后集中运行必要项目，不为每个配置文件重跑全产品套件。
