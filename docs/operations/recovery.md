# 备份、隔离恢复与生产恢复边界

备份命令成功、有效恢复点、隔离恢复成功和生产整站恢复分别证明。当前维护适配器配置仅接受 `production.enabled:false`；已有生产候选及隔离测试不代表可启用真实恢复。生产恢复须人工批准准确恢复点、损失/影响和统一开放条件，保留当前账户、密码、权限、密钥，再由代码执行和校验全部计划模块。

## 数据范围与恢复材料

operations-stack的备份只捕获配置列明的来源，不自动发现全部新增服务。`backup.sources`应明确实际配置、Caddy/TLS/ACME、准确units/drop-ins、API私有状态、Prosody、Garage、CMS媒体、Admin/operations源及所需API/site/auth发行目录；所有写入者暂停后解析符号链接至本次真实发行并记入说明。运行日志数据和隔离恢复副本不重复纳入，PGDATA不作普通目录复制，本机其他设备资料不属服务器备份。

`backup.writers`逐项列API、Worker、Keycloak、Prosody、Garage、CMS/publisher、Grafana和新增真实写入者；不停止混数据库的整套compose。optional缺失须记omitted，不能称已备份。[维护Agent的动态footprint](recovery-adapters.md#私有agent与动态捕获)是另一条捕获入口；仅当实际timer已采用它、该恢复点有必要贡献才覆盖新增引擎/卷。旧恢复点不补新范围。

restic用原生 `RESTIC_REPOSITORY_FILE/RESTIC_PASSWORD_FILE`，远端backend凭据可用host.mjs允许的私有逐行literal环境文件，不执行shell/password command。仓库密码与pgBackRest cipher另有受保护灾备副本，不能仅藏在自身加密仓库。同机仓库仅本地恢复，不能称离机灾备。

## PostgreSQL物理备份与WAL

业务与Keycloak是两个物理集群，分别stanza；CMS若为业务集群内逻辑数据库，随该物理集群备份。保持PG18原数据卷/UID、内部账户映射与业务表。

```sh
node packages/galaxy-official/deploy/operations-stack/manage.mjs build-postgres --config /etc/galaxy/operations/configuration.json
node packages/galaxy-official/deploy/operations-stack/manage.mjs prepare-pitr --config /etc/galaxy/operations/configuration.json
node packages/galaxy-official/deploy/operations-stack/manage.mjs activate-pitr --config /etc/galaxy/operations/configuration.json
```

衍生镜像沿精确同major Debian PG镜像加入pgBackRest，运行层不带完整编译环境。prepare-pitr读取原command、postgres UID/GID、system identifier，不重启；activate才在准确原JSON compose合并该服务镜像/仓库挂载/archive三项，保其他环境/卷/命令，并私有保存compose.before-pitr.json，安排维护窗口重启所选容器。失败不自动切回会打断WAL链的旧配置。

archive_mode=on、archive_timeout=60s，薄wrapper读cipher引用，两仓默认AES256。stanza-create与归档检查成功才activated，之后还需首个full。发现未声明外部tablespace即停止，不恢复至旧生产路径。

## 捕获、定时与失败接续

```sh
node packages/galaxy-official/deploy/operations-stack/manage.mjs repository-init --config /etc/galaxy/operations/configuration.json
node packages/galaxy-official/deploy/operations-stack/manage.mjs backup --config /etc/galaxy/operations/configuration.json --type auto
```

顺序为两集群在线物理备份、预复制已完成仓库文件、暂停准确写入者、分别写named restore point并等WAL归档、捕获文件、恢复原活跃服务，然后restic上传。默认暂停上限180秒；空间/超时失败恢复服务、不发布成功恢复点。reflink可用时CoW，否则真实复制；大文件须选实际可满足暂停时间的快照/存储方案，不能靠文字保证短暂停写。

全部必要数据捕获并入仓后create才成功。last-capture.json保存原工具snapshot ID、子目录及DB标签，不另造逐文件指纹。正常失败恢复原活跃服务；ExecStopPost消费私有暂停记录。手动接续用 `manage.mjs resume-writers --config <配置>`，只恢复原先活跃者，不重放备份。未完capture暂存不是有效恢复点。

auto首次full，后续星期日full、其他日diff；自动timer默认每周日03:15UTC加最多10分钟错峰，不是每日。PG默认保2个full及所需WAL链；restic至少2份并取最近1日/4周/1月规则并集，保留规则不新增调度。实际以生成timer/配置为准，首个有效备份后才 `systemctl enable --now galaxy-operations-backup.timer`。

[`HOUSEKEEPING.md`](../../packages/galaxy-official/deploy/operations-stack/HOUSEKEEPING.md) 提供互斥清理、磁盘保护以及最近已校验恢复点/未结束方案引用保护，日常优先该入口。裸 `manage.mjs retention --config <配置>` 只按配置本产品tag/host清理，不涵盖那些额外引用；不能混用后宣称保护完整。

## 回收、磁盘保护与发布物引用

`backup_housekeeping.py`与备份/恢复共用.operations-job.lock，活动任务存在让出；每小时维护，备份前清理/余量检查，成功后保留清理。除最近至少2点与日/周/月并集，额外保护最近成功、完整read-data校验点及未结束恢复方案引用，不动其他host/tag。先restic forget --dry-run --json排除保护点，再按完整ID forget、prune、check结构；prune中断留小待办，下次接续，不手删pack/WAL/PGDATA。

| 可回收项 | 普通/压力规则 |
|---|---|
| 失败backup捕获 | UUID及purpose=backup均匹配，48小时；压力1小时 |
| Next缓存 | 仅turbopack/webpack/swc，48小时；压力6小时，始终排最近5版/使用中版本 |
| Docker build缓存 | 平时不清；压力只清48小时前unused，保10GB目标，不清image/volume |
| journal | 512MiB/14天，另预留32GiB，压力仍同上限 |
| 小诊断摘要 | 30天，不保存失败数据副本 |
| 完整旧发行 | 每类近2份，另保实际现用及真正前一版、运行/配置/恢复引用/跨版依赖，新目录1小时缓冲 |

低于64GiB或使用≥85%进入压力；备份先至少32GiB余量，捕获按来源总量×2+32GiB检查。未知/越界/符号链接根/无标识不删，恢复暂存/开发/媒体/业务对象/DB卷不属此范围。release_housekeeping.py仅接管/srv/galaxy/admin/releases、/srv/galaxy/website/releases、/opt/galaxy/releases，重新核systemd、进程cwd/args/open files、Docker mount、current指针、配置和在办恢复，递归追保留版本symlink依赖。待发布版不挤掉真正上一现用版。

删除前同根原子移私有隔离再查新引用，尚未删可恢复原位；已部分删后出现引用保留并报警，不冒充可用版本。inode变化/未知项/symlink越界停该项。两个Python文件须同保护程序目录；运行策略和units按实际部署发现，常用固定安装为/opt/galaxy/operations/backup-housekeeping、/etc/galaxy/operations/housekeeping.json，status为/var/lib/galaxy/backup-status/operations/housekeeping.json。clean默认预演，`python3 -B <程序>/backup_housekeeping.py clean --config <保护策略>`只短暂取锁；实际应用由galaxy-backup-housekeeping.service，timer按小时。backup service的40-space-guard前后检查与backup-space.mjs/backup.mjs须随维护发行保留。

`systemctl show galaxy-operations-backup.timer -p NextElapseUSecRealtime`读实际日程，清理service Result/ExecMainStatus、保护点/无遗留writer及相关健康集中核对。GalaxyBackupStale create阈值8天，copy/check仍原阈值，规则需实际加载；只看源码不视作生效。此机制不自动回收业务增长，也不用docker system prune -a --volumes或递归删发行目录绕过引用保护。

## 隔离副本

选择同一last-capture对应restic snapshot与named DB points：

```text
node packages/galaxy-official/deploy/operations-stack/manage.mjs restore --config <准确配置绝对路径> --receipt <捕获回执绝对路径> --directory <恢复根内全新绝对目录>
node packages/galaxy-official/deploy/operations-stack/manage.mjs restore-database --config <准确配置绝对路径> --stanza business --at <UTC目标时点> --directory <恢复根内全新绝对目录>
```

restore通过restic原生snapshot子目录恢复到新bundle；PG使用全新data tree、只读仓库、network none、无端口、archive_mode=off。隔离恢复后清旧官网/运营/OIDC登录事务及会话，保主体映射/UID/业务/审计；不把API/Keycloak/Caddy接到新容器。restore.json记录精确容器/目录及未执行激活动作，返回state:isolated、publicActivation:false，尚未令上游会话失效。

restore-database选完成时间早于目标的备份，只启动隔离容器；目标需在可用WAL内，缺失/未达目标/失败不ready。它没有匹配文件副本，不能直接替换整站数据。任意时点WAL不代表每秒都有匹配Garage/Prosody文件。

认证库历史副本即使清会话/logout-all/CMS会话失效，也不能保存今天的新密码、撤销角色、密钥或账户；隔离副本因此没有“确认后直接切回”路径。

## 生产适配器与真实阻断

[恢复适配合同](recovery-adapters.md)集中维护UDS安装、当前安全态合并、Garage/Grafana/Prosody与精确对象贡献，以及schema131删除归属缺39表的准确集合和副作用前阻断。各条件按实际所选范围执行，不能用旧schema或进程检查替代。

适配器所需当前安全权威、原生贡献与统一重开列入具体恢复方案，按本页开头的批准边界办理；Agent准备诊断/方案，配置开关不提供旁路。文件清理仍通过其具体计划入口执行。

排障只读必要元数据：准确units/容器/compose、PG角色/PGDATA、持久根、端口、仓库引用。pgBackRest归档失败查cipher对原postgres可读性及同major镜像；捕获超时保失败暂存并调整真实存储，不放宽一致性；restore只能用仍存在的备份/WAL，恢复码不能补出未保存数据。
