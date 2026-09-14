# Room Agent scope and watch stop

This slice connects two already adopted behaviors: room members can understand the limited Agent participation, and stopping a local watch also withdraws its selected room permission. It introduces no database migration or centralized model runtime.

## Member-readable scope

`POST /v2/chat/rooms/{roomId}/agent-participants`, authenticated `binding` scope, accepts `{after?: UUID, limit?: 1..100}`. Only current room members may read it; AI subzones also require current parent-room membership. The default page size is 50.

The response is `{items, next}`. Each item contains `grantId`, `subjectId`, `mode`, `primaryResponder`, `expiresAt`, `state`, `hostRuntimeState: "unverified"`, `readScope: "current-room-authorized-history"` and `allowedActions`. The actions are read, draft and/or respond according to the current permission; inactive permissions return an empty actions list. Current device control, expiry, revocation, room state, membership and pending author deletion are applied. No binding ID, installation ID, credential or private purpose is included.

The existing `/agent-grants` query remains the owner's management view. Reading member-visible scope never grants management rights. `galaxy_chat_agent_participants` is the same operation through canonical Personal MCP and the native HTTP adapter. `AgentParticipants({runtime, roomId})` provides the shared webpage view and ignores replies from a previously selected room.

During retirement takeout the new exact read route remains available under current ACL. Incident containment and status-only retirement do not enable it. No mixed write route is admitted.

## Stopping a watch

`galaxy_watch_stop({id})` first persists local `stopped`, clears its pending work and lease, and then calls the existing `/agent-revoke` with exactly that watch's room and grant. It does not revoke other room permissions or erase messages.

The result separates `furtherGalaxyChecks: false`, `remoteGrantRevoked`, `authorizationState`, `retryStopRequired`, and `externalModelCancellation: "host-must-confirm"`. An offline or missing acknowledgement leaves a durable `unconfirmed` revocation. Repeating the same watch ID retries that original revocation even though local state is already stopped. A confirmed acknowledgement avoids another request. A late failed concurrent retry cannot overwrite a confirmed receipt. Server revocation preserves its first recorded timestamp.

This does not kill an external process or claim a host supports interruption. A new watch needs a currently valid, explicitly chosen grant. Normal human chatting and local working permissions remain independent.

## Validation and deployment

The actual local BrowserRuntime/HTTP/PGlite workflow passed: current identity and room ACL; member pagination without device data; outsider/subzone rejection; native tool mapping; offline stop, lost revoke acknowledgement and retry after local reload; blocked sends through the revoked grant and an unrelated grant remaining active. Account/OIDC was explicitly excluded from this fixture, and no real model or message transport was started. The affected native lease/echo/stop test and precise retirement route test passed independently. The new component's strict TypeScript import closure has no errors.

AI-agent deployment: use the existing API and client release process; schema and provider configuration are unchanged. Keep API, native tool descriptions/adapters and webpage assets from the same release. Do not infer live Agent execution from active permissions, resume paused backups, or introduce a server-side model scheduler. Publish only after the owning release task records its actual deployment evidence.

Remaining boundaries: this narrow slice does not claim cross-device watch transfer, every host's cancellation mechanism, or the complete M12/M17 user experience is accepted. Historical source and adopted decisions remain in the project work packages and the linked development record.
