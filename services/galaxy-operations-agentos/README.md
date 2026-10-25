# Galaxy operations AgentOS

This service uses the fixed **Agno 3.1.7** (Apache-2.0) AgentOS, its native session/run persistence, durable queue, HumanReview pause/continue, and native OpenTelemetry database export. Galaxy does not implement another workflow engine or a second business permission authority. The installed dependency contract is [requirements.lock](requirements.lock) and [pyproject.toml](pyproject.toml); the image entry is `python -m galaxy_agentos.app`.

The source defaults to **no configured model**. A model becomes callable only through an explicit human-managed scene binding to the private native LiteLLM Proxy, with the required data-policy and runtime profile. Agno never selects a provider, changes a key, borrows an ambient personal key or falls back to its default OpenAI model. A default is not a statement about the current server: deployed model state is read from the protected metadata API, not inferred from this README or the shipped empty binding example.

## Source and runtime entry points

| Source | Responsibility |
| --- | --- |
| [app.py](src/galaxy_agentos/app.py), [runtime.py](src/galaxy_agentos/runtime.py) | Native AgentOS composition, private route admission and native lifecycle |
| [conversations.py](src/galaxy_agentos/conversations.py), [conversation_tools.py](src/galaxy_agentos/conversation_tools.py) | Domain conversation Agents and current typed tools |
| [gateway.py](src/galaxy_agentos/gateway.py) | Private calls back to current Node authority; closed tool error feedback |
| [conversation_storage.py](src/galaxy_agentos/conversation_storage.py) | Native conversation run/event write projection, including durable-worker saves |
| [read_model.py](src/galaxy_agentos/read_model.py), [tracing.py](src/galaxy_agentos/tracing.py) | Safe native run/event/trace metadata reads and metadata-only trace export |
| [model_settings.py](src/galaxy_agentos/model_settings.py) | Human scene/profile bindings and native Gateway model admission |
| `p13_strategy_surface.py`, `p13_continuation.py`, `p13_strategies.py`, `p13_strategy_tools.py` | Existing strategy Workflow, actual native pause/continue receipts and current controlled strategy tools |

Node business schema, authority, conversations, source references, cards and real effects remain under `packages/galaxy-official/src/`. The relevant current contracts are linked below. [AGENTOS_INTEGRATION.md](AGENTOS_INTEGRATION.md) maps the current conversation, execution, action-card and private gateway contracts, and links the preserved initial migration-105 record. Apply the complete selected release migration/role set rather than that initial SQL alone.

## Native identity and current authority

There are three separate server-bound native identity paths:

- **`conversation:<UUID>`** is an ordinary workbench conversation for a current verified management person, domain and session. It does not require creating an automation grant just to talk, and it does not create one. Each tool must still obtain the person's current Node business permissions and the tool's current source/purpose checks.
- **`execution:<UUID>`** is an explicitly authorized work item bound to a real PG grant, domain, selected objects, revision and prepared intent. Assisted execution intersects current personnel permissions, assistant permission and task scope. Automatic execution has a separate recorded source. Neither path impersonates a reader or administrator, and a missing object scope never means all objects.
- **`autonomy:<UUID>`** is a persistent background task bound by Node to a stable AI work account, enabled plan, purpose and versions. It carries no management-browser session. `pg-boss` is the only business scheduler; the existing native run queue accepts that original task once, without a second AgentOS scheduler or automatic model replay.

Python credentials authenticate this runtime, not a Galaxy business role. The Node authority derives current principals, permissions and source qualifications from committed server state; client roles, capability snapshots, prompt text and model-generated IDs cannot grant permission. Original human decisions, other grants, real P13 review waits, exact CAS and original operation receipts retain their existing boundaries.

## Workbench conversation tools

Current tools are implemented through native Agno typed functions. Models receive the functions' closed schemas; every call goes through the private Node gateway and the real domain service. The current argument definitions are [conversation_tools.py](src/galaxy_agentos/conversation_tools.py), [Node query schema](../../packages/galaxy-official/src/shared/operations-agentos-query-schema.mjs) and [Node action catalog](../../packages/galaxy-official/src/operations-agentos-action-catalog.mjs). Their actual definitions are the contract; do not copy a fixed count or manufacture a parallel tool registry in documentation.

| Native function / Node tool | Current purpose |
| --- | --- |
| `current_summary` / `workbench-summary` | Read the current permission-limited workbench summary |
| `query_operations` / `query-operations` | Query a closed business module/view and its allowed filters, pagination, qualified structured data and server-produced source references |
| `read_operation_object` / `read-operation-object` | Read an exact allowed object through its current domain reader |
| `list_authorized_work` / `list-authorized-work` | List the current person's actual authorized work and its current execution qualification |
| `run_authorized_work` / `run-authorized-work` | Continue an existing bound work item using its original prepared command and current authority; it cannot bypass an existing human/P13 wait |
| `prepare_operation` / `prepare-operation` | Ask Node to prepare a typed business intention and freeze the real object/CAS for a safe workbench card; this preparation is not a new grant or a committed effect |

Programs compute deterministic counts, pagination, current qualifications and related objects. The model explains or compares those returned facts. Query tools are not arbitrary SQL/HTTP, and prepared actions do not accept model-selected operation IDs, actors or arbitrary command payloads. A mode name alone does not add a second human confirmation: the current bound intent and actual human boundary determine whether a prepared task can execute or must return a specific review card.

For conversations, Node receives `{conversationId,sessionId,turnId,runId,callId,tool,arguments}`. Native `RunContext` provides the trusted session and run, while the original operation metadata provides the turn. These are not model parameters. Node binds the original turn to the accepted native run, rechecks the current session before and after reads, and uses the original business receipt for unknown outcomes. The Node operation ID and native queue run ID are different identifiers.

The general query surface exposes only explicit safe projections. It can return currently qualified public post/reply text where the connected reader permits it. Private chat/case materials, feedback or email prose, SMTP contents, credentials and provider errors are not admitted to general model conversation by a module name or by `workbench.read`. Public titles/versions still carry current controlled-source references. Such operations do not create interest/profile/recommendation signals.

The separate selected-content execution tools remain available only under their actual execution/task scope. Selected search returns bounded current selected references; its model arguments cannot replace the server's selected IDs or expand an empty task to the whole site. It does not record a usage/profile event. Real execution effects still call the original business gateway, not the conversation's text response.

Expected argument/not-found/conflict responses are converted into closed correction feedback so the conversation can read current state or ask for a precise missing choice. Authentication, current-authority denial and service failure remain failures; raw provider, SMTP, SQL or internal exception prose is not returned as a tool result.

## Persistence, source expiry and trace

The conversation Agent uses native multi-turn session history. **`store_tool_messages=False` only removes tool message pairs; it does not by itself scrub `RunOutput.tools` or stored event payloads.** Likewise `store_events=True` is not permission to persist arbitrary business content.

The existing native DB adapter therefore projects both ordinary saves and attempt-fenced durable-worker writes. Tool arguments/results, event bodies and `additional_input` are removed; only closed tool identifiers/errors/times/metrics and approved event metadata remain. Atomic error paths apply the same projection. It keeps the real native DB/transactions/queue and adds no separate history database.

User messages and final assistant replies remain native conversation history. Node binds their controlled source references and rotates/withholds the current conversation session before later reads/runs when a reference loses permission or expires. Historical assistant text is not authority to reread a source or re-execute an action. This is not a claim that old stored rows were physically erased or that a new retention period was selected. Private proposal/command JSON and business result-card payloads remain in the corresponding Node-controlled ledger, not unbounded native tool history.

Trace export strips prompt/completion/tool bodies and exception prose, keeping recorded relationships, status, times and token metrics. Global metadata reads require their actual audit permission; they do not confer message/material-body access. Unrecorded input/output, retries or prompt-version fields remain unknown. Internal chain of thought is not exposed, and library metric defaults do not manufacture known token totals.

## Configuration and deployment discovery

Build only a selected frozen source set with the [Dockerfile](Dockerfile) and locked requirements. A new image/tag is a candidate until the designated deployment process activates and reads it back. Do not overlay the full current working tree onto an older running release. This service shares neither a business-database identity nor a browser session with Node.

The native service uses a dedicated PostgreSQL database/identity and schema. Agno's durable queue uses PostgreSQL; SQLite-backed local contract fixtures do not establish durable production queue coverage. Node applies the **complete schema/SQL-role set declared by the selected API release**, including its registered conversation/tool/strategy migrations. Applying only the initial migration 105 or copying its original grant example is insufficient for later features. Python must not gain access to Node business tables to compensate for a missing bridge.

Node loads `GALAXY_AGENTOS_CONFIG_FILE` through [operations-agentos-configuration.mjs](../../packages/galaxy-official/src/infrastructure/operations-agentos-configuration.mjs). The protected file's strict shape is `{version:1,endpoint,url,signingKey,serviceKey}`; `endpoint` must match the chosen business endpoint. `url` is an origin, HTTPS or allowed loopback HTTP, without caller-selected path/query/credentials. The loader returns `{url,signingKey,serviceKey}`. **`allowInternalHttp` is not an accepted field in this Node JSON.** Python's separate authority-network setting must not be copied into that strict file.

Python reads [config.py](src/galaxy_agentos/config.py): `GALAXY_AGENTOS_DATABASE_URL`, authority URL, service/verification keys, the model Gateway origin/key and protected bindings reference. The Node signing key matches Python's verification key, and the private service key must match its counterpart. No resolved DSN, key, Cookie or protected file content belongs in source, logs, metadata, a browser response or this document. Configuration paths and origins come from the current protected deployment metadata, not an archived example or a personal home directory.

The authority URL addresses the exact private Node AgentOS prefix. Private Node routes verify the service credential before parsing/delegating to closed handlers; public Caddy and the admin BFF must reject this private prefix. Native listeners remain on the selected loopback/private runtime network. Protected `/galaxy/` metadata uses the outer service-key admission; native business/run routes retain their own actual AgentOS/current authority checks. Adding a private metadata route must not accidentally send a service key through the native JWT parser or exempt a business route.

Model calls go through the [private native LiteLLM Gateway](../galaxy-model-gateway/README.md). Human bindings select the configured alias, data policy, context/output limits, reasoning, timeout and supported tools/structured output. Chat/Anthropic/Gemini use the selected native `OpenAILike` route, Responses uses `OpenAIResponses`; provider conversion stays in native LiteLLM. No temperature, automatic provider fallback or implicit model retry is added. Nonempty legacy direct-provider AgentOS variables are rejected. The model catalog and configuration version are checked against the selected scene before use.

## Background duty execution

`duties.py` registers native **AgentFactory `galaxy-duty`**. The factory is resolved at acceptance and again at durable claim, taking only trusted task identity. It fetches the frozen task/prompt version from Node, loads the current human model file and builds the native Agent with the existing database and typed query/action schemas. Plan context, versioned role instructions and the fixed code boundary remain separate. Later tasks see changed human model/prompt settings without a Python restart. Each active execution leg remains bound to its selected human model version; an explicitly continued human pause loads the current human setting and retains the prior and current version references in that same run. Domain labels describe context; the current role and server task decide authority.

The private task routes require both the existing Node service credential in `X-Galaxy-Service-Key` and a signed `autonomy:<taskId>` JWT with matching task/plan/account/delegation claims:

- `POST /galaxy/autonomy/tasks/:taskId/runs`, `Idempotency-Key: taskId`, JSON `{}`. It accepts no prompt, model, tool list or arbitrary message; the native queue deduplicates the original task.
- `GET /galaxy/autonomy/tasks/:taskId` reads only the original owned run. A missing run is `NOT_RECORDED`; network uncertainty is never a reason to create another model run.
- `POST /galaxy/autonomy/tasks/:taskId/cancel`, same empty body and key. Node first fences the task; the native cancellation path can then stop the old run without obtaining new write/run authority.
- `POST /galaxy/autonomy/tasks/:taskId/continue`, same empty body and key. Only a real native `PAUSED` run with matching pending tools and Node-confirmed original-operation receipts or human decisions may resume. The existing native ticket is atomically continued under the same run ID. Cancelled, completed, failed or unknown work is never replayed through this door.

Native callbacks use the existing private authority prefix plus `autonomy/authorize`, `autonomy/tools/execute` and `autonomy/report`. The authority and every tool resolve current task/lease, AI role, scope, purpose and versions. Reads use the effective AI role and enabled plan; autonomous writes additionally pass the existing exact business service, current strategy/grant and human conditions. `execute-operation` never accepts an actor or operation number from the model. The AI-only role tool calls the bounded delegation service; it cannot edit a shared role or give a person permissions.

Reports contain model states and the native run reference only. Business completion comes from Node domain receipts. A human wait or takeover remains in the original task; original decisions are not replaced by a model completion. Native duty storage keeps run/events/tool identifiers and real usage metadata, stripping prompt, model-result, tool-body and timeout-error text through both ordinary and attempt-fenced writes. It is not a new private-chat/evidence archive; approved task materials and human decisions stay with their Node purpose and retention policy.

Invocation counts are recorded at the native provider entry after current authority succeeds, including follow-up requests after tools. Each durable invocation records its count under the original native attempt fence before entering the provider; stale/terminal attempts cannot call the model. Agno `metrics.details` groups by provider/model and is not an invocation count. Tokens remain the SDK's actual reported cumulative usage, and older runs without an invocation counter retain an unknown count. Native human-pause continuation adds active execution durations while excluding the waiting interval.

A writer's `waiting-human` result stops the native model loop at Agno's post-tool barrier using an external-execution requirement. Continuation injects only the recorded outcome of that original operation, never a confirmation flag that reruns the writer. Claim-time validation repeats current task/role/plan checks. The native Agent reconstructs its minimal purpose-bound context from the same task and current trusted instructions, while prior tool/evidence bodies remain outside native history.

The existing human workbench accepts an optional `taskId` on a normal conversation turn. Node binds the current owner, fixed AI account, original task/version and scope before exposing `current_summary.boundedTask`. A prepared action still uses the existing human/AI permission intersection and one concrete confirmation card. Its original receipt returns to that task, and each distinct turn/run contributes its actual usage snapshot once. Binding a task never creates a duty identity or a long-running plan. A human takeover of a cancelled native task is handled through this human card path; it does not turn the cancelled model run back into active work.

The shared native queue keeps concurrency **2**, `max_attempts=1`, and the SDK's outer **3600-second** ceiling. Each duty Agent wraps its existing native execution with the task's frozen `roundSeconds` (30..3600, default **600**); the current Node runtime settings affect new tasks without a restart. `GALAXY_AGENTOS_WORK_TIMEOUT_SECONDS` supplies the default only when an older task has no explicit limit. The wrapper stamps Agno's native cancellation cause before cancelling, leaving terminal persistence and attempt fencing with the native worker. Node also checks the task deadline before every deterministic/code action. There is no silent replay after a crash or timeout. Node owns per-post overlap, periodic/event coalescing and original-operation reconciliation. `/health` exposes the duty contract and hot human-model metadata, not a claim that a plan has been enabled or has performed an effective check.

[deploy/duty_probe.py](deploy/duty_probe.py) is a finite central acceptance helper. It reads the protected Node config in-process, outputs closed task/run state only and defaults to original-task reads. `--dispatch-once` is the explicit real-model action for an already enabled authorized task; `--continue-once` consumes a previously resolved human pause. After an uncertain POST it only queries that same task. This helper does not create/enable plans, decide a human request, change permissions or configure a model. Do not run a dispatch merely to test connectivity.

## AI-agent verification and common failures

Discover the current release, protected configuration references, DB role and selected native entry before changing anything. Check runtime/model metadata and current origin/session/CSRF/private-service boundaries for the affected change, without logging secrets. A running health endpoint is compatible with `model:not-configured`; this does not establish provider connectivity or authorize a model call. Empty run lists can be a real result.

The service tests explicitly distinguish native engine/PG/durable-queue checks, typed conversation ASGI/contracts, metadata admission, and controlled model/provider doubles. Run only the necessary affected checks for the new change, preserving initial failures and their actual retry scope. Do not repeat historical passed groups or contact a real model, mail service or private business source simply as a connectivity test. Real provider calls and production effects require their specific user authorization and are recorded separately from source/build checks.

Common failures have distinct causes: missing service authentication must fail closed; model absence must remain `agentos_model_not_configured`; a native background/continue needs the active AgentOS lifespan and correct durable DB; the conversation write adapter must survive the durable queue path; a changed source/session must withhold stale history; a permission denial cannot be changed into a fictional business result. Unknown dispatches query the original run/turn/operation receipt instead of creating another model run or resending an effect.
