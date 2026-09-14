<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/56/568a103973d520686a24eb003b8458754b86d309080ec3ff2bd667616e46adcf.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 私有 integration 监控与备份运行说明 v1

2026-09-11 已在选定 Oracle Kulai 主机实施。监控/备份配置版本 `integration-ops-2026.09.11-1` 保留；应用已升级到 `official-2026.09.11-cost`、Schema41/44表，接通实际费用观测，见[费用接线](integration-cost-v1.md)。公开 Official/Hub 与 pilot 未开放。最终 API、Worker、数据库、监控和备份定时器均停止；配置与数据保留。

## 监控

复用 [Prometheus 官方发行](https://prometheus.io/download/)：Prometheus 3.13.3 LTS、Node Exporter 1.12.1，安装包摘要见项目 `05-build/GALAXY_MONITORING_RUNTIME_PINS_2026-09-11.json`。两服务共用专用 UID992/GID982，监听 127.0.0.1:9090 和 9100；API/Worker 指标仍为9311/9312。

配置在 `/etc/galaxy/monitoring/integration/`。4个job为galaxy-api、galaxy-worker、galaxy-host、galaxy-prometheus。22条既有告警规则计算正常；实际采到CPU、内存、文件系统、网卡和负载，出口设备为 `enp0s5`。主机网卡计数包含其他应用，不能直接作为银河流量费用。

API的Wants启动Prometheus，Prometheus依赖Node Exporter；PartOf传播API停止/重启。已验证4目标up、规则健康、停止传播、重启后历史样本仍可读取。TSDB在 `/var/lib/galaxy/prometheus/integration`，保留35天、大小上限1GB，先到的约束生效。

监控与API同一故障域，停API也停监控。Alertmanager、独立监控主机及真实通知接收者尚未配置；规则计算成功不代表有人收到告警。首轮安装失败只保存了activation/AssertionError；恢复验证补上首次规则计算等待和具体阶段定位，随后通过，不能据此断言首轮唯一根因。

## 加密备份与恢复

复用 [restic 0.19.1 官方发行](https://github.com/restic/restic/releases/tag/v0.19.1) 和当前固定发行的backup模块，不复制备份/恢复业务逻辑。Linux amd64压缩包SHA256：

`f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c`

运行位置为 `/opt/galaxy/runtime/restic-0.19.1-linux-amd64/restic`。每次操作创建自动删除的容器，复用现有固定PostgreSQL18.6镜像、Node二进制和已选应用发行；pg_dump/pg_restore直接使用容器内18版工具，主机16版客户端未替换。

- 加密仓库：`/var/lib/galaxy/backups/integration/repository`。
- 私有回执、请求、恢复文件：同一integration备份目录下的receipts、requests、recovery。
- 备份密码：仅目标机 `/etc/galaxy/integration/backup.password`（0600）；不放项目、报告或Docker参数。
- 当前使用该私有数据库既有迁移管理员连接；API/Worker不获得管理员凭据。正式部署还需单独落实备份访问角色与秘密托管。
- 密码/数据库URL经子进程stdin交给一次性容器，不写Docker环境配置。备份状态小文件单独放在 `/var/lib/galaxy/backup-status/integration`，交给API UID995读取；仓库及回执仍为root私有。
- 捕获44张表和7个明确文件：无秘密运行元数据、发行清单、root pins、keyring、SQLite失败审计快照、Prometheus配置、告警规则。不捕获.env、根/服务私钥或仓库密码。

初次实际备份定位到SQLite在线快照失败。WAL模式的只读连接可能需要建立旁文件，因此审计目录单独以可写方式挂载，SQLite快照子进程降为原API UID995/GID985，仅以readOnly连接读取数据库，再用Node SQLite backup生成独立快照。其余备份继续使用原事务快照与restic实现；没有产生阻止API重开的root属主审计旁文件。SQLite临时副本位于一次性容器256MiB tmpfs；超过此容量会失败，不能作为无上限承诺。

PostgreSQL、SQLite和选定配置各自一致；没有声明跨存储的全局原子快照。恢复需要新的 `galaxy_restore_*` 数据库及新目录；原库不覆盖，恢复库默认隔离、旧授权失效。当前恢复演练数据为既有合成integration数据。

## 启停和调度

启动仍使用：

```sh
sudo sh /opt/galaxy/operations/start-integration.sh
```

它启动数据库，从而通过数据库drop-in启动两个备份timer；API带起监控。创建备份在数据库启动15分钟后触发，后续每15分钟；仓库check在启动1小时后触发，后续每日一次。停止数据库会停止timer及对应在途备份单元。timer为static、由数据库依赖启动；数据库本身没有启用开机启动，停服期间不备份。

一次实际timer演练使用临时2秒OnActiveSec覆盖生成快照，完成后移除覆盖并恢复15分钟配置。没有等待完整15分钟/1天周期，也没有将一次短样本视为持续RPO承诺。

手动创建或检查（数据库须已启动）：

```sh
sudo systemctl start galaxy-backup-integration@create
sudo systemctl start galaxy-backup-integration@check
sudo /opt/galaxy/runtime/node-v24.19.0-linux-x64/bin/node /opt/galaxy/operations/integration-backup.mjs retention
```

入口用flock防止备份/检查/恢复并发。retention仅预览7日/4周/6月保留分组，不执行forget/prune。已有仓库不能重新init。

恢复入口必须给出create回执中的准确snapshotId和manifestSha256：

```text
sudo <固定Node路径> /opt/galaxy/operations/integration-backup.mjs restore <snapshotId> <manifestSha256>
```

本轮快照 `bd75c15d17b1dc6a43d5aa1510de30aa244a4216d73d187e82dd10d1e8b1237b` 已经恢复至 `galaxy_restore_465cd1b6_f5d7_48b8_9468_be49eebbe002`，恢复文件位于 `/var/lib/galaxy/backups/integration/recovery/465cd1b6-f5d7-48b8-9468-be49eebbe002`。均保留，不要再次执行初次安装或覆盖此候选。

恢复核对44表和7文件通过；recovery_state被新的隔离标记替代，随后1项仍有效Consent被撤销。隔离恢复1.133秒，观察到的恢复点年龄3.783秒，仅包含这一小样本的恢复核对与隔离处理，不含重新公开服务。原库选定9张事实/授权表摘要保持一致。

API指标已验证create/check的status_available和last_attempt_success均为1；copy未配置，所以未把它列为已监控动作。首次指标检查错误地要求无标签格式，已修正为支持实际component标签，并只补验指标及启停，没有重跑恢复。

## AI Agent 接续与回退

先读无秘密资产记录和上述固定配置路径。应用发行清单保持冻结，运维脚本位于 `/opt/galaxy/operations/`；源码在项目 `05-build/tools/`。修改脚本需记录摘要和运维配置版本，不把工作区后续修改算作已部署发行。

停止API、Worker、数据库即可停止依赖监控和备份调度；不要用删除命名卷、清库、restic prune或移除密码代替停服。回退运维配置时先停服务，再移除本轮指定的monitoring/backup drop-in和单元；数据及秘密保留。应用回退继续使用[既有发行切换入口](linux-deployment-v1.md)。

真实异地仓库、密码的独立托管、外部删除账本覆盖、运营保留策略、独立告警通知及长时间运行仍待完成。单机加密快照不抵御整机丢失；正式RPO/RTO、费用预算与公开试点仍按原任务验收。
