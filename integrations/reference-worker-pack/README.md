# Reference arithmetic Worker Pack

This user-host reference implements an actual separate Node process with the
repository's locked `@a2a-js/sdk` 1.1.0 and A2A 1.0 JSONRPC interface. It accepts
only explicitly selected bounded arithmetic input. It has no model, shell tool,
cloud scheduler, automatic installation, or claim of independent third-party
value. The reference is an optional consumer of existing Builder, Configuration,
Case, A2A journal and PackUse contracts.

The adopted M20 boundary remains a declaration and use interface. Publishing,
reading or exporting a manifest never starts execution, creates an Attempt, or
activates a host. A recorded PackUse remains the participant's reported use;
`successfulReuseVerified` stays false without the separately required evidence.

## Run the reviewed process

Use an already installed Node executable (24.13 or later). Install the locked
third-party SDK with `npm ci --prefix integrations/reference-worker-pack`.
This reference owns its dependency; it does not load a retired Node Galaxy client.
The example logical endpoint identifies
the selected interface; the process listens only on a randomly assigned
`127.0.0.1` port. It is not a public TLS listener or an authentication service.

```powershell
& 'C:/Program Files/nodejs/node.exe' '<repository>/integrations/reference-worker-pack/worker.mjs' 'https://reference-worker.example.org/a2a'
```

The first stdout line contains the loopback port and AgentCard. Select the exact
card/interface and pin its hash in the existing A2A host, together with an
owner-selected trusted transport that maps that logical endpoint to this local
process. The transport must preserve the A2A version header and must never send
the Official service's credential to the peer. The synthetic example hostname
is not a published download or a production service.

The commands are JSON text with `operation: "sum" | "quotient"`, finite numeric
`values` (1–64 entries; quotient requires two) and optional `delayMs` (0–5000).
No other fields, executable paths or arbitrary code are accepted. A non-finite
result becomes a real failed Task. A delayed computation can be read with
`GetTask` and stopped with `CancelTask`; only the observed canceled Task supports
a cancellation report. Abandoning a preview or losing a transport response does
not mean the peer canceled or did not execute.

Stop the process with Ctrl-C or its owner's fixed process shutdown mechanism.
The optional IPC protocol accepts only `observations` (counts and versions) and
`shutdown`. Shutdown clears active timers, closes the loopback listener and exits.
Execution does not spawn additional processes or use the network for arithmetic.

## Galaxy integration

`createReferenceWorkerManifest({source, sourceHash, licenseSource})` creates the
existing strict manifest. Supply the actual reviewed source digest, source and
license reference; no download, signature, installation or execution happens in
this function. Register it with the existing signed Builder client. A source
hash or declaration is not a professional certification or a capability score.

The Go Native implementation owns Galaxy A2A and Worker associations,
authorization, journals and original operation receipts. Agents use its existing
`galaxy_worker_host_read`, `galaxy_worker_host_prepare`,
`galaxy_worker_host_execute` and `galaxy_worker_host_abort_local` tools as needed.
The trusted `workerPacks` configuration selects a peer and the actual
Builder/manifest/source references; it does not accept executable commands from
model input. A local abort does not cancel a peer task. Results and PackUse
records retain their own operation receipts and are not inferred from a protocol
task's completion. There is no parallel Node Galaxy host-flow implementation.

## AI-agent local operation

Discover the existing repository, actual Node path, this reference's locked SDK and exact
source files before launching. Do not install a global runner or accept an
executable/cwd/endpoint from untrusted Pack metadata. Keep the listener loopback;
real external transport, TLS and peer credentials require the owner's explicit
deployment and selection. The local reference's authenticated SDK context means
only local-owner transport, not public identity verification.

Development methods are in [贡献与开发说明](../../CONTRIBUTING.md); tool commands are in [Development checks](../../docs/technical/development.md).

The workflow uses actual independent child processes, the locked SDK, signed
HTTP business requests, PGlite and a filesystem A2A journal. It verifies normal
output, failure, delayed cancellation, separately published Result/PackUse,
lost ACK receipt recovery, no implicit re-execution and lease changes. Identity,
selected inputs and public source URLs are synthetic; the host local store is a
Map substitute. It does not demonstrate a third-party operator, physical IDB,
production TLS/authentication, a model or third-party package value. Test startup
errors must close the child process; a dependency/version error is not permission
to fetch an unreviewed executable or bypass the source/card pins.

The protocol reference is the official [A2A 1.0 specification](https://a2a-protocol.org/v1.0.0/specification/),
especially SendMessage, GetTask, CancelTask and terminal Task-state semantics.
