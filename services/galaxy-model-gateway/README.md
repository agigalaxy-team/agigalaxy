# Galaxy operations model gateway

This service embeds the native **LiteLLM Proxy**, fixed at commit
`230f653523fa55aa446e1a5b6469f0871cf7278d` (source reports `1.108.0`).
The source version is not substituted with a differently versioned PyPI
release. The image builds the fixed source with its unchanged `uv.lock`,
including the native Rust extension and proxy extras. The commercial
`litellm-enterprise` workspace package is explicitly excluded from installation;
its optional routes, UI, license checks and enterprise features are not used.
The native root and proxy-extras MIT licenses remain in `/app/licenses`.

## Source-only build preparation

From a checkout, prepare a new context with `python services/galaxy-model-gateway/prepare-source-context.py --output <new-context> --archive <fixed-commit.tar.gz>`; `--download` instead reads only the exact public commit in `SOURCE.json`. The preparer includes original upstream licenses/lock and Galaxy Python source/tests plus the empty model example, excluding protected runtime configuration. Build with `docker build -f <new-context>/services/galaxy-model-gateway/Dockerfile <new-context>`. Preparation does not install, start, call a provider or deploy. Docker execution and native protocol tests remain separate results.

The supplied `config/models.empty.yaml` contains only `model_list: []`.
In that shipped empty example no provider, credential, model or fallback is configured. Human-managed deployed bindings are separate: the current server has previously completed real model calls; read its protected runtime metadata for current state. Remote logging callbacks, a native Proxy billing database, Redis, virtual-key and budget products are not enabled by this example.
Model requests fail with `model_gateway_model_not_configured` before reading
the prompt. An empty service key prevents startup; the native Proxy's
development no-auth behavior is not exposed.

## Runtime contract

The listener is loopback-only, default `127.0.0.1:3351`. A new protected service
key of at least 32 characters is mandatory. It is independent of the AgentOS
authority/signing keys and of any provider key. Every route requires exactly
one `Authorization: Bearer <service key>` header. Do not expose these routes
through the public Caddy/API/BFF surface.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/galaxy/status` | Engine/source/configuration metadata; no secrets |
| GET | `/galaxy/usage?days=7` or `days=30` | Durable call/token metadata and actual coverage |
| GET | `/v1/models` | Native OpenAI-compatible catalog from human configuration; empty when using the supplied empty example |
| POST | `/v1/chat/completions` | Native Proxy protocol, after closed admission |
| POST | `/v1/responses` | Native Responses protocol for an explicitly assigned Responses model |

Other query parameters and routes, provider override headers, model/key/config
management endpoints and client-supplied logging metadata are rejected.
Configured calls additionally require `X-Galaxy-Model-Scenario` (one of the five
domains) and `X-Galaxy-Model-Config-Version` matching the loaded version. Only
registered `galaxy-*` aliases are admitted; SDK provider/model pass-through and
fallback fields cannot be supplied in request bodies. Transport size is limited
to 2 MiB as an engineering safety bound, not a model budget.

The native Proxy performs routing and the OpenAI-compatible response protocol.
The small ASGI wrapper performs private service authentication, route and body
admission, and closed error projection. It does not implement a replacement
inference engine. The native `custom_auth` hook is used as a second admission
check and does not represent a Galaxy business role.

## Human model settings

Only an operator-mounted file can supply native `model_list` entries. Entries
contain `model_name`, `litellm_params` (`model`, `api_base`, `api_key`) and the
closed native `model_info` limits/mode/endpoints. A model route explicitly names its provider
prefix and HTTPS base URL (or a loopback development address). Credentials can
only be references of the form
`os.environ/GALAXY_MODEL_PROVIDER_<NAME>_KEY`; literal keys are rejected, and a
missing new referenced value prevents startup. No
provider setting is supplied here. Provider/key changes require separate human
configuration; an AI cannot write this file or select a provider.

AgentOS uses native `agno.models.openai.like.OpenAILike` for Chat, Anthropic and
Gemini routes through the Proxy, and native `OpenAIResponses` for Responses. This
avoids the Agno LiteLLM package entry importing a separate SDK implementation.
Its protected
binding file maps overview, governance, messaging, discovery and maintenance to
an alias, approved data policy and an explicit human-selected runtime profile. The
shipped `model-bindings.empty.json` has five null values. Empty or unapproved
scenes create no model. Legacy direct provider environment settings are rejected
when nonempty. Ambient `OPENAI_API_KEY` and `LITELLM_API_KEY` do not enable a scene.

Before and after each native model invocation, AgentOS rechecks the execution
identity with the current Galaxy authority, checks the scene, and reads the
native catalog to verify the alias and matching configuration version. This
does not grant a business-tool action: P10 object and current-action authority
remain independently enforced by the existing gateway. A version mismatch or
unavailable catalog fails closed; there is no fallback model or implicit retry.

`GET /galaxy/model-settings` on the private AgentOS service returns safe binding
metadata under its existing service authentication. Its `gatewayAvailability`
is `not-checked`; a configured URL does not prove availability or provider
connectivity. The Galaxy model-settings UI/API uses independent human-only
read/configure/apply permissions, version/CAS and closed audit metadata. The
root private control agent keeps provider keys outside PG, compiles protected
configuration, restarts the fixed service pair and requires matching version
readbacks from both engines. Unknown results query the original operation;
keys are immutable version references so rotation does not overwrite an
already applied version. No AI tool grant or ordinary rules permission can
change a model connection.

The protected `galaxy_profiles` map selects the four API formats, context
window, output limit, reasoning effort, timeout and tool/structured-output
capabilities. Native LiteLLM converts Anthropic/Gemini parameters. Explicit
compatible-API reasoning is passed through, not silently dropped. The gateway
estimates input tokens locally using native conversion/counting, reserves the
configured output allowance, and rejects unavailable counts or oversized
contexts. This is an estimate, not an exact supplier tokenizer receipt; no
automatic truncation, sampling parameter, fallback model or model retry is
enabled. Supplier retention is a separate provider policy, not inferred from
an OpenAI `store=false` field on another protocol.

Protocol paths are derived in code. A bare site root becomes `/v1` for
OpenAI-compatible formats and `/v1beta` for Gemini. Explicit custom prefixes
remain intact; a supplied complete inference endpoint is reduced to its
protocol base so the SDK does not append it twice. Derivation changes neither
the saved operator input nor its host, model, credential or scenario binding.
The gateway also derives paths for existing applied versions at startup.
No discovery call, paid health inference or alternative protocol retry is
performed automatically.

Successful HTTP status alone does not prove a usable answer. The response
guard rejects HTML, malformed JSON, empty completions and incomplete SSE
streams, accepts actual tool calls and refusals, and emits a closed stream
error when output fails after headers. Response validation can correct the
current call's terminal ledger state to failed while retaining any real token
receipt. It never rewrites historical calls or retries an unknown result.

## Logs and unknowns

Native remote telemetry is disabled before import with
`LITELLM_TELEMETRY_DISABLED=true`; local cost-map mode avoids fetching remote
pricing metadata. Python library stdout/stderr and logging are suppressed at this service entry
point. The sole custom callback emits a closed call record: generated call ID,
scene, alias, configuration version, outcome, duration and actual token counts.
Unknown usage is null. A small SQLite ledger persists these same closed fields;
duplicate native callbacks update one original call and never double-count it.
Its response reports the actual collection start and whether the requested
window is complete. Prompts, responses, provider errors, credentials, URLs,
cost/budget data and arbitrary metadata are not included. This is basic process
metadata, not a new billing ledger or an exactly-once call guarantee. Streaming
exceptions after headers terminate the stream without serializing exceptions.

Model execution, supplier compatibility, real supplier token accounting and
vendor network behavior are not verified by the empty-model build. New profile
checks exercise the actual native Proxy and four wire protocols against an
explicit loopback HTTP provider double; they do not invoke a real model.

## AI-agent deployment

1. Read the fixed `SOURCE.json`, Dockerfile, unchanged upstream lock and new
   `deploy/model-gateway` templates. Do not discover or reuse existing provider
   credentials. The dedicated build tool modifies only its named build folder
   and new image tags; it does not activate a service or run migrations.
2. A deployment operator generates a new service key in a protected process or
   file outside this repository. Keep it out of shell output, source, logs and
   Docker build arguments. The AgentOS gateway key must match this new key.
3. Mount a read-only empty `models.yaml`; retain five null AgentOS bindings and
   matching `unconfigured-v1`. Merge new AgentOS settings with its current
   protected runtime environment without replacing its database/authority keys.
4. Activate within the project's current deployment authorization. The
   compose template uses host networking but the application refuses a public
   bind. It has no business database access and does not add a cache or queue.
   The model-settings compose mounts only protected config and its metadata
   ledger; provider env files use raw format to avoid interpolation of key characters.
5. Check authenticated status and the native empty catalog. An unauthenticated
   request must be 401; a completion request must be 503 before reading a prompt.
   Do not run a real model as a health check. Use closed status/error codes if
   startup fails; do not enable verbose native logging on protected settings.
6. For later human configuration, assign one explicit alias route and matching
   version at both services, then restart through the operator-controlled path.
   The private root control agent supplies that versioned writer. Leave model
   entries empty until a human configures them; provider calls are never a
   deployment health check.

Common pitfalls are a missing new service key (startup fails), stale binding
version (invocation denied), using a provider model instead of a configured
alias (denied), inheriting old direct Agno model variables (startup denied), and
interpreting an empty catalog as an engine outage. Empty is the intended state.
