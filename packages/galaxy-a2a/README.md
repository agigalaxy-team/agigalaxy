2026-09-11 历史工件范围见[工件接收与存储](../../docs/artifact-retention-v1.md)。该日期的部署描述只代表当时证据，不代表项目当前整体运行状态。

2026-09-13 当前新增：官方 Python SDK 1.1.2 与 JS SDK 1.1.0 的真实 A2A 1.0 HTTP 互通；原生 v2 Case/Attempt/Participation/Intervention/Result 接续和可选原生 MCP 工具。使用方式、版本证据、与旧路径的区别和未发布范围见 [v2 接续与 Python 对端](docs/native-v2-python.md)。下列原有 Host composition 和 Native host composition 仍描述保留的 v1 Case 入口；新的业务调用应显式选择 v2 入口，不能将两种事件混用。

# Galaxy A2A adapter — local integration slice

2026-09-10: repository-local adapter using the official `@a2a-js/sdk` **1.1.0**,
locked with its dependencies. Wire profile: **A2A 1.0, JSONRPC**. This is a host
library and an actual HTTP SDK-to-SDK interoperability fixture; no public A2A
service, OAuth integration, or independent certification is being advertised.
Optional local host composition and a native menu are implemented below.
The package imports shared code from this repository and is
not a standalone published SDK.

The selected versions are recorded in the [official SDK release](https://github.com/a2aproject/a2a-js/releases/tag/v1.1.0)
and [A2A 1.0 specification](https://a2a-protocol.org/v1.0.0/specification/).
ProtoJSON serialization, client transport and server task handling come from the
official SDK. Galaxy implements its own Case association and disclosure flow.

## Install and verification

Use Node >=24.13.0 (tested here on 24.19.0). From the repository root:

```sh
npm ci
npm --prefix packages/galaxy-official ci
npm --prefix packages/galaxy-a2a ci
npm run test:a2a
```

`npm test`/`npm run check` include A2A. The fixture creates a temporary local
journal, synthetic identities and PGlite Cases, and an official SDK HTTP server
on `127.0.0.1` with an ephemeral port. It uses no external service or user key.
The TLS layer is additionally tested by the existing `test:tls` suite.

## Host composition

Import `createA2aBridge` from `src/bridge.mjs`. Supply:

- `endpoint`, `tenant`, `agentCard`: an explicitly selected HTTPS JSONRPC 1.0
  interface and its already reviewed **wire JSON** card. No discovery/refresh or
  alternate endpoint selection occurs in the adapter.
- `subjectId`, `officialEndpoint`, `peerPrincipal`, `directory`: the current
  Galaxy subject, owning Official, external account/principal identifier, and an
  explicit absolute private journal directory. These jointly isolate records.
- `authorize(scope)`: trusted host callback resolving the current local subject,
  matching external principal and optional external bearer credential. Return
  `{subjectId, peerPrincipal, credential?}`. Resolve credentials only for the
  selected endpoint; never pass a Galaxy Official session token to this peer.
- `cases.get(id, {signal})`: the existing authenticated owner-scoped Case reader.
  Each outgoing operation rechecks that its Case and Attempt are still readable
  and the Case has not been withdrawn.

`prepareStart({caseId, attemptId, text})`, `prepareReply(associationId, text)` and
`prepareCancel(associationId)` produce an exact preview. A trusted host displays
the destination/action and selected text, then passes the matching confirmation
to `execute(preview, preview.confirmation)` only after approval. Do not auto-fill
the confirmation in a real host. `poll(id)` is an explicit read; `get(id)` and
`list()` inspect only the local journal. Local reads must remain within the
host's current-user UI boundary.

The outbound A2A Message contains selected text and protocol IDs only. Case IDs,
Attempt IDs, Galaxy IDs, complete chat/Case text and arbitrary metadata are not
automatically uploaded. Replies to `input-required`/`auth-required` require a new
preview. `auth-required` does not launch OAuth or read credentials itself.

`prepareResult(id)` returns a **draft** for the existing Case flow. That flow must
obtain a separate exact-payload `case.teaser.publish` Consent and submit the event
using its current version check. No Case mutation occurs merely by reading the
A2A result. The source report remains unverified.

## Native host composition

The secret-free `a2aHostFactory` from `src/host-flow.mjs` is supplied explicitly to
the existing Official `createLocalHostRuntime`. It keeps A2A dependencies out of
the standalone Official client and leaves the original default initialization
unchanged. The factory accepts 1–32 peer configurations and a separate credential
resolver. A peer has `{id, name, endpoint, tenant, peerPrincipal, agentCard}`;
`agentCard` is the reviewed wire JSON. The resolver receives only peer selection
metadata and the current Galaxy subject ID, never the Official session credential.

```js
const runtime = createLocalHostRuntime({
  ...trustedOfficialConfig,
  a2aHostFactory: a2aHostFactory({
    peers: approvedPeerConfigurations,
    readPeerAuthorization: async (peer, subjectId) =>
      hostCredentialStore.resolveForExactPeer(peer, subjectId),
  }),
});
const adapter = createGalaxyAdapter(runtime.controller);
```

This is trusted composition code; the identifiers above are supplied by the host.
It is not an automatic configuration loader or a request to paste credentials
into a prompt. The resolver returns `{peerPrincipal, credential?}`. External
authentication stays independent from the Galaxy connection.

When composed this way, the existing independent connection page exposes item 9,
**A2A external tasks**, for a current `case-teaser` session. The native menu lists
configured peers, reads an owned Case, selects an actual Attempt, previews only
the entered text, and sends after exact confirmation. It provides local history,
explicit polling, input/auth follow-up, remote cancel, and Result import. Import
also requires `consent` and a separate Private/Public visibility choice. Its
exact payload is signed with the existing local key using the normal Consent
client. It does not generate or replace identity keys.

Controller methods are `readA2a(method, input)`, `prepareA2a(input)` and
`executeA2a(preview, confirmation)`. Read methods: `peers`, `list`, `get`, `poll`,
`reconcile`. Action kinds: `send`, `reply`, `cancel`, `result`. All use the existing
controller's single-operation exclusion and cancellation generation. Closing,
disconnecting or changing the local binding prevents continued host operations.

Result preparation persists one stable event and Consent intent in the scoped
journal. A canceled preview can be prepared again with the same content and
visibility. After a lost Case acknowledgement, use **Reconcile Result import**:
it reads and compares the exact existing event, then restores its local receipt.
This works after reconnect/restart and never resubmits as a new result. Importing
an acknowledged event is blocked. If the source changes, the saved Consent
expires, or the Case version moves before import, the frozen import needs
reconciliation/correction; the adapter does not silently rewrite its authorization.

## Mapping and recovery

| A2A result | Local association / Galaxy Result |
|---|---|
| Task / Context IDs | Stored separately from the original Case / Attempt IDs, scoped to subject + Official + peer + tenant + external principal |
| submitted / working | Active peer-reported state; explicit polling |
| input-required / auth-required | Distinct interrupted states; explicit follow-up |
| completed | Draft `succeeded`, with external-report limitation; no Proof |
| failed / rejected | Draft `failed`, original state and failure reason retained |
| canceled | Draft `inconclusive`, exact peer state retained |
| standalone Message | `message-only`; no inferred Task success or Result |
| Artifact | ID, name, SDK-normalized object hash and bounded part summary/hash; URL references hashed and **not fetched** |
| protocol error | Stable SDK reason (e.g. `TASK_NOT_FOUND`); retained ID association |
| timeout / transport abort / invalid response | `unknown`; never report remote cancellation or automatically repeat the send |

Dispatch is reserved atomically before network I/O using existing Galaxy local
write coordination. One association per Attempt in a scope prevents competing
prepared sends and restart replay. A known Task can be reconciled with `poll`;
an initial send whose acknowledgement was lost has no known Task ID and requires
external reconciliation. Result-import receipt recovery is implemented, but this
slice does not claim recovery of an unknown initial peer Task ID.
Do not delete the journal to work around it. `abort(preview)` stops local work;
only an observed peer `canceled` state confirms remote cancellation.

The journal retains operation order, request/response hashes, stable errors,
the latest peer snapshot, and one frozen Result import/Consent with its receipt.
It excludes raw credentials and full remote history. SHA-256
identifies received content or SDK-normalized JSON; it is not a signature or an
independent execution check. Limits: 1 MiB response, 64 artifacts/parts each,
1,000 associations, 128 operations per association, 8 MiB journal. Retention,
long-running polling, journal export and unknown peer Task ID recovery remain follow-up work.

## AI-agent deployment and limitations

Configuration belongs to the host. Production network requests reuse the
existing public HTTPS/DNS-pinning gate: fixed `A2A-Version: 1.0`, TLS verification,
bounded bodies, and no redirects or automatic retries. The optional `post`
injection is a trusted host/test transport; never populate it from an AgentCard.
An AgentCard is descriptive input, not proof of endpoint ownership or capability.

Streaming/SSE, push notifications, HTTP+JSON, gRPC, A2A 0.3 fallback, card signature
verification/discovery, extended-card authentication, OAuth issuance,
portable Conformance Evidence and production capacity/operations are not part of
this slice. Existing `/galaxy` initialization/main menu and database Schema 18
remain unchanged; the independent connection page has the optional A2A entry.
Stop invoking the adapter to roll it back and preserve its journal;
stopping the local adapter does not stop already running remote tasks.
Do not retry imports through an older adapter that ignores the frozen import record.
