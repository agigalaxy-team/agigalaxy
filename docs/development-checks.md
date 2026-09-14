<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/57/574784a30976a78f5e7023279f8b58dcc20715b9da284fdc84ee7275403e3314.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Development checks and round-two boundaries

Honor scale and concurrent paging: set `GALAXY_TEST_PG_CASE=honor` with the existing `GALAXY_TEST_PG_BIN`, then run `node packages/galaxy-official/scripts/test-postgres.mjs`. The isolated fixture creates 215 collaborations and 62 Proof wrappers through real services, reads paginated results through HTTP/client, and withdraws a later source between internal SQL pages. See [Honor pagination](honor-pagination-v1.md).

The repository root, `packages/galaxy-official` and `packages/galaxy-a2a` have separate package manifests
and lockfiles. Install each using `npm ci`; do not replace a lockfile with a
new dependency resolution during a structural refactor.

```sh
npm ci
npm --prefix packages/galaxy-official ci
npm --prefix packages/galaxy-a2a ci
npm run check
```

`npm test` includes Core, Official and the A2A adapter. `npm run test:core`,
`npm run test:official` and `npm run test:a2a` select one layer. `npm run lint` checks app, packages and
scripts. The runner uses the current Node executable and explicit discovered file
paths without a shell, so it does not depend on Windows wildcard expansion.
Failure and signal termination produce nonzero exits; missing test directories
are errors, not silent passes.

`npm run test:conformance` runs the fixed seven-category local source suite,
including Evidence, independent signature checks and official A2A interoperability.
It writes a new private JSON report with source hashes, per-file results and an
explicit unpublished status. It does not certify an arbitrary registered Worker
or deployed endpoint. See [profiles and coverage](builders-registry-v1.md).

Core retains its declared Node >=22.13.0 boundary. Official and combined checks
require Node >=24.13.0. Current verified development runtime: Node 24.19.0.
Testing on 24 does not prove compatibility on every supported minimum version.

Fast database tests use PGlite. `npm run test:postgres` is a separate real
PostgreSQL gate: set `GALAXY_TEST_PG_BIN` to a directory containing initdb,
pg_ctl, postgres, pg_dump and pg_restore. The runner creates a new SCRAM-protected
cluster on loopback with synthetic data, then stops it and removes its temporary
data. It never accepts an existing database URL. Complete host UI acceptance and
production deployment remain separate gates.

The real database suite checks concurrent binding and Case idempotency, worker
leases and lost-lease recovery, revocation during collection/publication,
transaction rollback, restricted worker access and dump/restore. A passed local
recovery test is not evidence that production backups or network isolation work.

## Refactor compatibility

Shared errors, exact-byte SHA-256 and schemas live in Official `src/shared`.
The old exports from bindings/cases/consents/github-evidence remain available.
Moving a schema must not alter payload bytes, signing headers, field permissions
or error class identity. Local object references and remote UUIDs remain separate:
the Case localRef/source reference link them, not an implicit ID rewrite.

Application services use explicit endpoint/clock/database and authorization
dependencies. The verification process uses `ConsentReader` within the same
transaction as its source/commit checks. It no longer constructs BindingService
or AccessService and has no signing dependency. This code boundary does not
replace operating-system, database-role and egress isolation at deployment.

`services.mjs` is the API composition entry. Its binding, session, proof and
manifest consumers receive different purpose-limited signer closures. The legacy
constructors remain for existing callers; new production code uses composition.

Provision `src/infrastructure/worker-role.sql` explicitly as the database owner
after migrations. Assign its NOLOGIN role to a dedicated deployment login with
no owner/superuser/DDL privileges. The two qualified, fixed-search-path
SECURITY DEFINER functions permit transactional read locks without granting the
worker UPDATE access to Case, binding or consent facts. PUBLIC execution is
revoked. The worker only writes job/observation state and append-only audit rows;
it cannot read access credentials. `api-role.sql` similarly provisions a NOLOGIN
API role with business INSERT/SELECT and only required state/revocation updates.
Its narrow lock functions avoid granting updates to immutable subjects or
evidence. The real PostgreSQL suite runs business services using that role and
rejects DDL, identity mutation, event mutation/deletion and observation-state
forgery. Assign separate deployment logins; do not use the schema owner for either
runtime. Both startup entries reject missing schema or required lock functions.

## Source and policy adapters

Evidence adapters declare a reference schema, source key, queue kind, verifier,
verification function and observation validator. Queue kind is passed as a SQL
parameter; workers only consume their configured kind. The default GitHub adapter
retains `verify-github` and existing source keys. Invalid observations become
unavailable/retry outcomes; adapters cannot claim revocation or generalized
capability certification. Loading untrusted remote plugins is not supported.

`ConsentService` applies mandatory identity, endpoint, freshness, visibility and
disclosure rules before its optional additional policy. Additional policies must
be synchronous local functions returning exactly `true` to allow; they cannot
weaken mandatory checks or perform network decisions while transaction locks are
held. External authorization protocol integration remains a separate task.

## Transaction repositories and fault checks

The binding, access, consent, Case, evidence and Proof repositories capture the
provided database client and cannot acquire another connection. Standalone reads
may use the pool; authorized mutations create repositories inside the transaction
callback. Parent locks still precede consent checks; event/state/audit writes
remain in one transaction and preserve the exact payload text. Worker claims and
commits use separate transactions with external collection between them; commit
rechecks the lease and consent. A failed rollback discards the connection while
preserving the original operation error.

The real PostgreSQL suite now injects failure at the final Case audit write and
checks from a different connection that neither Case nor event survived. It also
upgrades a three-version database without replacing existing facts, races two
migrators, rejects a version gap/future version and verifies that a conflict in
the middle of migration 4 rolls back its preceding CREATE and version records.
Tests use disposable databases, never production migration history. Migration
repair is explicit; there is no automatic destructive downgrade.

For the disposable PostgreSQL runner only, `GALAXY_TEST_PG_FAULT=after-init` or
`after-start` injects a failure. Expected exit is nonzero with a successful cleanup
event. Cleanup inspects `pg_ctl status` even if startup did not return success;
an unknown status preserves data instead of deleting a potentially live cluster.

## HTTP transport and reverse proxies

`http.mjs` owns the server lifecycle, response headers, error boundary and quotas.
`adapters/http/request.mjs` owns strict JSON and Bearer parsing; `routes.mjs`
dispatches business operations; `policy.mjs` validates request targets and resolves
client addresses. Public Proof reads retain optional authentication; writes still
require their original scope. Docs MCP retains its exact Host and Origin checks.

`GALAXY_TRUSTED_PROXY_ADDRESSES` is an optional comma-separated list of exact IPv4
or IPv6 proxy addresses. Empty means forwarding headers are ignored. Do not set
wildcards, CIDRs, hostnames or a trusted hop count. IPv4-mapped IPv6 is normalized.
Only a trusted socket peer may supply `X-Forwarded-For`; its chain is bounded and
parsed from right to left until the first untrusted hop. Missing/malformed chains
from trusted peers fail closed. Only configure addresses whose proxy and network
path you control, and prevent clients reaching that trusted source directly.

Business and GET health/readiness probes have separate bounded quotas (60 and
120 per address per minute by default). Invalid targets and disallowed origins
consume business quota; changing a forged forwarding header on an untrusted
connection cannot reset it. These are per-process quotas, not a distributed
limiter. Readiness still performs its underlying service checks.

The fast HTTP suite exercises these boundaries with loopback requests. Run
`npm run test:caddy` with `GALAXY_TEST_CADDY_BIN` pointing to a verified Caddy
executable for the separate real proxy test. It creates temporary JSON config,
disables the admin API, binds only loopback, and starts/stops its own child
process. Two real loopback client addresses prove separate quotas; changing forged
X-Forwarded-For values cannot reset a quota. Probe requests remain available.
The test requires the OS to support binding 127.0.0.2; it fails rather than silently
skipping if unavailable. It neither installs a service nor requests certificates.

Caddy 2.11.4 was verified against the official release SHA-512 manifest before
local testing. The test does not download binaries automatically. Deployment
must separately verify its exact proxy version, configuration, TLS and network
isolation; passing the local HTTP proxy fixture is not production acceptance.
See https://caddyserver.com/docs/caddyfile/directives/reverse_proxy for the default
forwarded-header behavior. No CDN is included in this fixture.

## Agent execution notes

Discover configuration from package scripts and server/worker source; use the
selected Node executable, install from both locks, and preserve unrelated files.
Never print `.env`, credentials, private signing keys or private case payloads.
Use synthetic test data and isolated temporary directories. Do not migrate a
live database as a side effect of checks. Stop if a compatibility check fails;
rollback the narrow change instead of weakening authorization assertions.

## Core storage and recovery

`local-store.mjs` preserves its 21 public exports. File operations, domain helpers,
application operations and host-independent console definitions are separated.
Snapshot/history/export do not initialize or migrate; incomplete publication or
reset reports recoveryRequired. CLI, MCP command surface and the native adapter
show recovery without automatically opening setup or changing files.

Same-process writers queue; cross-process writes use SQLite exclusive locks.
Node uses node:sqlite and Bun uses bun:sqlite, loaded dynamically. Shared readers
open coordination read-only; missing coordination is never created by a read.
The first-writer race retries under a lock. `.galaxy-coordination.sqlite` has no
business data and stays across reset: never unlink it while clients might use it.
Stop older clients before upgrading; a legacy .galaxy-write.lock fails closed and
is never deleted by guessing its age. The tested runtimes are Node 24.19.0 and
OpenCode 1.18.29's embedded Bun 1.3.14. Other runtime versions still need validation.

Private initialization journals retain the original identity/keypair and initial
state; identity publishes last, and conflicts stop recovery before any missing
file is written. The journal contains private key material: never print, export
or commit it. Reset journals contain no deletion paths; only the code-owned
allowlist is removed. Explicit init/reset resumes pending operations. Unknown
files survive, and read-only access never resumes a journal.

Tests cover four independent writers, 24 same-process queued writes, rejected
operations, shared-read/reset exclusion, five forced initialization terminations,
four forced reset terminations, conflict refusal, legacy data and native menu/
confirmation behavior. `node scripts/check-core-runtime.mjs` (or the host's Bun)
checks actual runtime initialization, concurrency, no-write reads and reset.
The automated native adapter uses a mocked dialog API; real layout is still a
manual gate. No test here establishes power-loss or network-filesystem durability,
production availability, or safety against noncooperating external file editors.

References: https://nodejs.org/api/sqlite.html,
https://bun.sh/docs/runtime/sqlite, https://www.sqlite.org/lockingv3.html.


## 测试文件并发上限（2026-09-09）

统一入口现在使用--test-concurrency=4，限制独立测试文件进程的同时运行数量。35文件默认并发的一次全量执行出现Core进程恢复超时和runner子进程超时；保留原始失败记录。此调整不改变测试内部多客户端/多worker/多进程竞态、不增加超时或跳过测试。各文件使用隔离数据，跨文件调度不作为业务并发验收。

Current round-two orchestration: [layered verification](layered-verification.md). Browser demo module lint is explicitly included. Separate layer outcomes do not imply production release.

客户端发行与16入口离线安装：参见[签名包及消费流程](client-release-v1.md)。传入当前Conformance报告可执行临时密钥签名、安装前核验和准确源码/报告关联；省略报告只执行原有安装检查。

后续审计批次已扩至17入口。audit.test.mjs、audit-menu.test.mjs及local-host-runtime.test.mjs覆盖API、独立审批和既有本机身份签名；PostgreSQL受限角色用同一工作流核对Schema20和历史写入限制。旧Schema18签名报告不覆盖后续源码。

Schema21备份演练：设置GALAXY_TEST_PG_BIN与GALAXY_TEST_RESTIC_BIN执行test-postgres.mjs；可用GALAXY_TEST_PG_CASE=backup或lifecycle只跑对应夹具，始终创建新的合成集群。备份测量见[恢复说明](backup-recovery-v1.md)。

C18-03：设置GALAXY_TEST_PG_CASE=release、GALAXY_TEST_PG_BIN和GALAXY_TEST_CADDY_BIN，运行test-postgres.mjs可单独执行真实Official双发行切换/回滚；单元检查为service-release.test.mjs。见[发行回滚说明](service-release-rollback-v1.md)。

当前导出批次Schema22：25类本人数据，18个客户端入口/15个会话范围。data-export.test.mjs、data-export-menu.test.mjs和PG context工作流覆盖API、分页、本机文件及清理。使用说明见[data-export-v1.md](data-export-v1.md)。

C18退出专项：retirement.test.mjs验证配置阶段、HTTP写入口停止、老主体重绑定、新注册及未完成挑战阻止、取回截止、撤销和删除预览不修改事实；真实PostgreSQL context复用此工作流。

删除申请专项：deletion.test.mjs、deletion-menu.test.mjs、local-host-runtime.test.mjs；PG context使用独立审核角色，backup检查签名申请及事件字节保留。

2026-09-10 Schema25：35表/28类本人导出；deletion入口增加createDeletionStatusClient，原生菜单支持无云端会话的回执查询。主库删除执行与保留续跑见[删除流程](deletion-requests-v1.md)。备份恢复保留执行账本；快照后删除重放仍待完成。

Schema26针对检查：deletion-replay.test.mjs、deletion-spool.test.mjs、failure-spool.test.mjs及既有执行器/HTTP/迁移用例；PG backup包含快照后删除重放，PG context包含受限角色审计队列抑制。客户端源码未改动。[恢复流程](deletion-recovery-v1.md)。

备份清理：设置GALAXY_TEST_RESTIC_BIN后运行node --test packages/galaxy-official/test/restic/cleanup.test.mjs；创建并清理专用合成仓库，不连接真实备份。

2026-09-10回执最小化：11项相关自动测试、真实PG六场景（角色场景修正共享夹具断言后单独重跑）、适配层专用tsc、lint和46文件/19入口便携安装通过。根目录严格tsc --noEmit未通过，错误集中在opencode-stable/galaxy.tui.ts的类型声明；专用适配检查通过不代表根目录严格类型检查通过。

2026-09-10 Schema28：runtime-config.test.mjs、database.test.mjs、deletion-minimize.test.mjs、version-contract.test.mjs共7项通过；新增归档留痕后配置测试复跑通过。真实PG六场景跨两轮通过，首轮生命周期旧Schema断言修正后单独复跑。lint通过；未改客户端/原生代码，不重复安装及类型检查。

2026-09-10治理双签：governance-review.test.mjs、runtime-config.test.mjs和governance.test.mjs共5项通过；真实PG4场景通过，包含API实际加载审核包并关联启动记录；lint通过。Schema28/37表不变，未重复客户端安装、Schema恢复/Caddy回滚或宿主类型检查。

2026-09-10请求额度：request-quotas.test.mjs、http-policy.test.mjs、runtime-config.test.mjs共11个不同测试通过（首次Case成功状态断言201修正为既有200后重跑额度文件）。真实PG4场景和lint通过；实际API加载额度文件、执行分类拒绝并记录配置摘要。客户端、原生代码与SQL未改，不重复这些检查。

2026-09-10资源预算：resource-budgets、cases、evidence、runtime-config共4个不同测试分次通过；资源测试首次审计动作断言修正为既有case.case后通过。真实PG4场景及lint通过，包括跨连接资源回滚、全局/主体租约和实际API/Worker加载配置。Schema与客户端未改，不重复恢复/安装/原生类型检查。

2026-09-10运行指标：metrics与http-policy共9项测试、lint及Official离线npm ci通过；真实PG4个不同场景跨两次运行通过，首次3项通过后修正合成时钟使作业到期，再单独复跑context通过。实际API/Worker指标监听和关闭、受限角色聚合已验证；Schema/客户端未改。

2026-09-10运行日志：runtime-log、runtime-environment、metrics和public-transport共15个不同测试通过，真实PG lifecycle1项、lint及Official离线npm ci通过。新增Pino类型声明使现有node:test注册进入Promise检查；仅在*.test.mjs为node包的test注册配置known-safe例外，普通Promise漏处理仍由哨兵检查拒绝。另显式绑定HTTP响应方法，DNS使用order:verbatim保持原顺序。客户端46文件/19入口重建并离线安装、导入、源哈希检查通过。原生代码未改；根目录严格TS此前失败状态未以本次lint替代。

2026-09-10告警：8项Node相关测试、23组promtool规则场景（19条规则）、Prometheus/Alertmanager配置检查与lint通过；真实restic成功/失败及本机Alertmanager三类触发/恢复投递已验证。外部二进制测试需显式环境变量，命令见alerting-v1.md；不替代真实负责人、目标部署或原根目录严格TS验证。

2026-09-10独立监控：Blackbox配置、Prometheus配置、9组告警规则场景、真实API→HTTPS→Blackbox→Prometheus链路1项及lint通过。覆盖证书、明文、错误body、重定向、仅readiness故障、恢复与观察时间；工具路径及命令见independent-monitoring-v1.md。未部署远程监控或改动官网。

2026-09-10：新增GALAXY_TEST_PG_CASE=capacity，Autocannon独立子进程和真实PG受限角色读写/默认限流/降级撤销通过，4组SLO规则场景及lint通过。短样本不支持目标容量结论，详见pilot-slo-v1.md。

2026-09-10持续负载：GALAXY_TEST_PG_CASE=capacity-sustained通过；960请求/30.22s、96Worker任务和中途撤销，PG清理及lint通过。根严格tsc已复核仍因galaxy.tui.ts类型声明/空值错误失败，需在CL宿主接入批次修复。

2026-09-10：原生接入页已接通显式配置、主动匿名Manifest读取、信息展示、现有本机签名连接和断开后重读；修复根严格TypeScript宿主类型错误。7项相关测试、根严格tsc和lint通过；先前tsc失败为历史记录，现已修复。详见 `docs/configured-native-adapter.md`；实际宿主人工验收及动态部署未完成。

2026-09-10客户端状态更新：补齐Manifest与会话分项状态、信任变化后的状态更新、原生延迟回调取消及完整宿主卸载；复核既有会话隔离和最小签名。23项相关测试、类型检查/lint通过；原生接线现已存在，较早未接线说法为历史状态。当前仍无独立回执档案/钥匙串持久化，实际宿主接线验收保留。见 `docs/configured-native-adapter.md`。

2026-09-10本机回执更新：已确认握手的签名回执独立落盘，接通原生离线历史查看；重启/断开不恢复会话，存储失败与连接结果分开。13项相关测试、离线入口2项补跑、严格类型/lint通过。现已具备独立回执文件，前文缺失回执描述为当时状态；仍无Token落盘、自动恢复、全局安装或动态部署。见 `docs/local-binding-receipts.md`。

2026-09-10原生工具更新：配置工厂接通宿主选中草稿；真实MCP客户端贯通本机签名、宿主批准、发布、履历查询与撤销；交付统一宿主自动化检查入口。`node scripts/verify-layers.mjs --layers=adapter,host-contract`通过（9项宿主契约测试）；分层runner1项和lint通过。真实OpenCode渲染/尺寸/transport仍待验收；见 `docs/native-host-acceptance.md`。

2026-09-10贡献风险：Honor查询及原生菜单接通五类来源化风险提示；仅使用当前可见事实，提示与贡献计数、裁决及处罚分开。4项相关测试/lint通过；无SQL或便携客户端改动，未重复PG/发行包验证。见 `docs/contribution-risk-v1.md`。

2026-09-10争议说明补充：协作争议新增四类举报、带引用的补充和附理由的本人说明纠正；原生准确确认、私有正文及导出联动已接通，原记录保留。Schema28/37表不变；新客户端已完成离线安装。详见 `docs/moderation-statements-v1.md`，旧日期记录保留为历史。

2026-09-10事故处置：事故配置接通API写入/分享暂停、Worker新任务暂停、公开状态和明确恢复；复用撤销处理，配置版本与恢复引用留痕。显式配置 `GALAXY_INCIDENT_FILE`，API和Worker重启后生效。7项相关测试/lint通过，未运行真实多实例切换或外部通知。详见 `docs/incident-response-v1.md`。

2026-09-10事故通知：事故私有站内通知接通运营显式投递、本人分页/已读/偏好、原生收件箱及导出/删除清单；真实API/Worker暂停恢复已验证。当前Schema29/38表，迁移后重应用api-role.sql；新客户端包含incident通知ID和偏好以及新增本人导出集。23项相关测试、隔离PG2项、lint/严格tsc及离线安装通过。详见 `docs/incident-notifications-v1.md`。

2026-09-10信任恢复补充：原生配置读取接通独立根签名服务键清单、持久撤销与旧会话清除；失败/取消不恢复旧信任，重启防回滚，新键重新接入仍须确认。此前待补的客户端撤销链现在已接通并经4项相关测试验证；真实运营及多实例部署仍待复核。见 `docs/incident-trust-recovery-v1.md`。

2026-09-10履历重建：履历新增版本化重建记录、可见来源引用和稳定内容摘要；客户端同会话对照及原生展示已接通，父Case共享锁防止版本混合。旧projectionHash与API响应版本兼容；新客户端已完成离线安装。7项相关测试、真实PG1项、严格tsc和lint通过。见 `docs/history-rebuild-v1.md`。

2026-09-10Profile自述：API/便携客户端及导出/删除已接通；Schema30/39表/30本人导出集/19客户端入口。原生编辑签名与展示仍待完成。见 `docs/profile-statements-v1.md`；动态服务未部署。

2026-09-10Profile宿主：Profile原生编辑、准确预览、本机签名及自述/事实分区展示已接通；默认私有，版本冲突不覆盖，取消与旧页面回调不继续发布。11项相关用例、严格tsc、lint及客户端离线安装通过。C10-03待复核；未全局安装或外部部署。见 `docs/profile-statements-v1.md`。

2026-09-10履历视图与结果：履历新增三类独立字段规则、五类结果时间线及成功报告后的后续结果；读取重算状态/时间与空资料展示接通，Evidence源/Proof/授权/绑定撤销联动已验证，重建规则升级v3。13项不同相关用例、真实PG1项、严格tsc、lint及客户端离线安装通过。见 `docs/history-views-and-outcomes-v1.md`；C10-06直接操作入口仍待补齐，动态服务未部署。

2026-09-11服务发行：service-release.test.mjs两项、GALAXY_TEST_PG_CASE=release隔离PostgreSQL一项及lint通过。每个发行独立离线npm ci安装44个运行依赖，实际API/Worker与Caddy回滚保留事实及撤销；包内发行CLI重新冻结同一文件清单。演练的旧Manifest源码匹配及首次Worker误继承API签名配置先后失败，修正夹具后复跑通过，没有放宽运行时边界。当前357文件候选与通过演练的文件清单摘要相同；生成候选后的进度文档属于随后源码快照，不回写不可变候选。前端托管配置、生成类型及构建和目标Linux/真实身份/TLS未在本批验证。见[发行说明](service-release-rollback-v1.md)。

2026-09-11原子迁移与恢复：database/service-release/runtime-environment共9项检查、真实PostgreSQL concurrency两项、backup一项和release一项、lint通过。复用原41版SQL与三套角色SQL；同事务角色失败回滚已核对DDL、版本及先前权限，实际CLI重复执行不改历史时间。358文件当前候选包含固定迁移入口，包内迁移/API/Worker及Caddy回滚实际通过；44表restic恢复含外部身份失效及删除重放。旧v1 API入口兼容性经原357文件候选只读核验。未重复全量Conformance/客户端封装或人工/目标主机验证；后续进度文档不回写不可变候选。见[迁移说明](database-migrations-v1.md)。

## 需求追溯检查与AI Agent开发入口

先读取仓库AGENTS.md及项目产品基线，按模块定位完整原文、决定与上下游流程。配置发现从package.json、局部开发规则和受控配置样例开始，不读取凭据或.env；本轮不连接真实服务。`npm run check:requirements`执行只读校验，`GALAXY_PROJECT_ROOT`指定匹配资料，`GALAXY_PYTHON`指定Python。缺资料或阅读包过期明确失败，不跳过为绿色。

AI Agent未来部署前应按卷14–16核对具体配置、用户选择的环境和所需权限，先准备可审查候选再执行明确范围。测试、源码候选和历史官网记录不等于当前生产可用；常见错误包括把旧数据/API条数当需求覆盖、将已确认保留期限写成已实施，以及从当前工具能开面板推定所有宿主插件都能嵌入。业务与备份当前继续暂停。
