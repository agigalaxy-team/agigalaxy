<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/0a/0afa90ab0cef1979c8916ac3621918f4d9aceee4955f6117df0624fb7eeed04b.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Operational alerts v1 — local implementation

2026-09-11私有integration：已安装监控并验证四目标/22规则、启停及历史保留；已运行restic定时备份、Schema41/44表7文件隔离恢复与API备份状态采集。最终停止，异地仓库和真实通知未配置。当前路径、版本和限制见[运行说明](integration-operations-v1.md)。

C17-06 implements standard Prometheus rules and Alertmanager routing. No service,
monitor, on-call person or external notification channel is deployed by this document.
Thresholds are initial operating values, not a measured capacity or public SLA.

## Configuration and AI-agent deployment

1. Locate the API and Worker service environments and existing scheduler configuration.
   API and Worker expose metrics only on loopback when GALAXY_METRICS_PORT is set.
   The example uses API 9464, Worker 9465 and local Alertmanager 9093.
2. Set GALAXY_BACKUP_STATUS_DIRECTORY to the same absolute, dedicated directory in the
   backup CLI and API service. Set GALAXY_METRICS_BACKUP_ACTIONS to the scheduled actions,
   default create,check,copy. Missing expected actions produce unavailable metrics.
   Without a directory, backup collection is disabled and these rules do not monitor backups.
   The Worker deliberately does not collect global backup status.
3. Configure GALAXY_METRICS_STORAGE_DIRECTORY for the local filesystem actually used.
   Without it, disk collection is disabled. Remote database storage requires its own
   exporter; the API filesystem cannot establish its free capacity.
4. Copy prometheus.example.yml and alerts/galaxy.rules.json together, preserving their
   relative paths. Configure the optional cost input as documented in operational-metrics-v1.md.
   Confirm backup_collection_enabled and storage_collection_enabled equal 1 for the intended API.
   A successful scrape alone does not prove these optional collectors were configured.
5. Fill owners.example.json with actual owner references and substitutes, then configure
   matching Alertmanager receiver integrations. That inventory is documentation, not runtime
   configuration. The checked-in Alertmanager receivers intentionally have no integrations;
   loading the example does not notify anyone. Use provider-supported secret file references,
   outside the project, when a selected receiver requires authentication.
6. Run the commands below and a controlled firing/resolved delivery to the selected receiver.
   Bind Prometheus and Alertmanager explicitly to loopback and disable unused cluster gossip.
   For an independent monitoring host, use the separately designed protected scrape transport;
   do not expose the metrics port through the public website.

From repository root, with the named upstream tools on PATH:

```text
promtool check config docs/prometheus.example.yml
promtool test rules docs/alerts/galaxy.rules.test.json
amtool check-config docs/alerts/alertmanager.example.json
node --test packages/galaxy-official/test/backup-status.test.mjs
node --test packages/galaxy-official/test/restic/backup-status.test.mjs
node --test packages/galaxy-official/test/alerting/alertmanager.test.mjs
```

The restic and Alertmanager tests require explicit GALAXY_TEST_RESTIC_BIN and
GALAXY_TEST_ALERTMANAGER_BIN paths. They use temporary repositories, synthetic credentials
and loopback delivery. No global installation or actual operator contact is needed.

## Rule coverage

All alert labels retain job/instance where available; missing-job alerts have job only.
owner_role selects operations, identity or data. The grouping also retains alertname.
Each rule has a repository runbook_ref; this is not an already hosted runbook URL.

| Alert | Trigger / pending duration |
|---|---|
| GalaxyTargetDown | API or Worker scrape fails / 2m |
| GalaxyApiTargetMissing, GalaxyWorkerTargetMissing | Expected job has no up series / 5m |
| GalaxyDatabaseCollectionFailed | Enabled database collection failed / 2m |
| GalaxyStorageCollectionFailed | Enabled filesystem collection failed / 2m |
| GalaxyStorageLow | Configured filesystem available fraction below 10% / 5m |
| GalaxyJobQueueDelayed | Oldest open job older than 300s / 5m |
| GalaxyQuotaRejections | More than 5 quota rejections per 5m, by category / 5m |
| GalaxyAuthenticationFailures | More than 20 HTTP 401/403 per 5m and over 50% of requests / 5m |
| GalaxyRevocationRequestFailed | Revocation endpoint HTTP 5xx increase / 1m |
| GalaxyRevocationJobsDelayed | Directly revoked Consent/binding has open work older than 60s / 2m |
| GalaxyRevocationDependencyJobsDelayed | Direct/ancestor authorization revocation has open work older than 60s / 2m |
| GalaxyRevocationSearchResidue | Stored candidates reference revoked Consent/binding / 2m |
| GalaxyRuntimeLogUnavailable | Diagnostic sink not ready / 1m |
| GalaxyRuntimeLogLoss | New write failures, drops or rotation warnings in 5m / 1m |
| GalaxyBackupStatusUnavailable | Expected action status unreadable, invalid or missing / 5m |
| GalaxyBackupFailed | Latest completed action failed / 1m |
| GalaxyBackupStuck | Latest action running longer than 1h / 5m |
| GalaxyBackupStale | create/copy success older than 24h, check older than 7d / 10m |
| GalaxyCostBudgetExceeded | Supplied amount above budget within supplied current period / 5m |
| GalaxyCostInputStale | Optional cost observation older than 24h / 10m |
| GalaxyCostInputUnavailable | Configured cost input unreadable or invalid / 5m |

The counter windows may delay recovery until old failures leave the window.
runtime_log_events is a process-lifetime monotonic gauge; increase treats process reset as
a counter reset. These diagnostics are best effort, not an exact loss ledger.
No last-success metric is emitted before a backup's first success: missing, failed or
running-state alerts cover that interval. A new action run temporarily replaces the
failed-attempt signal; a stuck run is detected separately.

## operations

First locate the job and instance from the alert. For scrape/collector failures, inspect
the process, configured listener and fixed diagnostic events; distinguish stopped service,
unreachable endpoint and failed database query. Restore the failing dependency and confirm
fresh metrics rather than silencing the symptom.

For low disk, queue delay or quota rejections, inspect queue state, active leases and
configured budgets. Pause optional ingestion or reduce concurrency if needed; preserve
withdrawal/revocation paths. Check owned retention candidates before deleting anything.
Do not enlarge quotas without measured capacity. Local disk alerts say nothing about a remote
database volume. Quota denials can be normal for an over-limit subject.

For log failure/loss, check the configured directory, service-account write access,
disk and rotation policy. Restore the sink or switch to supervised console logging.
Confirm readiness and a new test diagnostic. Critical database audit is separate.
Cost inputs may be estimates; compare the actual provider record, refresh the supplied
observation using an atomic file replacement; the process reloads it at the next cached collection (normally within15s). A failed read removes old cost values while retaining last-success time. See [cloud collection](cloud-cost-and-host-network-v1.md). Choose an explicit
budget action with the owner; a stale file is not evidence of current spend.

## identity

401/403 bursts may be expired sessions or expected policy denials. Correlate fixed request
IDs, server audit results and recent client/configuration changes; never log raw credentials.
Check time, binding status and Consent scope before changing access configuration.

For failed revocation, inspect the affected audit result and database availability.
Confirm the authoritative revoked state, retry the documented idempotent operation and
observe open jobs drain. If it cannot be confirmed, suspend affected optional processing.
The legacy job alert retains its direct Consent/binding definition. The dependency alert also covers Case/Attempt/Result, revalidation command, and Builder declaration/node-control authorization. Search residue reports stored candidates, while serving reads still check current sources. Inspect queue/lease health and trigger/restore behavior. See [revocation observations](revocation-observability-v1.md); none of these gauges proves deletion of external copies.

## data

Read the per-action status and the operation receipt separately. Check scheduler execution,
repository access, free space and fixed CLI failure markers. A process killed mid-run leaves
running state and later triggers the stuck rule. Repair the cause and rerun the exact action.
Do not treat a status file as a restic integrity check or a successful restore.
After backup failure, verify a new successful receipt and schedule the documented isolated
restore exercise where appropriate.

Each action has one latest-attempt record and its last known success, not an audit history.
Use one scheduled writer per action. The run-ID check rejects a sequential older completion;
it is not a process lock or a concurrency-safe compare-and-swap. Status writes use a temporary
file plus rename. Telemetry failure does not cancel backup data work, but emits
backup_status_unavailable and makes the CLI exit nonzero. A malformed status file must be
archived/repaired explicitly before new status can be recorded.

## Validation and remaining deployment work

22 standard rules have synthetic delayed-firing and recovery fixtures. The real Alertmanager
test delivers both states to all three role routes on loopback. The backup CLI test runs
restic init/check successfully, then checks a missing repository and verifies the previous
success timestamp survives failure. This does not validate any real cloud repository.

Still required: actual owner/substitute assignment, receiver integration and receipt,
target service account/directory permissions, schedule and threshold calibration, independent
fault-domain monitor (C17-07), and the original release gates. Rollback: unload the rule file
or restore previous receiver configuration; unset the backup status directory to disable
the optional telemetry. No schema migration or backup deletion is required.

Upstream formats:
[Prometheus rule tests](https://prometheus.io/docs/prometheus/latest/configuration/unit_testing_rules/),
[Alertmanager configuration](https://prometheus.io/docs/alerting/latest/configuration/).

2026-09-10：独立探测配置和9条外部监控告警已完成本机验证，见[independent-monitoring-v1.md](independent-monitoring-v1.md)。真实不同故障域部署仍待配置。
