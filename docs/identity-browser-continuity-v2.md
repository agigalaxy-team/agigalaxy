# Browser identity continuity v2

## Scope and requirements

This slice implements PREP-M01-S2 / PREP-FLOW-M01-01 and the M18 return-to-original-target baseline. CUR-18 chooses existing-device approval and recovery codes; CUR-21 says ordinary device addition does not consume recovery material. Genesis, GUID and historical signatures remain unchanged. Creating a new identity is never a fallback for an unsuccessful recovery. User Agent delegation is separate from a user device and must not receive `manage-identity` through this flow.

The current target is the existing browser package and its configured Official authority. These source files do not establish a deployed service, full host support, completed account verification or restoration of another device's private data.

## Runtime integration

Create `createIdentityDeviceHandoff` from `galaxy-core/src/domain/identity-device-handoff.mjs` with `{endpoint,send:api.send,store,getActive,activate,allowedScopes:browserScopes,now}`. The private local store is passed inside the runtime, not exposed to the React component. `getActive` returns the current public local identity. `activate` disconnects the previous API session and persists `{subjectId,genesisProof,deviceId,installationId}` only after a committed receipt and a fresh current-device check. A later explicit connection obtains the current device's chosen scopes.

- `createOffer(subjectId,{scopes?,confirmed:true})` creates a local nonextractable device key and a public request; it queries the registered identity but does not create a GUID or authorize a device.
- `previewOffer(text)` parses public request data. `approveOffer(text,{scopes?,confirmed:true})` checks the current controlling device, permits scope reduction, obtains the existing 180-second challenge and signs it. The user copies the public approval to their own new browser.
- `previewApproval(text)` checks the configured endpoint, locally owned original request, exact challenge, current controller signature and expiry. `acceptApproval(text,{confirmed:true})` adds new-device proof, durably stores the exact operation, and commits it.
- `pending()` restores the local operation view. `reconcile(operationId,{retry?,confirmed?})` checks the original receipt and only explicitly retries the original signed request. Successful history cannot reactivate a device that has since been revoked.
- `cancel(operationId,{confirmed:true})` distinguishes a local unsubmitted cancellation from a server receipt. A committed operation remains committed when cancellation arrives late.

`IdentityWorkspace` composes the two-device transfer and local visitor-draft adoption beside the existing creation/recovery controls. It does not duplicate those controls or silently connect, upload or publish. Both devices display the same public-key fingerprint for comparison. Its form submission and in-form auxiliary buttons have explicit types.

## Visitor drafts

Create `createVisitorDraftAdoption({store,prefix,getActive})` and expose it as `runtime.visitorDrafts`. `preview()` holds both the visitor draft and the current identity's existing draft. `adopt(preview,{confirmed:true})` uses `openDeviceKeyStore.copyConfirmedDraft` to compare both exact values and copy in one real IndexedDB transaction. A stale preview fails with `local_draft_changed`. The visitor original remains, and publication remains a separate user action. An existing identity draft is replaced only when the displayed choice explicitly says so.

## Consent acknowledgements

`api.prepareAuthorization(payload,options)` creates and signs a local record without a Consent network write. The caller must persist `{version,endpoint,intent,signedIntent,payloadJson}` before calling `submitAuthorization(record,{confirmed:true})`. The compatibility `authorizePayload` remains for callers that do not yet use this durable workflow.

`POST /v2/consents/receipt` accepts only `{consentId}` under current `consent` authentication. `ConsentService.receipt(actor,id)` returns `{consentId,state:'absent'}` for absent/other-owner IDs, or the original `{consentId,state:'recorded',intent,signatureHash,status}` for the owner. Status distinguishes active, revoked and expired. It exposes no signing secret or credential.

`reconcileAuthorization(record)` requires matching exact intent, payload hash and original signature hash. An existing active authorization can be reused after reconnecting the same identity. If the original authorization is absent and its binding or signing window can no longer be used, submission reports `consent_reauthorization_required`; it does not silently produce a new Consent. Any later explicit reauthorization must first establish that the business operation was not already accepted, retain the old intent as history, and preserve the business operation ID.

## Verification evidence and limits

- `test/identity-device-handoff.test.mjs`: one real HTTP/PGlite integration scenario passed. It uses actual Ed25519 signatures, independent explicitly synthetic local memory adapters, narrowed device scopes, unknown device ACK recovery, unchanged GUID/genesis/recovery generation, altered challenge rejection, late cancellation returning committed, Consent ACK loss and reconnect, absent-old-binding refusal, other-owner absence, invalid credential rejection, and post-recovery old-device/old-Consent denial. This is not IndexedDB evidence.
- `test/browser/run-device-key-idb.mjs`: the parent operated a dedicated Codex IAB tab on localhost 5186. Chrome 152 on Windows restored an actual nonextractable CryptoKey from real IndexedDB after page reload, rejected private export and verified its new signature using the original public key. A subsequent narrow run also copied the selected visitor draft, rejected a stale preview, accepted only one of two concurrent copies and retained the visitor original. Both runs used disposable random test databases, zero cloud requests, and confirmed database deletion. Parent browser ownership supplied these observations; the child had no available browser surface.
- Four affected TSX components were parsed with esbuild, write disabled, with zero warnings. The seven preexisting missing form-submit types in chat, personal summary and notification settings were corrected. Full application build, live UI integration and deployment remain separately owned by the parent.

The local test servers were stopped after their respective receipts. These tests did not use real account credentials, production identity material, a model service, background backups or Hermes archives.
