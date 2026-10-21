<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为银河产品方案（维护工作区资料，未随源码分发），其中候选和已确认方向分别标记。迁移前原样快照（维护工作区资料，未随源码分发）保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Galaxy Official — implementation in progress

Standard [independent monitoring](../../docs/independent-monitoring-v1.md) templates now separate website, API liveness and readiness. Real-process local validation passed; remote fault-domain deployment remains pending.

Operational alert rules, backup status telemetry and role-based receiver configuration are implemented locally. See [alerting](../../docs/alerting-v1.md). Real owners, receivers and independent monitoring deployment remain unconfigured.

API/Worker/migration entrypoints use fixed-field JSONL with optional bounded file rotation, gzip and archive retention. Sink failures and dropped diagnostics are visible in metrics. See [runtime logging](../../docs/runtime-logging-v1.md). Target service accounts/ACLs and alert receivers remain deployment work.

API and Worker now expose optional independent loopback Prometheus metrics. HTTP outcomes/latency, jobs, database/filesystem aggregates and explicit cost inputs are covered; no inferred verified-capability or local-ID count. See [operational metrics](../../docs/operational-metrics-v1.md). No dynamic service or monitor deployment.

Current HTTP runtime uses request-category quotas, with verified subject/credential limits and independent revocation capacity. See [request quotas](../../docs/request-quotas-v1.md). These counters are process-local; transactional storage/export/job budgets are integrated; actual cost/load calibration is pending. See [resource budgets](../../docs/resource-budgets-v1.md). Schema28/37 tables unchanged; no dynamic deployment.

Current Schema28:37 tables. API/Worker loaded configuration observation, role diffs and paginated operational archives are implemented. See [runtime configuration audit](../../docs/runtime-configuration-audit-v1.md). Independent governance review/application is implemented; see [governance review](../../docs/governance-review-v1.md). Production archives and real operator acceptance remain pending. Earlier batch notes below are historical; no dynamic deployment.

Current Schema27:36 tables,28 own export datasets,19 client entrypoints. Receipt minimization, quarantined deletion replay and exact snapshot cleanup are implemented. See [receipt minimization](../../docs/deletion-minimization-v1.md). Production retention/capture/storage configuration remains pending; no dynamic deployment. Earlier batch notes below retain their historical scope.

Current Schema25: reviewed owner-data deletion, retention resumption, deletion status with the original local identity,35 tables and28 export datasets. See [deletion workflow](../../docs/deletion-requests-v1.md). Backup replay/minimal receipt cleanup remain pending; no dynamic deployment. Earlier dated notes retain their original scope.

2026-09-10 latest: database schema20 adds own-subject audit queries, independently signed time-limited reviewer approvals for cross-subject access, JSON export and transactional query/export records. Client17 entrypoints and14 explicitly requested session scopes are supported. See [audit access](../../docs/audit-access-v1.md). The schema19 durable failure outbox remains active; see [delivery and recovery](../../docs/failure-audit-delivery-v1.md). Local, isolated PostgreSQL and actual-process checks passed; no live deployment. Earlier dated notes below describe their implementation batches.

This package is the developing Official service within the existing Founding Beta repository. It is not a deployed endpoint or a complete M0–M5 release.

2026-09-10: capability-specific qualification and moderation reports/pauses/appeals are implemented through API, clients and native host flows. See [behavior and configuration](../../docs/qualification-moderation-v1.md); optional public configuration path `GALAXY_GOVERNANCE_CONFIG`, database schema 15. No live deployment.

2026-09-10: source-derived contribution/Honor cards, scoped ranking suppression and native read-only views are implemented. See [rules and limitations](../../docs/honor-contribution-v1.md); schema remains 15.

2026-09-10: Capsule versions, Case-linked applications/rechecks, maintenance notices and native flows are implemented. See [Capsule behavior](../../docs/capsule-v1.md). That batch introduced schema 16; no live deployment.

2026-09-10: Worker/Bridge/Hub registration, versioned declarations, assessor-reported compatibility, owner heartbeats, limited owner CI references and maintenance events are implemented through HTTP and the `/builders` client. See [builder registry scope and deployment](../../docs/builders-registry-v1.md). That batch introduced schema18; native declaration/maintenance/report forms and local signer composition are connected. Node-key-holder approval and revocation of an exact owner declaration are implemented using existing signed Consent. Portable Conformance snapshots and local source runner are implemented. Endpoint control, third-party execution and real host acceptance remain pending. No live deployment.

## Implemented local interfaces

| Route | Current behavior |
|---|---|
| GET /healthz, /readyz | Minimal process/database availability |
| POST /v1/binding-challenges | Validate genesis opening and issue a 180-second signed challenge |
| POST /v1/bindings | Verify client signature; atomically consume challenge, create binding and audit |
| POST /v1/session-challenges | Issue a 120-second challenge binding a client credential hash |
| POST /v1/sessions | Activate a short-lived credential after local-key signature |
| GET /v1/bindings/{id} | Authenticated subject-owned status |
| POST /v1/bindings/{id}/revoke | Authenticated subject-owned revocation, linked credential invalidation and audit |

Requests must use JSON with the exact fields defined in `http.mjs`. The initial default scope is `binding`; explicit new bindings may additionally request `consent` for consent management; it grants no Case/Proof/Context publishing. A binding receipt is not a bearer credential. Private operations accept `Authorization: Bearer <credential>`, never credentials in URLs.

The client creates a cryptographically random 32-byte credential encoded as unpadded base64url, retains it locally, and submits only its SHA-256 hash when requesting a session challenge. It verifies and explicitly approves the challenge, then signs its exact UTF-8 bytes with compact JWS, algorithm `Ed25519`, and type `galaxy-session-response+jws`. The service stores only the hash; activated credentials expire within ten minutes and cannot outlive their binding. Repeated activation returns the same acknowledgement without issuing extra credentials. Binding uses type `galaxy-binding-response+jws`, plus the client session secret returned with its challenge. Neither generic signing nor automatic approval is exposed by this package.

These protocols still require the real client approval UI, pinned Manifest distribution and integration testing. The current HTTP tests use localhost and synthetic identities.

## AI-agent deployment instructions

1. Discover configuration by name only: `GALAXY_ENVIRONMENT`, `GALAXY_ENVIRONMENT_DIRECTORY`, `DATABASE_URL`, `GALAXY_ENDPOINT`, `GALAXY_SIGNING_KEY_FILE`, `GALAXY_SIGNING_KEY_ID`, `GALAXY_ROOT_PINS_FILE`, `GALAXY_KEYRING_FILE`, `GALAXY_TRUST_DIRECTORY`, `GALAXY_OPERATOR`, `GALAXY_REGION`, optional `PORT` and `GALAXY_LISTEN_HOST`. Do not print resolved secrets or connection exceptions. Signing validity comes from the root-signed keyring in epoch seconds. Endpoint must be a canonical HTTPS origin.
2. Use Node >=24.13.0, `npm ci --ignore-scripts` and `npm test`; production uses PostgreSQL through `pg`, while PGlite is a development-only embedded test engine. Run as a non-root account. Provide an Ed25519 PKCS8 key through a private file (Unix permission bits must exclude group/other); keep private keys and database credentials outside the repository and build artifacts.
3. Apply `npm run migrate -- --roles=api,worker` with a dedicated deployment database role before `npm start`; omit `--roles` to preserve schema-only behavior. Schema and selected role SQL share one transaction. Startup checks the exact supported schema and does not migrate implicitly. See [migration and role setup](../../docs/database-migrations-v1.md), [immutable service releases](../../docs/service-release-rollback-v1.md) and [isolated recovery](../../docs/backup-recovery-v1.md). Target host, login identities and deployment remain separate work.
4. Default listening is loopback `127.0.0.1:3001`. For an isolated container, `0.0.0.0` can be selected explicitly; do not publicly publish that port. Terminate HTTPS at the scoped reverse proxy and keep the database private. Runtime readiness requires at least one remaining day of signing-key validity.
5. Verify process/readiness and actual HTTP signature, session and revoke paths externally after a deployment. Missing configuration must fail with a generic startup error. Logs contain only generated request ID, status and error code; bodies, authorization headers and database errors are excluded.
6. Configure the exact trusted proxy and [scoped Caddy routes](../../docs/official-proxy-isolation.md), then the [request quotas](../../docs/request-quotas-v1.md). HTTP quota counters are process-local; database resource budgets and leases are separate. Current monitoring and recovery implementations require target configuration and measured operating limits before public acceptance.

Synthetic local PostgreSQL tests cover concurrency, prefix upgrades, transactional failure and restart/restore behavior. Prior production deployment upgrades, native-host user experience and public TLS require their own target evidence. Tests do not create customer data or real identities.

Manifest discovery is implemented at `/.well-known/galaxy-network.json` with ETag revalidation. The read-only discovery client accepts pinned keys and never marks discovery as a binding. Local keyring rotation and host integration are implemented; production root distribution and actual-host acceptance remain separate tasks.


## Trust and rotation implementation

The API now requires a root-pinned configuration and signed service keyring at startup. Both public files use the strict schema in trust-keyring.mjs; the root pin configuration is a locally trusted release artifact, not downloaded from the endpoint it authenticates. The root private key is only an input to the separate issueKeyring function and is not loaded by the API process. Production root generation, release pin distribution and scheduled renewal remain deployment work.

Service keyrings expire within 24 hours. Every reissue increments sequence, including renewal with unchanged keys. The endpoint-specific trust store persists the highest accepted version and revoked key IDs before returning usable keys. Reusing a key ID for different key material, reviving a revoked ID, rollback and conflicting same-sequence documents fail. Overlapping nonrevoked keys allow transition; a revoked key fails immediately once the updated keyring is received. Offline clients cannot learn an unpublished revocation; expired trust fails closed.

Root replacement is a separate trusted release/configuration update. Resetting the local trust directory is not a recovery shortcut: it discards rollback history and requires an explicit recovery record. Stale lock files fail closed and require checking the original process before removal. Keyring publication is at /.well-known/galaxy-signing-keys.json; service key status does not itself confer trust. This implementation does not claim that production root custody, renewal, real-key rotation or rollback drills have been performed.


## Public Docs MCP

`POST /mcp/docs` uses locked `@modelcontextprotocol/server`, `node`, and test `client` packages at 2.0.0, whose installed transport negotiates MCP 2025-11-25 (a newer authorization chapter is not a transport support claim). The server is stateless with JSON responses. It exposes eight reviewed Markdown resources (four topics in current v0.2 and four unchanged v0.1 documents), a versioned resource template, `docs_get`, `docs_search`, and user-invoked installation/privacy explanation prompts. No identity or private filesystem APIs are registered. GET/SSE is not supported; unknown protocol versions, Host/Origin mismatches and oversized bodies are rejected.

The authoritative content is the website's explicitly authored `docs` (v0.1) and `docs_v02` mappings. `python scripts/build_public_docs.py` extracts those literal mappings without executing the website builder or scanning project documents; `--check` detects drift. The generated public-docs.json is a deployable snapshot, not an independently edited source. Rebuild and recheck it whenever the public docs change. Its current wording accurately retains the pre-public-deployment status; update the common source when the dynamic service is actually published.

A real SDK HTTP client integration test covers listing/reading, templates, tools, prompts, unknown documents, illegal topics, unsupported protocol, incorrect Host/Origin and body-size rejection. This is local integration evidence, not verification of a public endpoint or all third-party clients.


## Remote consent foundation

Schema migration 3 adds remote consent metadata. POST /v1/consents accepts only a locally signed intent; GET /v1/consents returns subject-owned pages of up to 100 items with an optional UUID `after` cursor; POST /v1/consents/{id}/revoke invalidates it. These routes require the independently requested `consent` credential scope. Existing binding-only credentials are not upgraded. This scope manages authorization records and does not grant data upload.

Consent compact JWS uses Ed25519 and type galaxy-consent+jws. Its strict schema records endpoint, subject/binding, action, object, recipient, fields, purpose, visibility, policy version, expiry and SHA-256 of exact UTF-8 payload JSON. This is distinct from a local Consent receipt; no conversion silently grants network permission. Research/training/commercial purposes and raw credential fields are rejected.

Protected handlers must call AccessService.runAuthorized and ConsentService.require in the same database transaction as the data effect. The latter checks live consent/binding state, exact object/action/recipient and payload bytes, then validates declared top-level fields. A domain-specific payload schema and minimization filter remain necessary before any data handler accepts input. canReadProjection is only the visibility part of authorization, never a substitute for live database checks. Background jobs must recheck before committing work.

Case/Proof/Context handlers, cache/projection revocation propagation, retention/deletion and backup replay remain unimplemented. Current consent tests prove the local foundation, not the entire C06 module or public privacy policy.


## Case event chain

Migration 4 adds subject-owned cases and append-only Case/Attempt/Result/Revision/Withdrawal events. POST /v1/cases creates a case; POST /v1/case-events appends the other kinds; GET /v1/cases/{id} reads the authorized aggregate. The generic event route is the current implementation of the previously proposed per-kind API paths; it is documented here pending final API freeze. Requests require an explicitly requested case-teaser credential scope plus a matching signed case.teaser.publish consent for each exact payload. Existing credentials do not acquire this scope automatically.

A local Case Draft ID maps to localRef; title and a reviewed failureSummary map to title/summary. Original attemptedApproaches may become ordered Attempt events only after distinct review/consent. Configuration carries environment/version/tool names, without runtime secrets. Result carries outcome, failure reason and limitations, and is always unverified. A succeeded result only moves the case to resolution-proposed. Revisions retain the referenced original event. Local IDs/history are not rewritten; participant references are submitter assertions, not verified contributions.

Source reference is the canonical original work reference and must survive forwarding through local/Bridge/Hub. Uniqueness by subject/localRef and subject/source reference prevents duplicate cases when a routing alias changes. Full Bridge provenance reconciliation remains future work. Expected version and attempt sequence serialize updates; a provisional case insert is rolled back if consent fails. Reads and writes lock parent before consent to keep a consistent lock order. The current aggregate limit is 1000 events; it is an implementation safety bound, not a measured public quota.

All event grants and bindings must remain active for an aggregate read. If a grant is revoked, the aggregate is withheld rather than returning stale authorized content. Search/Proof projections, independent verification and deletion/export recovery are not implemented by this module. Tests use synthetic subjects and cases only.

## Local Open Assistance implementation

Schema12 adds persisted requests and append-only participant events. Authenticated POST `/v1/assistance`, POST `/v1/assistance/{id}/events` and GET `/v1/assistance/{id}` use the explicit `assistance` scope; writes require each actor's exact-payload `assistance.publish` Consent. The `/assistance` client export and trusted host controller/runtime are wired. Authenticated POST `/v1/assistance/query` provides open/requested/participating search and pagination. The native collaboration menu and guided Consent signing are wired in the local host runtime. Independent selected-text Context grants are implemented; payment and capability verification are not enabled; guided previews are currently in memory. See [Open Assistance rules and API](../../docs/open-assistance-v1.md) for payloads, participant views and whole-thread revocation limitations. Not deployed.

## Selected text Context grants

Schema13 adds a separate requester grant and provider acceptance before selected text can be read. The `/context` client, local signing flow and native materials menu are wired. Independent context scope is required; read checks reject changed/canceled collaboration, expired/revoked grants and stale Consent. Only selected text excerpts are supported; no filesystem, execution or production permission is granted. See [Context grant API and boundaries](../../docs/context-grants-v1.md). Dynamic services are not deployed.

## Local inbox and requester history

Schema14 persists inbox preferences/read markers; messages are derived from current authorized assistance/material events. Signed bounded invitations, explicit unsubscribe/mute controls, and requester history with provider-attributed feedback are implemented. The notifications client and native menu require the notifications scope; requester history uses assistance. No external messages or push delivery are enabled. See [inbox and history API](../../docs/notifications-requester-history-v1.md). Not deployed.

当前Schema21：新增restic加密备份、第二仓库复制、数据库/配置/对象/SQLite恢复与隔离启动，见[备份恢复](../../docs/backup-recovery-v1.md)。旧版段落中的未实现状态按其日期保留；当前进度以项目v0.6任务计划为准。

服务发行可由scripts/service-release.mjs冻结，API/Worker支持发行目录、manifest摘要与配置版本关联，API返回X-Galaxy-Release。数据库不兼容时拒绝应用切换预检；见[运行说明](../../docs/service-release-rollback-v1.md)。

当前Schema22：data-export独立范围提供25类本人数据分页导出，原生菜单可保存NDJSON和manifest；Worker清理短期下载记录。跨主体授权视图的打包仍待补，见[本人数据导出](../../docs/data-export-v1.md)。

可选停服策略：API和Worker使用同一GALAXY_RETIREMENT_FILE，公开/v1/service-status；分阶段停止新增业务、限制取回期限并保留状态查询。默认未启用。[策略、演练和删除处理](../../docs/service-retirement-v1.md)。

删除请求：data-delete范围、签名受理/取消、本人查询及独立角色审核账本；没有物理删除执行器。[接入与运营说明](../../docs/deletion-requests-v1.md)。

2026-09-10事故处置：事故配置接通API写入/分享暂停、Worker新任务暂停、公开状态和明确恢复；复用撤销处理，配置版本与恢复引用留痕。显式配置 `GALAXY_INCIDENT_FILE`，API和Worker重启后生效。7项相关测试/lint通过，未运行真实多实例切换或外部通知。详见 `docs/incident-response-v1.md`。

2026-09-10事故通知：事故私有站内通知接通运营显式投递、本人分页/已读/偏好、原生收件箱及导出/删除清单；真实API/Worker暂停恢复已验证。当前Schema29/38表，迁移后重应用api-role.sql；新客户端包含incident通知ID和偏好以及新增本人导出集。23项相关测试、隔离PG2项、lint/严格tsc及离线安装通过。详见 `docs/incident-notifications-v1.md`。

2026-09-10履历重建：履历新增版本化重建记录、可见来源引用和稳定内容摘要；客户端同会话对照及原生展示已接通，父Case共享锁防止版本混合。旧projectionHash与API响应版本兼容；新客户端已完成离线安装。7项相关测试、真实PG1项、严格tsc和lint通过。见 `docs/history-rebuild-v1.md`。

2026-09-10Profile自述：API/便携客户端及导出/删除已接通；Schema30/39表/30本人导出集/19客户端入口。原生编辑签名与展示仍待完成。见 `docs/profile-statements-v1.md`；动态服务未部署。

2026-09-10Profile宿主：Profile原生编辑、准确预览、本机签名及自述/事实分区展示已接通；默认私有，版本冲突不覆盖，取消与旧页面回调不继续发布。11项相关用例、严格tsc、lint及客户端离线安装通过。C10-03待复核；未全局安装或外部部署。见 `docs/profile-statements-v1.md`。

2026-09-10履历视图与结果：履历新增三类独立字段规则、五类结果时间线及成功报告后的后续结果；读取重算状态/时间与空资料展示接通，Evidence源/Proof/授权/绑定撤销联动已验证，重建规则升级v3。13项不同相关用例、真实PG1项、严格tsc、lint及客户端离线安装通过。见 `docs/history-views-and-outcomes-v1.md`；C10-06直接操作入口仍待补齐，动态服务未部署。

## 外置历史参考

这些引用的正文保存在维护工作区，不在当前 Git 仓库内。当前可读入口：[文档目录](../../docs/README.md)、[架构](../../docs/architecture.md)、[项目状态](../../docs/project-status.md)。旧运行记录不作为当前环境或功能验收依据。

<!-- Workspace reference retained: 银河产品方案 | ../../../../../02-architecture/redesign-v1/README.md -->
<!-- Workspace reference retained: 迁移前原样快照 | ../../../../../01-intake/traceability/snapshots/91/91d5e1346b3bf6e0830a0efa625998c16ddd226c0590b8a82f9821922bd190a8.md -->
