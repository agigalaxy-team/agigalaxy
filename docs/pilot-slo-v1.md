<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/6c/6c18608257e3c9611d07571dac5d72bc4f32f58bc5b2052433892db40209331e.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Pilot SLO and capacity baseline v1

C17-08 candidate for operational review; C17-01/C17-03 target-host calibration remains in progress.
This is an internal measurement profile, not a public SLA or a frozen production capacity.
The existing request/resource budget defaults have not been increased from local measurements.

## Candidate objectives and exact measurement

The versioned candidate is slo/pilot-profile.json:

| Indicator | Candidate | Measurement |
|---|---|---|
| HTTP service reliability | 99.5% over rolling30days | Eligible completed2xx/3xx/5xx/499;5xx and499 are bad |
| Successful request latency | 95% within1second | API2xx response duration histogram, excluding health/readiness probes |
| Open queue age | Initial alert at300seconds | Existing job age metric; not an end-to-end completion promise |
| Direct revocation work | Initial alert after60seconds | Existing direct Consent/binding revocation job metric |
| Capacity | Unapproved | Requires sustained target-host measurement and operator choice |
| Monthly cost | Unspecified | Requires actual billing source, currency and chosen budget |

401/403 and other expected4xx, including policy429, are excluded from this HTTP error-budget
denominator. Rate-limit volume is monitored separately; this avoids equating rejected load
with successful business throughput. 499 is conservatively counted as bad even when the
client closed the connection. Bad requests mistakenly returned as2xx cannot be identified
by status alone. Health/readiness requests are separate external probe indicators.

Missing traffic or missing telemetry is unknown, not100% reliability. At least two counter
samples and a nonzero eligible denominator are needed. A30day rate requires sufficient
retention and observation history; do not advertise30day results from a short deployment.
The rule groups preserve job/instance/component and do not merge unlike installations.

The error budget is0.5% of eligible requests. It is a request-count budget, not a number
of allowed outage minutes. Fast burn requires both5m and1h error fractions above14.4 times
the budget fraction; sustained burn uses30m and6h above6 times. Short pending periods
(2m/5m) reduce startup noise, but can miss very short bursts; inspect raw failures as well.
Latency alerts require the5m good fraction below95% for10m.

## Install and freeze

The SLO rules are optional and are not loaded by the current generic Prometheus example.
After selecting the pilot objectives, copy slo/pilot.rules.json with the existing rules
and add its actual path to rule_files. Keep pilot-profile.json and threshold constants
in the rules synchronized; the JSON profile is documentation, not a runtime rule generator.

```text
promtool check rules docs/slo/pilot.rules.json
promtool test rules docs/slo/pilot.rules.test.json
```

Four rule scenarios cover fast burn, sustained burn, latency recovery, and correct treatment
of absent error series,429 and readiness failures. These supplement the existing alerting
and independent-monitoring rules, rather than replacing the three probe scopes.

Before changing the profile from candidate to frozen, record the operator, eligible
service/traffic mix, endpoints, monitoring history, target capacity, billing source,
monthly budget and exact rule/configuration hashes. Existing operating choices remain
unassigned; a local test cannot silently select a real financial commitment.

## Reproducible capacity test

Use the existing isolated PostgreSQL launcher, with GALAXY_TEST_PG_BIN pointing to the
PostgreSQL binary directory and GALAXY_TEST_PG_CASE=capacity:

```text
node packages/galaxy-official/scripts/test-postgres.mjs
```

Install the Official package from its lock first. Autocannon8.0.0 is an exact development
dependency only. The launcher creates a new temporary SCRAM cluster; it never accepts a
remote database URL. The benchmark uses the restricted galaxy_api role and an8connection
pool, signed fixture identities and real Consent/Case operations.

Autocannon runs in a separate child process. Synthetic credentials and prebuilt requests
travel only through local IPC; reports contain aggregate timings/counts, not those payloads.
Normal capacity phases use1/4/8 HTTP connections, one subject per lane and96 requests per
phase, with elevated request frequency limits to avoid conflating quota responses with
successful operations. Resource limits remain the current defaults. A separate phase
restores default request quotas and sends64 requests through one subject/credential.

Each write phase checks that all96 distinct Cases committed. The default-quota phase
checks exactly30 commits and34 HTTP429 responses, then a successful binding revocation.
A final phase sets the actual AccessService payload-growth allowance to0 and verifies
new Case rejection plus successful revocation.

Reports are new outputs/capacity/baseline-<timestamp>.json files. Preserve the chosen report
with the progress evidence. It includes Node/PostgreSQL versions, basic host resources,
connection count, latency distribution, response/status totals, response bytes, API-process
CPU/RSS/event-loop delay, database size growth and generator CPU/RSS.

## Verified local baseline — 2026-09-10

Source: outputs/capacity/baseline-1789009705086.json. Node24.19.0, PostgreSQL18.6,
Windowsx64,20 logical CPUs and approximately20GiB memory. This is not the Oracle host.

| Connections | Write requests / P99 | Read requests / P99 |
|---|---|---|
| 1 | 96 /54ms | 96 /19ms |
| 4 | 96 /120ms | 96 /32ms |
| 8 | 96 /136ms | 96 /30ms |

All576 requests in these six phases returned200, with no connection errors/timeouts.
The64request default burst returned30 successes and34 quota denials; subsequent revocation
completed in52.66ms. With payload growth disabled, a new write returned409 while revocation
returned200. The temporary cluster was stopped and removed.

The finite phases lasted roughly1–2seconds. Autocannon's per-second samples are therefore
too short to estimate saturation throughput; the reported96requests/second is not a
production limit. Consent generation is outside the measured interval; payloads are small.
This excludes sustained warm/cold behavior, TLS, reverse proxy, network, Worker external
fetches, PostgreSQL CPU, other tenants and cloud billing. API RSS also includes the fixture
setup process, not just a production server's request handler. PostgreSQL growth includes
page allocation and is not a per-object billing rate.

## Capacity and cost decision

Retain current default1MiB logical payload/subject,32 queued jobs/subject,
3 active exports/subject,4 global Worker leases and1 lease/subject pending target measurements.
These are operating limits, not an assertion that the host can serve the implied maximum.

Next target run must use a fixed traffic mix, realistic payload sizes, sustained arrivals,
simultaneous Worker load and observed database/CPU/disk/network headroom. Measure successful
throughput separately from rejection rate and test withdrawal/revocation during overload.
Record saturation and a chosen operating margin before freezing concurrent subjects or RPS.
The present local harness establishes reproducibility and baseline behavior only.

For cost, combine the actual dated provider bill with observed storage/network/compute
usage and successful workload counts. Keep estimates labeled as estimates. No monetary
amount or cost-per-request is inferred here; the existing metrics cost input remains explicit.

## Degradation and recovery

1. For persistent overload, reduce optional ingestion and Worker concurrency using existing
   request/resource budget configuration. Keep revocation in its separate request category.
   Setting maxPayloadBytesPerSubject to0 stops growth; it does not delete stored objects.
2. Preserve authorized existing reads and export within their distinct quotas. Do not use
   blanket proxy blocking that also removes revocation/status routes. Individual control
   requests can still fail under process/database outage; separate quotas are not infinite capacity.
3. Use the documented retirement policy only for an actual service withdrawal decision,
   not as an undocumented substitute for temporary overload handling.
4. Restore traffic gradually after source metrics are fresh, error burn and queue age recover,
   and an actual revocation request succeeds. Record the selected configuration and results.
5. Local Galaxy work remains governed by its local-only flow. This batch changes neither
   /galaxy nor client initialization, and starts no remote connection.

Rollback of this batch: remove optional SLO rule loading and stop the local benchmark.
No production quota, schema, identity or cloud account setting was changed.

References:
[Autocannon API and limitations](https://github.com/mcollina/autocannon),
[Google SRE multi-window error-budget alerting](https://sre.google/workbook/alerting-on-slos/).

## Sustained mixed-load extension — 2026-09-10

Run the same isolated launcher with GALAXY_TEST_PG_CASE=capacity-sustained.
The driver now accepts an explicit overall request rate. The test supplies960 requests,
8 connections and32 requests/second:480 distinct Case writes alternate with480 reads.
Pre-signed Consent setup remains outside the measured interval. Request frequency limits
are elevated for calibration; resource limits retain4 global and1 per-subject Worker leases.

Source: outputs/capacity/sustained-1789010179641.json. The actual measured HTTP phase lasted
30.22seconds, completed960 HTTP200 responses at32 requests/second, with P99 latency233ms,
zero connection errors and zero timeouts. Concurrent Worker services completed96 jobs:
95 observed synthetic evidence and1 revoked. The planned revocation at approximately15seconds
received an acknowledgement in61.64ms and the corresponding job ended revoked.

137 queue/resource samples observed no more than4 active global leases or1 per subject.
Workers were still active through approximately35.4seconds and then drained the queue.
The API and Worker services share one Node process with separate restricted PostgreSQL
roles/pools; this is not a measurement of separate production process overhead. Sampled
combined RSS peaked at179.6MiB including fixture setup. The external verifier supplies
synthetic evidence with a1second delay; it does not call GitHub or verify real user work.

The report now proves a sustained offered32requests/second workload for this local fixture,
not maximum capacity, a long soak, target Oracle performance or a cost model. It supports
review of the local implementation and candidate policy; target-host calibration,
operating margin, real billing and operator freeze remain outstanding. No defaults were
increased and no remote service was started.

## Current metrics-enabled run — 2026-09-11

Source: [sustained-1789066207232.json](../outputs/capacity/sustained-1789066207232.json).
Schema41, real PostgreSQL18.6, Node24.19.0. The same eight-subject workload now enables
actual API counters and database collection with the default15s cache. Over30.28seconds,
960 business requests completed HTTP200, P99 155ms, with no errors/timeouts. All96
Worker jobs finished (95 observed,1 revoked), and the concurrent revoke acknowledged in57.25ms.
Global4/subject1 leases and final empty queue were asserted from actual database state.

Counters measured961 requests including the revoke,451202 incoming consumed-body bytes,
and797351 outgoing body bytes; database collection succeeded. The load driver separately
counts transport response bytes, so these numbers need not equal its1133760bytes.
Incoming metrics exclude unread rejected bodies; neither counter measures NIC or billable traffic.
This single run does not prove a performance improvement over the previous233ms sample.
Actual target capacity, monetary calibration and provider/runtime deployment remain open.
