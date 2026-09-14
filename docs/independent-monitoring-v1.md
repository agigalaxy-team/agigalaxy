<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/5f/5fb60a3fec698522d88f693a3bd7269b26881498e3fcf4af50e1aea1b2a92af9.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Independent monitoring v1

C17-07 local implementation uses Prometheus Blackbox Exporter, Prometheus and the existing
Alertmanager receiver configuration. No separate host, public dashboard or continuous
external monitor has been deployed. The existing official-site /status/ page is an
editorially dated capability roadmap and remains separate.

## What is observed

| Module | Intended target | Observation | Does not prove |
|---|---|---|---|
| galaxy_website_https | Canonical website HTTPS root | Trusted TLS, HTTP 200, no redirect | Official API, identity binding or business availability |
| galaxy_liveness_https | Explicit Official HTTPS /healthz | HTTP 200, JSON status ok | Database readiness or active remote sessions |
| galaxy_readiness_https | Explicit Official HTTPS /readyz | HTTP 200, JSON status ready | A completed Case, backup restore, all worker tasks or end-to-end revocation |

All three use GET, 8s module timeout, no credentials, no payload upload, verified TLS1.2+
and no redirect following. API modules also require application/json and the expected
single status field. DNS resolution is part of HTTP probing; this is not a separate DNS
correctness or every-region availability check. A green website probe must never be used
as a green Official API indicator. Operator-configured target paths must be public probes.

## Configuration and AI-agent deployment

1. Choose a monitor host in a different failure domain from Oracle Kulai. Record provider,
   region, network, power and administrative dependencies in the deployment record.
   Another process or container on the Oracle server is not independent monitoring.
2. Install pinned, verified upstream binaries on that host; use separate process supervision
   and bounded log/storage retention. The local evidence used Blackbox0.28.0 and Prometheus3.13.3
   Windows binaries, not a verification of target Linux packages or service accounts.
3. Copy the complete docs/monitoring directory to the monitoring configuration location.
   Fill the empty target lists in prometheus.example.json with the actual canonical website,
   Official /healthz and /readyz URLs. Empty targets are deliberate: no domain or dynamic
   endpoint is assumed live. Once this monitor is enabled, missing-job rules report them.
4. Start Blackbox with --config.file=<absolute blackbox.json>
   --web.listen-address=127.0.0.1:9115 and Prometheus with
   --config.file=<absolute prometheus.example.json> --web.listen-address=127.0.0.1:9090
   --storage.tsdb.path=<dedicated directory>. Select explicit time/size retention for that
   host. Keep the exporter on loopback: /probe accepts a target parameter and is not a
   public website API. Configure egress only for intended probe destinations where practical.
5. Use the separately configured local Alertmanager on9093 and real role receivers from
   alerting-v1.md. The template has no active external notification integration.
   Monitor this stack's own liveness from another independently operated watchdog; a
   stopped Prometheus cannot evaluate its own missing-job alerts.
6. Run configuration checks and controlled failure/recovery for each selected target.
   Record the monitor location, timestamp, endpoint, TLS result, checked scope, receiver
   acknowledgement and dependency differences. Never claim independence from a hostname alone.

From the code repository root, using explicit upstream executables or PATH:

```text
blackbox_exporter --config.file=docs/monitoring/blackbox.json --config.check
promtool check config docs/monitoring/prometheus.example.json
promtool test rules docs/monitoring/external.rules.test.json
node --test packages/galaxy-official/test/alerting/independent-monitor.test.mjs
```

The integration test requires absolute GALAXY_TEST_BLACKBOX_BIN, GALAXY_TEST_PROMETHEUS_BIN,
and GALAXY_TEST_OPENSSL_BIN. It starts temporary loopback processes and a TLS fixture
forwarding to the actual Galaxy API health handlers. Its fixture CA is installed only
in the temporary probe configuration; production TLS verification remains enabled.

## Freshness and status publication

Read the observation and its source timestamp using the standard Prometheus query API:

```promql
probe_success{job=~"galaxy-external-.*"}
timestamp(probe_success{job=~"galaxy-external-.*"})
up{job=~"galaxy-external-.*"}
probe_duration_seconds{job=~"galaxy-external-.*"}
probe_ssl_earliest_cert_expiry{job=~"galaxy-external-.*"}
```

An API query's evaluation time is not the last probe time: use timestamp(probe_success).
At the default30s scrape interval, show an observation as unknown when source time is
older than90s, when any required target is missing, when up is0, or when the query fails.
Never keep a cached success green indefinitely. Beyond Prometheus lookback, stale source
series disappear; scrape failures and missing-job rules supplement the freshness alert.
If a target is deleted from configuration, per-job missing alerts detect a completely empty
job, not removal of one target among several. Review the configured target inventory on changes.

Public status publication, if later enabled, must include:

- monitor location and actual check scope for each service;
- last observation time in UTC and visible freshness/unknown state;
- separate editorial capability-update date and monitoring timestamp;
- separate website, liveness and readiness results;
- explicit unavailable/not-configured states for unlaunched services.

The official website currently has no connection to these private Prometheus APIs.
Its existing manual status/date remains accurate about that boundary. Do not expose
Prometheus's arbitrary query endpoint through the website or treat its page build date
as a probe timestamp. Add a selected, bounded public projection only when actual monitoring
and the desired public status source are configured.

## Alerts and response

Nine rules cover probe failure, exporter scrape failure, stale observations, three missing
scope jobs, certificate expiry within7days, exporter down and exporter missing.
Most wait2m; missing jobs and expiry wait5m; stale observations wait1m. These are prototype
thresholds, not an availability SLA. Receiver ownership remains operations.

For a probe failure, first check exporter up and source time. Then distinguish DNS/network,
TLS trust/expiry, unexpected status/body and actual API readiness. Check each scope separately.
For certificate alerts, verify renewal and the full configured target name; do not disable
TLS checks. For missing jobs, compare the actual target inventory and loaded configuration.
For stale observations, repair scraper/exporter/process scheduling and confirm a newer
source timestamp. Recheck firing/resolved delivery after fixing the cause.

## Evidence and limits

The local real-process integration verifies trusted HTTPS and current source timestamps;
untrusted certificates, plaintext targets, wrong JSON and redirects fail the readiness
probe. With the actual API readiness dependency returning false, only readiness becomes0:
website and liveness remain1; all recover when readiness becomes true. Processes and
temporary material are removed after the test.

Nine promtool scenarios separately cover delayed alerts and recovery. This is evidence
for local implementation, not actual different-region continuity, public uptime, receiver
availability or a capacity/SLO commitment. Those remain target-deployment work.

Rollback: stop the independent monitor processes or restore their prior configuration,
preserving desired incident evidence. No Galaxy database migration, public website change,
local /galaxy UI change or restart of retired cloud services is required.

Sources:
[Blackbox Exporter](https://github.com/prometheus/blackbox_exporter),
[v0.28.0 configuration](https://github.com/prometheus/blackbox_exporter/blob/v0.28.0/CONFIGURATION.md),
[Prometheus download checksums](https://prometheus.io/download/).
