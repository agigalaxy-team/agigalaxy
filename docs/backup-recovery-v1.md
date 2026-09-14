<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/d2/d24fddaa4f40da5dda86e9dd51ae7eca8b4d09fdff51a05d33912184918ed2b5.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Official 备份与恢复 v1（C18-01 / C18-02）

2026-09-11私有integration：已安装监控并验证四目标/22规则、启停及历史保留；已运行restic定时备份、Schema41/44表7文件隔离恢复与API备份状态采集。最终停止，异地仓库和真实通知未配置。当前路径、版本和限制见[运行说明](integration-operations-v1.md)。

2026-09-10客户端回执：`galaxy-binding-receipts.json` 为客户端私有历史文件；需用户显式列入本地数据备份，不由云端备份自动收集。恢复回执不恢复会话或有效授权。详见[本机回执](local-binding-receipts.md)。

当前Schema41：44表（含schema_migrations）、独立删除账本捕获、隔离重放和迟到审计处理已实现。[删除恢复说明](deletion-recovery-v1.md)。回执最小化已接通；生产捕获/异地存储配置待完成；准确快照清理已接通；下方旧批次说明保留其当时范围。

本模块提供 PostgreSQL 事务快照、选定文件及 SQLite 在线副本的 restic 加密备份、第二仓库复制、保留策略预览、新库恢复和权限失效。它已用于本地与私有integration；目标数据库运行期间有备份调度，真实异地仓库与公开动态服务仍未启用。

## 数据与一致性

- 新备份清单采用版本2，`database.inventoryOrdering=jsonb-text-c-v1`，摘要统一按 `COLLATE "C"` 排序，避免不同操作系统/语言设置让相同行数据产生不同摘要。恢复器继续支持版本1的原数据库默认排序；跨语言恢复旧快照仍可能因顺序差异失败，必须保留失败并重新生成版本2快照，不能跳过事实校验。旧恢复器不支持版本2，回退前保留兼容备份工具。外层CLI配置版本仍是1。
- 数据库：`pg_dump --format=custom --snapshot` 与行摘要读取共享同一 PostgreSQL 导出事务快照；覆盖 public schema 全表、事实、授权、签名引用、后台任务及审计。
- 文件：只读取配置中明确列出的普通文件；记录相对名称、长度和 SHA-256。复制前后变化即失败。数据库导出和普通文件使用流式摘要，不将整份数据库装入内存。
- SQLite：用 Node SQLite 在线备份 API 捕获 WAL 中的数据；适用于 HTTP 失败审计队列。不能只复制主数据库文件并忽略 WAL。
- 每种存储各自一致；跨数据库与文件的全局原子快照尚未实现。有关联写入时，应先停止相关写入进程，待备份完成再恢复写入。当前 Evidence 主要保存远端来源记录和摘要，选定文件功能不等于自动发现或备份远端源站。
- 暂存目录在备份后删除，清单和数据进入 restic 加密仓库。暂存介质与恢复目录仍包含明文，需要运营账户独占目录及加密磁盘。删除暂存文件不承诺安全擦除。
- 不自动收集 `.env`、客户端身份私钥、根私钥或其他目录。服务秘密由独立秘密存储恢复；公开配置、签名公钥和信任版本可按明确清单备份。

## 操作入口

从代码仓根运行：

```text
node packages/galaxy-official/scripts/backup.mjs <action> <absolute-config.json> <new-absolute-receipt.json>
```

动作：`init` 初始化明确配置的仓库；`create` 备份；`check` 完整读取仓库数据检查；`copy` 将准确快照复制到第二仓库；`retention` 输出保留预览；`restore` 恢复到新库。每次回执路径须不存在；回执记录摘要和结果，不输出密码。失败统一返回非零码；检查配置、环境引用、二进制与仓库可达性，不把第三方命令原始错误写入公共日志。

配置示例只包含路径及环境引用，路径按实际平台修改：

```json
{
  "version": 1,
  "resticBinary": "/opt/restic/restic",
  "pgBin": "/usr/lib/postgresql/18/bin",
  "databaseUrlEnvironment": "GALAXY_BACKUP_DATABASE_URL",
  "primary": {
    "repository": "/srv/galaxy-backups/primary",
    "environmentReferences": { "RESTIC_PASSWORD": "GALAXY_BACKUP_PASSWORD" }
  },
  "copy": {
    "repository": "/srv/galaxy-backups/secondary",
    "environmentReferences": { "RESTIC_PASSWORD": "GALAXY_BACKUP_COPY_PASSWORD" }
  },
  "capture": {
    "database": "galaxy_official",
    "stagingParent": "/srv/galaxy-backup-staging",
    "endpoint": "https://official.example.org",
    "configurationVersion": "deployment-001",
    "rpoTargetSeconds": 900,
    "rtoTargetSeconds": 900,
    "files": [
      { "name": "configuration/public.json", "kind": "file", "path": "/srv/galaxy/config/public.json" },
      { "name": "audit/http-failure.sqlite", "kind": "sqlite", "path": "/srv/galaxy/trust/http-failure-audit.sqlite" }
    ]
  },
  "retention": { "keepDaily": 7, "keepWeekly": 4, "keepMonthly": 6 }
}
```

`copy` 在配置顶层添加准确的 64 位 `snapshotId`，来源为 create 回执；复制回执返回目标仓库中的 ID。源仓库密码通过 `RESTIC_FROM_PASSWORD` 注入子进程，目标仓库使用自己的密码。远端存储环境引用可供 restic 使用，但当前复制集成只验证两个本地仓库；不同远端提供商的双端认证组合需在指定部署环境落实。

`restore` 将 primary 指向要读取的仓库，并在配置增加：

```json
{
  "restore": {
    "snapshotId": "准确的64位目标快照ID",
    "expectedManifestSha256": "create回执中的64位manifestSha256",
    "targetDirectory": "/srv/galaxy-recovery/exercise-001",
    "targetDatabase": "galaxy_restore_exercise_001",
    "failureAt": "2026-09-10T00:00:00Z"
  }
}
```

这些占位值必须替换为实际回执值。数据库连接用于定位恢复服务器，目标库名由独立参数固定；不会继承连接 URL 中的源库名。备份工具使用连接解析后的主机、端口和用户。TLS 数据库须同时配置 `pgTlsEnvironment` 的 `PGSSLMODE=verify-full`（或 verify-ca）及所需证书路径，使 libpq 工具获得明确的验证设置。

## 恢复和重新开放

1. 读取准确快照并执行 restic 文件核验；校验外部保管的 manifest SHA-256，再核对每个文件摘要。
2. 创建 `galaxy_restore_*` 新数据库，取消 PUBLIC CONNECT。已有库、已有目录均不覆盖；角色和权限不从备份导入。
3. 恢复数据库，将 `recovery_state` 改为本次 quarantined 标记。核对其余所有表的排序行摘要与数量；此管理标记是唯一比较例外。
4. 同一事务中撤销恢复的 bindings、access_credentials、consents、proofs、context_grants、audit_access_grants、data_exports，并使旧挑战到期。原有撤销保持；记录本次权限失效审计，保留主体 ID、公钥、Genesis、事实和原签名字节。
5. 使用独立、足够新的删除账本补齐快照后的取消/审核/执行记录，并重放已经执行的删除；需要准确摘要与事故覆盖截止。仅恢复旧快照中的删除表不足以覆盖快照后的删除，见[删除恢复](deletion-recovery-v1.md)。
6. API 和 Worker 启动时检查隔离标记，隔离库不能正常启动服务。重放不自动开放；失败或账本覆盖不足的恢复候选不得发布。

恢复默认使所有旧授权失效，因此晚于备份发生的撤销不会因回放旧备份重新开放。代价是用户需要重新绑定并授权。独立秘密存储的当前服务密钥、最新可信根/撤销状态和配置版本还须由运营者恢复核对；不会自动信任备份中的旧密钥状态。重新开放属于后续运维流程：先复核候选库、重建最小权限角色、安排新授权，再显式更改隔离状态和切换服务。当前入口不自动执行开放或覆盖源库。

## RPO、RTO 和保留

开发演练目标为 RPO 900 秒、RTO 900 秒，允许在配置中调整。RPO 记录故障时间与事务快照捕获开始时间之差；RTO 记录文件恢复、数据库核对与隔离失效完成所需时间，**不包含重新公开服务的时间**。这不是生产可用性承诺，也不证明实际备份周期达标。

保留候选为最近 7 个日、4 个周、6 个月度快照，按 host/tags 分组。`retention` 只调用 restic forget 的 dry-run，另有prepare-cleanup/cleanup将准确候选固定、到期执行forget/prune/check；未安排生产定时删除；配置版本标签会形成不同分组，版本退役时需要审查其保留组。真实异地故障域、调度、容量预算、访问角色、密码托管和最终保留期仍需部署时落实。

## AI Agent 部署与复验

读取无秘密的配置与回执路径，验证 Node >=24.13、PostgreSQL 工具目录、明确的 restic 二进制版本，使用子进程环境引用传入密码；不将秘密写入配置、Git 或报告。restic 本批使用 0.19.1 官方 Windows amd64 发行包，ZIP SHA-256 为 `da948ad707ed690426473aaba2046cd61f8f90f6f0e7dab6be0d5796531de67d`，与官方发行元数据及 SHA256SUMS 相符；未声称做过 GPG 签名核验。

设置 `GALAXY_TEST_PG_BIN` 和 `GALAXY_TEST_RESTIC_BIN` 后运行 `node packages/galaxy-official/scripts/test-postgres.mjs`，创建临时合成集群；不接受真实 DATABASE_URL 作为测试目标。备份测试会创建两份加密仓库、复制后恢复、比较事实/签名/文件、测试旧凭据与公开投影失效。生命周期测试还会实际启动 API/Worker 验证隔离拒绝。可将 `GALAXY_TEST_BACKUP_EVIDENCE` 指向新的绝对 JSON 路径保存测量回执。未设置 restic 路径的普通 PostgreSQL 回归不包含备份演练。

恢复若失败，保留新目录/新库供诊断；自动清理只针对自身临时备份暂存目录。只在明确确认候选不再需要后移除该准确目标。不要把备份成功、两个本地副本或只读健康检查当成生产灾备完成。

依据：[restic 官方发行](https://github.com/restic/restic/releases/tag/v0.19.1)、[备份命令](https://restic.readthedocs.io/en/stable/040_backup.html)、[恢复命令](https://restic.readthedocs.io/en/stable/050_restore.html)、[仓库检查与复制](https://restic.readthedocs.io/en/stable/045_working_with_repos.html)。

## 历史批次范围（不代表当前未实现）

当前撤销/保留规则以[生命周期](data-lifecycle-v0.1.md)和Schema41清单为准。以下记录保留当时版本。

2026-09-10导出批次：Schema22已将data_exports和data_export_reads纳入数据库备份；恢复会使旧下载记录失效，当前完整备份覆盖32张public表。

Schema24：新增删除申请/事件账本，备份共34张表，恢复保持原始签名和事件。仅恢复账本不是删除重放；执行器上线前须处理快照后的操作来源与防重复执行。

2026-09-10 Schema25：35表/28类本人导出；deletion入口增加createDeletionStatusClient，原生菜单支持无云端会话的回执查询。主库删除执行与保留续跑见[删除流程](deletion-requests-v1.md)。备份恢复保留执行账本；快照后删除重放仍待完成。

准确快照清理、重试和逐仓库结果见[清理操作说明](backup-cleanup-v1.md)。

Schema27的保留字段、到期命令、摘要校验及恢复边界见[回执最小化](deletion-minimization-v1.md)。

Schema28新增37表中的runtime_config_events：API/Worker配置加载、角色变更和分页归档留痕见[运行配置审计](runtime-configuration-audit-v1.md)。实际配置独立复核与生产异地归档仍待完成。
# Backup operation telemetry

The CLI can publish latest action state to GALAXY_BACKUP_STATUS_DIRECTORY. Configure the
same absolute directory in the API for Prometheus collection; status files contain action,
run ID and timestamps, not credentials or repository paths. See [alerting](alerting-v1.md)
for failure/stale detection, scheduling constraints and receiver setup. Status is operational
telemetry and does not replace the existing backup/restore receipt.
