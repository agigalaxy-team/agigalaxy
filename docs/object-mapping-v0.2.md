<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/22/223110a8bf93a657355e945a21b5d8b73c5a53413695fce0065c937214c310d8.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Local and Official object mapping boundary

This is a mapping definition for incremental client work, not an implementation
of automatic upload. The current Core store and Official schemas remain distinct.

| Local object / field | Remote representation | Constraint |
|---|---|---|
| `galaxyId`, identity ID | `subjectId` / `subject` | Preserve the exact Galaxy ID; binding requires its genesis opening and proof of key possession |
| Case Draft `id` (`case_…`) | Case `localRef` and explicit local source reference | Remote `id` is a separately selected UUID; never rewrite the local ID to the remote ID |
| Case Draft `title` | Case `title` | Only after payload preview and consent; local maximum 120, remote maximum 160 |
| `failureSummary` | Case `summary` | Include only the selected failure summary, not the entire local record |
| `attemptedApproaches` | Future Attempt events | Strings alone do not supply required environment/version/tools metadata; no automatic conversion or invented evidence |
| Disclosure Plan `recipient`, `purpose`, `include` | Draft inputs for a new remote consent intent | Not a signed remote intent; actual endpoint, object, fields, payloadHash and scope must be newly previewed |
| Local `grant_…` receipt | No automatic remote credential | Local receipt does not authorize network transfer; remote consent has its own UUID, signature, binding, fields and expiry |
| Local Proof Draft `proof_…` | No automatic remote Proof | Verification note is not independent evidence; remote limited CI Proof requires its own source observation, preview and consent |
| Local timestamps/status | Local historical facts | Do not fabricate server acceptance/verification timestamps or change localOnly merely because an endpoint is configured |

Shared Official schema modules are imported by their previous service entrypoints
and re-exported for compatibility. Digest hashes exact UTF-8 payload bytes, not a
reserialized object. Schemas validate data shape; they do not establish consent,
identity ownership, source truth or recipient trust. Those checks stay in their
transactional application paths.

No migration of existing IDs, signatures or grant semantics is part of the shared
definition extraction. A future outbound adapter must persist explicit local to
remote references and honor retry/idempotency rules without allocating a new
remote object on every retry.

Current mapping: [v0.4](../../../GALAXY_OBJECT_MAPPING_v0.4.md), including public projections, original quotations, implementation gaps and protocol candidate boundaries. This v0.2 text remains historical extraction context.
