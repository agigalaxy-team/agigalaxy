"""Native conversation tool adapters; Galaxy owns permissions, source scope and effects."""
import json
from typing import Annotated
from pydantic import Field
from uuid import UUID

from agno.run.base import RunContext
from agno.tools.function import FunctionCall

from .gateway import AuthorityDenied
from .conversation_references import selected_query_reference, tool_public_reference, current_public_references
from .conversation_task_operations import task_operation_tool

# Retain the established import surface for runtime callers and contract consumers.
from .conversation_tool_contracts import (
    Topic,
    Reason,
    Deadline,
    ClosedArguments,
    Module,
    View,
    ReadKind,
    VIEWS,
    Token,
    QueryFilters,
    AccountSummaryReadFilters,
    FeedbackMetadataFilters,
    Visibility,
    ContentVisibility,
    PublicContentItem,
    PublicContentBatch,
    PrivateCaseMessage,
    SectionVisibility,
    ResourceVisibility,
    ContentCuration,
    SectionClassification,
    FeedbackUpdate,
    FileScanRetry,
    FileCleanupApprove,
    AccountRestriction,
    FileAccess,
    CaseResolve,
    MessagingState,
    StrategyControl,
    StrategyContinue,
    StrategyDraft,
    StrategyRehearsal,
    StrategyPublish,
    OrdinaryParameterEdit,
    OrdinaryStrategyDraft,
    OrdinaryStrategyPublish,
    SearchReason,
    JobCancel,
    JobRetry,
    SearchRetry,
    SearchApply,
    SearchDraftSave,
    SearchRestore,
    RecommendationThemeKey,
    RecommendationDirection,
    RuleKey,
    RuleReason,
    RulePublish,
    RuleRestore,
    _BusinessOperation,
    DutyPreparedOperation,
    PreparedOperation,
    _preparation_type,
    _prepared_arguments,
    MessageDraftCreate,
    MessageDraftSave,
    AiWorkPromptSave,
    AiRoleCommand,
)

from .conversation_tool_feedback import (
    _QUERY_FILTER_CONTRACTS,
    _FEEDBACK_FILTER_KEYS,
    _FEEDBACK_FILTER_ENUMS,
    _WINDOW_DAYS,
    _WINDOW_DEFAULT_DAYS,
    _window_filter_feedback,
    _analysis_constraints,
    _feedback_filter_feedback,
    _query_filter_feedback,
    _preparation_feedback,
)


def conversation_tools(gateway, *, domain=None):
    preparation_type = _preparation_type(domain)

    def send(context, call, name, arguments, *, selected_reference=None):
        if not isinstance(call, FunctionCall) or not call.call_id:
            raise AuthorityDenied("agentos_native_tool_call_required")
        reference, feedback = tool_public_reference(name, arguments, context.metadata,
            selected=selected_reference)
        if feedback is not None:
            if name == "prepare-operation":
                feedback = _preparation_feedback(feedback)
            return json.dumps(feedback, ensure_ascii=False, allow_nan=False)
        binding = {"run_id": context.run_id, "call_id": call.call_id,
            "session_id": context.session_id, "turn_id": (context.metadata or {}).get("operationId")}
        if reference is not None:
            binding["public_reference"] = reference
        result = gateway.conversation_tool(context.user_id, name, arguments, **binding)
        if name == "prepare-operation":
            result = _preparation_feedback(result)
        elif name in {"query-operations", "read-operation-object"}:
            result = _analysis_constraints(result, module=arguments.get("module"),
                view=arguments.get("view"), filters=arguments.get("filters"))
        return json.dumps(result, ensure_ascii=False, allow_nan=False)

    def query_operations(run_context: RunContext, fc: FunctionCall,
            module: Module, view: View, filters: QueryFilters | None = None) -> str:
        """Query a current permitted operations module using its fixed view and filters.

        Use the server's real counts, aggregation, pagination and source refs.
        A partial page is not a total. Filters never accept SQL, URLs, paths,
        roles or grants. Case directories contain metadata only; this list query
        never returns case narratives, private chat or message bodies. Only
        read_operation_object may read the selected public-report case's current
        service-authorized public-case-review material. An unavailable module
        is not an empty or zero result.

        system-settings describes configuration and consumer adoption, not service
        health. Use maintenance/overview for observed runtime and health facts.

        Windowed reads: days is mandatory for each supported window view:
        accounts/summary 7 or 28; content/list and feedback/list 7,28,all;
        analytics overview/business/retention/paths/account integers 1..90;
        recommendations/overview and search/overview 7,30,90. Missing days is
        rejected locally without a query. Never infer or silently fill the
        user's choice. If no time range was requested, explicitly use this
        view's published defaultDays and disclose that window in the answer;
        no follow-up question is needed. The tool never fills days itself.
        An explicitly requested range must still match. Do not send days to
        views that do not support it.
        Read analysisConstraints with the unchanged original response: zero
        is not a collection-health diagnosis; null/unknown reasons require an
        explicit source explanation; ratios need counts and cannot prove user
        intent. runtime_event_rejected in maintenance logs only normalizes an
        event name outside the Galaxy allowlist, not a proxy/security finding.
        Explicitly pass the user's supported days for each
        requested view; do not rely on another module's default. recommendations
        overview supports days=7/30/90 and defaults to 30; search overview also
        supports 7/30/90 but defaults to 7. Their returned period is the event
        window; recommendations supply is current public stock, not new posts.
        Missing or uncollected metrics must not be invented as zero.
        content list supports days=7/28/all (default 7), kind=post or reply,
        visibility=visible and a requested limit (server cap 20). Omitting kind
        returns one mixed page, not two samples. Use independent kind queries
        when separate post/reply samples are requested. Returned pagination and
        scanLimited determine coverage; a page count is not a total.

        feedback list accepts only category=unclassified/problem/suggestion,
        module=account/community/chat/work/discovery/other,
        state=pending/processing/closed, days=7/28/all, after and limit (1..100,
        default 30). It does not accept query or search titles/bodies. Its list
        contains metadata only; for the text of a selected real feedback ID,
        use read_operation_object(kind="feedback", id=that actual ID).
        An invalid filter response is not a completed read or an empty result.

        Common views: accounts list/summary; content list/sections/tags;
        analytics overview/business/retention/paths/account; messaging
        plans/runs/recipients/history; maintenance overview/backups/plans/logs.
        Other modules use list, overview, history or versions as appropriate.
        For messaging recipients, pass a real runId and optionally channel
        inapp or email; these are recipient reads, never message delivery.
        File cleanup views only read candidates and concrete plan progress;
        they never approve a plan or remove a file.
        registered-users list is the configured website registration directory,
        including identities with no business profile. Use page/pageSize and
        the returned complete-generation/as-of/count basis; business accounts
        and businessCreatedAt are not full registrations or registration dates.
        Directory output excludes email, issuer, subject and security history.
        system-settings views are read-only safe metadata. General is the
        current published website configuration; saved admin drafts are not
        read. Other sections distinguish saved configuration and consumer ACK.
        No credential values, references, environment or raw errors are exposed.
        Analytics uses relative days (1..90), not day/from/to calendar dates:
        overview/business accept days; paths/retention also accept scope=accounts
        and an optional accountId (accountId requires that scope); account
        requires accountId and accepts days. Report the returned time basis;
        do not silently substitute a rolling window for a requested exact date.
        """
        if view not in VIEWS[module]:
            return json.dumps({"state": "invalid-request",
                "reason": "agentos_tool_arguments_invalid", "module": module,
                "allowedViews": sorted(VIEWS[module]), "effectExecuted": False})
        values = filters.model_dump(mode="json", exclude_unset=True, exclude_none=True) if filters else {}
        if module == "content" and view == "list":
            ref = selected_query_reference(values.get("query"), run_context.metadata)
            # A literal supplied link is an exact selection, not a request for
            # a broad list. Keep semantic filters on the normal list route.
            if ref is not None and not set(values) - {"query", "kind", "limit"}:
                if values.get("kind", ref["kind"]) != ref["kind"]:
                    return json.dumps({"state": "invalid-request", "reason": "agentos_tool_reference_mismatch", "effectExecuted": False})
                return send(run_context, fc, "read-operation-object", {"kind": ref["kind"], "id": ref["id"]}, selected_reference=ref)
            if values.get("targetId") and not set(values) - {"targetId", "kind", "limit"}:
                refs = [item for item in current_public_references(run_context.metadata) if item["id"] == values["targetId"]]
                if refs:
                    kinds = {item["kind"] for item in refs}
                    if len(kinds) != 1 or values.get("kind", refs[0]["kind"]) != refs[0]["kind"]:
                        return json.dumps({"state": "invalid-request", "reason": "agentos_tool_reference_mismatch", "effectExecuted": False})
                    # A copied exact ID cannot discard this turn's version
                    # constraint by changing the model's choice of read tool.
                    return send(run_context, fc, "read-operation-object", {"kind": refs[0]["kind"], "id": values["targetId"]})
        # Exact references above become object reads, not windowed lists.
        # Keep their original version/ambiguity binding before list filters.
        feedback = _query_filter_feedback(module, view, values)
        if feedback is not None:
            return json.dumps(feedback, ensure_ascii=False, allow_nan=False)
        if module == "analytics":
            allowed = {"days"}
            if view in {"paths", "retention"}:
                allowed |= {"scope", "accountId"}
            elif view == "account":
                allowed.add("accountId")
            invalid = (bool(set(values) - allowed) or values.get("days") == "all"
                or view == "account" and not values.get("accountId")
                or view in {"paths", "retention"} and values.get("accountId") is not None
                and values.get("scope") != "accounts")
            if invalid:
                return json.dumps({"state": "invalid-request",
                    "reason": "agentos_tool_arguments_invalid", "module": module, "view": view,
                    "allowedFilters": sorted(allowed), "daysRange": {"min": 1, "max": 90},
                    "calendarDateSupported": False, "accountIdRequired": view == "account",
                    "accountScopeRequiredForAccountId": view in {"paths", "retention"},
                    "effectExecuted": False})
        return send(run_context, fc, "query-operations",
            {"module": module, "view": view, "filters": values})

    def read_operation_object(run_context: RunContext, fc: FunctionCall,
            kind: ReadKind, id: Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")],
            filters: AccountSummaryReadFilters | None = None) -> str:
        """Read a selected operations object through its current business permission.

        Use real object identifiers returned by an earlier query or the
        program-parsed public-link candidates from this current user turn. The
        server rechecks source validity and returns the permitted projection;
        no arbitrary route, private chat body or credential is available.
        A selected public-report case may return only current service-authorized
        public-case-review material, never legacy private narrative or new
        permission. Respect material.coverage and truncation flags; a report
        alone is not a violation finding and incomplete material cannot support
        a processing conclusion. This task material is not a profile source.
        file-cleanup-plan and file-cleanup-operation are read-only; an original
        receipt lookup cannot approve, retry or execute cleanup.
        Only account-summary accepts filters: days must be 7 or 28, with no
        calendar day/from/to. Use the returned basis for each analysis source;
        lifetime metrics and fixed weekly retention are not a selected-day result.
        """
        arguments = {"kind": kind, "id": id}
        if filters is not None:
            values = filters.model_dump(mode="json", exclude_none=True, exclude_unset=True)
            if (values and kind != "account-summary" or set(values) - {"days"}
                    or "days" in values and values["days"] not in {7, 28}):
                return json.dumps({"state": "invalid-request",
                    "reason": "agentos_tool_arguments_invalid",
                    "allowedFilters": ["days"] if kind == "account-summary" else [],
                    "allowedDays": [7, 28] if kind == "account-summary" else [],
                    "calendarDateSupported": False, "effectExecuted": False})
            arguments["filters"] = values
        return send(run_context, fc, "read-operation-object", arguments)

    def list_authorized_work(run_context: RunContext, fc: FunctionCall) -> str:
        """List the current manager's actual authorized work and present eligibility.

        This does not create a grant. Use returned execution IDs internally;
        people should select meaningful work, not copy technical identifiers.
        These items are existing grant-bound executions, not the set of actions
        a manager may confirm. Empty items or a not-authorized directory basis
        do not disable human preparation. The separate humanPreparation field
        reports the current manager/AI/domain permitted kinds, never object
        eligibility. If the requested kind is listed, read the actual object
        and use prepare_operation; only its concrete card can be confirmed.
        """
        return send(run_context, fc, "list-authorized-work", {})

    def run_authorized_work(run_context: RunContext, fc: FunctionCall,
            execution_id: UUID) -> str:
        """Run an existing authorized, prepared ordinary operation by execution ID.

        Galaxy checks current grants, frozen command, object/CAS and original
        human boundaries on every call. Existing human-review waits cannot be
        bypassed. A pending or unknown receipt is not successful execution.
        """
        return send(run_context, fc, "run-authorized-work", {"executionId": str(execution_id)})

    def read_ai_delegation(run_context: RunContext, fc: FunctionCall,
            ai_account_id: UUID | None = None) -> str:
        """Read current human-approved AI-only management scope or one prompt.

        With no ID, return only the actual delegation, target AI IDs and role
        metadata. For one genuine target ai_account_id, Galaxy returns its role
        prompt/current revision/version only when current prompt-read and
        ai.prompts.read permit that exact target. A missing scope or denied
        prompt is not permission to inspect other accounts or infer text.
        This tool never changes roles, assignments, prompts or model settings.
        To request a change in this conversation, prepare_operation a concrete
        ai-work-prompt-save or ai-role-command card; the person must confirm.
        """
        arguments = {} if ai_account_id is None else {"aiAccountId": str(ai_account_id)}
        return send(run_context, fc, "read-ai-delegation", arguments)

    def prepare_operation(run_context: RunContext, fc: FunctionCall,
            operation: preparation_type) -> str:
        """Prepare one concrete operations action for the manager to review.

        Report a prepared card only when the actual response has state=prepared,
        card.state=prepared and a genuine card.cardId. Read preparationFeedback:
        a returned tool response or completed model run is not card success.
        not-prepared means no prepared card was returned; explain the original
        refusal, and never invent a hidden reason. Unknown/processing or a
        prepared response missing its card ID requires the original operation
        lookup, never another prepare POST. Preparation itself proves no
        business effect; actual completion requires the original card receipt.

        It freezes the actual object, current permissions and versions in
        Galaxy. It performs no business mutation and grants no AI authority.
        This human-confirmed route does not require a pre-existing execution
        or automatic grant. An empty list_authorized_work is not a refusal of
        this route; Galaxy separately checks the current manager and AI's actual
        preparation permissions, source and CAS. For content-curation, omit
        topic to keep its override; explicitly include topic=null to clear only
        the operational category override and return to current originalTopic.
        Keep unrelated pinned/featured/tagIds absent unless the user asks for
        them. This supports clearing the override without a separate action.
        Supply the intended business change; Galaxy determines CAS and stable
        operation identifiers. Use genuine object IDs from query tools. Do not
        invent deadlines; ask the manager when an exact hide time is missing.
        A human card's actual result is required before reporting completion.
        Keep every unrequested field unchanged. feedback-update note is a
        separate internal-note mutation: omit it unless explicitly requested,
        including when restoring category/module/state. Never invent an audit
        reason or note. The existing null/omission contract is unchanged.
        A feedback pending/processing/closed status is a business value, distinct
        from common-task/model/human-decision state; report their actual source.
        For AI-only management first read current_summary and the current
        read_ai_delegation directory. ai-work-prompt-save accepts only the
        actual allowed aiAccountId and intended ordinary prompt text (up to
        16000 characters); Galaxy freezes its current revision/prompt/delegation
        versions. It cannot edit a model, code boundary, goal or running plan.
        ai-role-command wraps one real role-create/role-update/assignment-save
        command and its current expectedVersion from that directory. Neither
        card grants execution or expands the human-approved delegation ceiling,
        edits personnel/shared roles or gives the controlling AI more power.
        Workbench preparation never invokes the background management writer.
        In the overview domain, rule-publish prepares an existing real draft;
        rule-restore selects a real published version from rule history.
        Both require the manager's concrete card confirmation, never accept
        policy JSON or client-supplied CAS, and do not change rules here.
        In discovery or overview, recommendation-direction changes only one
        existing category/tag/cross-category theme's soft display direction.
        Read recommendations.overview first and use its actual themeKey.
        Galaxy preserves policy/theme switches, other directions, controls and
        mappings. A saved direction does not mean ranking is active when the
        policy or theme is disabled. This route still requires a human card.
        For search-draft-save first read search.overview, preserve the current
        complete settings and fixedConstraints, and supply the intended complete
        settings and a reason. If revising a draft explicitly select its actual
        expectedDraftId; never overwrite an unselected draft. Search history
        supplies versionId; read-operation-object search-version retrieves that
        version's complete settings before preparing a restore. A saved draft
        is not an applied search configuration. Apply and restore require the
        original confirmed card and the actual native reconciliation result.
        In maintenance or overview, file-cleanup-approve only prepares review
        of an existing awaiting-approval plan returned by the query tools.
        Supply only its real planId. Galaxy shows the complete frozen selection
        and derives the current revision. No approval or deletion occurs here;
        the manager must explicitly confirm the card before code can approve.
        In governance or overview, account-restriction prepares the existing
        community participation restriction, not a login suspension. Query the
        real account first. Apply requires the manager's explicit future ISO
        deadline including timezone and a reason; never invent a duration.
        Release has a reason and until=null in nullable tool formats. The native
        adapter omits only this null before Galaxy. Both only prepare a human
        confirmation card and never enter automatic authorized work here.
        In maintenance or overview, file-access prepares an operational stop
        or restoration for a real chat/forum file returned by a query. Stop
        requires an explicit future epoch deadline and reason; restore has
        until=null in nullable tool formats; the native adapter omits this null.
        Galaxy supplies both current file and access revisions.
        This is neither a revoke/delete nor a scan bypass or retention change.
        No business change occurs until the manager confirms the exact card.
        """
        return send(run_context, fc, "prepare-operation",
            _prepared_arguments(operation))

    query_operations.__doc__ += "\nExact module views: " + "; ".join(
        name + " " + "/".join(sorted(views)) for name, views in VIEWS.items()) + "."
    return [query_operations, read_operation_object, list_authorized_work,
        run_authorized_work, task_operation_tool(send), read_ai_delegation, prepare_operation]
