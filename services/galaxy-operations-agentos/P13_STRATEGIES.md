# P13 fixed strategy workflow and bounded ordinary tools

This is a Galaxy adapter for fixed Agno 3.1.7 primitives. It does not introduce
user-authored Python, SQL, arbitrary tool registration or another workflow engine.

## Configuration and current scope

Galaxy stores human-authored common/domain objectives, strategy versions,
classified program rehearsal and a binding from a concrete authorized execution
to one immutable strategy/workflow version. Agno stores the actual Workflow
component, durable queue ticket, native run, step results and pause requirements.
The fixed component is `galaxy-p13-selected-content-v1`, version `1`.

The connected effect slice is a previously prepared `content-visibility` command
for one explicitly selected public post/reply. It executes via the existing
`execute-prepared-command` gateway and original domain receipt. Source expiry,
current anonymous-public eligibility, source/decision CAS, temporal limits,
current grant, and an intervening human/other-grant decision are rechecked.
Rules and model output never supply authorization. The P14 business-controls
reference is pinned as a **new-writes-only** reference; it does not authorize a
visibility action. Numeric content predicates reuse P14's three-valued evaluator.

The four leadership modes select deterministic code, a complex semantic adviser,
ordinary human participation, or an explicit human pause. A semantic branch with
no configured model is not accepted into the queue. Code and human routes work
without a model. The adviser has no effect tools; only a closed decision is
persisted. Public source text is transient, not a native workflow input or memory.

## Ordinary maintenance tools

The governance Agent adds exactly these tools:

- `read-selected-strategy`: current selected strategy, human-set bounds and goals.
- `save-selected-strategy-draft`: existing numeric condition values at explicit
  rule-index paths, a human-allowed mode, or explicitly permitted daily enable/disable.
- `publish-selected-strategy`: only this execution's ordinary draft, after current
  program qualification using the human-selected sample references.

They require a current P10 automation grant and P105 attested execution selecting
the existing strategy UUID, with `strategies.read`,
`strategies.ordinary.configure` and/or `strategies.ordinary.publish`. No empty
object list means all strategies. Default `ordinaryBounds:null` grants nothing.
The model cannot submit an entire configuration, change a goal/boundary, alter
condition field/operator/structure, edit important human-led strategies, overwrite
a pending human draft, or configure models. Numeric fields are only `textLength`,
`linkCount`, `attachmentCount`; the min/max values are manually provided, not
product defaults. Provider/model settings remain exclusively manual.

Publishing affects new matters. Existing matters keep their pinned plan, but every
effect still checks current permission/common stop/source/CAS. Daily disabling does
not undo completed actions. Re-enabling follows only the same immutable sample
ancestry and rechecks it; an empty or stale sample cannot open all-object scope.
Tool intent IDs are deterministic per actual native run/closed arguments; the
Node operation ledger is authoritative for repeated results.

## AI agent deployment

1. Discover the existing private AgentOS URL, signing/service key **references**
   and PostgreSQL runtime configuration through the established loader. Do not
   copy resolved credentials into source, reports, command logs or browser input.
2. Install migration `112` after `111`, then apply the exact API grants from
   `p13StrategiesApiGrantsSql`/`api-role.sql`. No worker receives new P13 writes;
   native Python has no business-table rights.
3. Deploy the Node P13 central wiring and a **new** native image tag together.
   Preserve the currently deployed P20 model profiles and bindings. Do not reuse
   the previous image tag or change provider/model credentials for a workflow test.
4. Keep `/v1/internal/agentos/*` private and outside the admin BFF. Both new exact
   `/p13/context` and `/p13/step` routes verify the service key before body parsing.
   Native routes additionally check the current execution JWT, owned matter,
   fixed Workflow ID, exact session and latest Node context.
5. Before enabling a strategy, check `/health` for the P13 workflow ID/version
   acknowledgement. An old healthy AgentOS image is not evidence of P13 support.
   Missing/unknown readiness remains disconnected in Galaxy.
6. Initial goals, strategy catalog and automation are empty/disabled. A human
   supplies objectives, an explicit supported strategy, selected execution
   samples and a successful classified rehearsal before publication.

Agno 3.1.7 does not support this durable queue with SQLite. The actual native
checks use the existing PostgreSQL instance's separately authorized check schema.
Use stable native step IDs. Published component registration uses
`ComponentType.WORKFLOW`, strips connection configuration and rejects definition
drift rather than overwriting a published version. Future template changes require
another component ID/version while in-progress v1 remains loadable.

In the fixed 3.1.7 source, a reviewed Step nested under `Condition` does not
perform its own pre-step human review. P13 therefore uses a top-level dynamic
output-review Step. Continuation reads the owned native requirement; browser
approval JSON cannot replace its identity or source. Native retry attempts are
one, and step retries are zero. Unknown effect/dispatch results reconcile the
original receipt; they are not a reason to create another action/model run.

## Verification and limits

Support evidence is in `07-logs/development/admin-implementation-20261023/
p13-strategies/`. Four real Node/PG leaves, two actual Agno/PostgreSQL workflow
leaves and one tool-wrapper schema leaf ultimately pass. Earlier failures and
narrow retries remain separate. Native authority/effect/adviser transports in
the native group are explicit doubles; the Node group uses the actual business
database and public-content consumer. No provider calls or synthetic production
business events were created. This is not a production end-to-end acceptance.

Other domain strategies may be organized as `analysis-only`; message sending,
file purge, website restore, arbitrary parameter maintenance and unscoped effects
are not connected by P13. No automatic new-matter discovery or all-domain trigger
is introduced. Recovery is only to an explicitly human-approved published version
for new matters and never replays an old business effect. Current global pause
and current authorization still apply. Routine strategy maintenance is limited to
the specific existing strategy slice and human numeric bounds described above.
