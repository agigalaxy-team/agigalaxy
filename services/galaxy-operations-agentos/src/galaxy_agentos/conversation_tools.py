"""Typed native tools; Node owns current permissions, source scope and effects."""
import json
from datetime import datetime
from typing import Annotated, Literal, Union
from uuid import UUID

from agno.run.base import RunContext
from agno.tools.function import FunctionCall
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .gateway import AuthorityDenied
from .conversation_references import selected_query_reference, tool_public_reference, current_public_references


Topic = Literal["technology", "arts", "learning", "life", "galaxy", "unclassified"]
Reason = Annotated[str, Field(min_length=3, max_length=1600)]
Deadline = Annotated[int, Field(strict=True, gt=0)]


class ClosedArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


Module = Literal["accounts", "content", "cases", "chat-reports", "feedback", "files",
    "resources", "analytics", "recommendations", "search", "messaging", "strategies",
    "rules", "maintenance", "audit", "runs", "jobs", "permissions", "registered-users", "system-settings"]
View = Literal["list", "summary", "sections", "tags", "projects", "methods", "overview",
    "business", "retention", "paths", "account", "history", "plans", "runs", "recipients",
    "versions", "records", "backups", "logs", "roles", "personnel", "automation",
    "cleanup-candidates", "cleanup-plans", "general", "mail", "service-connections", "advanced"]
ReadKind = Literal["account", "account-summary", "post", "reply", "section", "case",
    "chat-report", "feedback", "chat-file", "forum-file", "project", "method",
    "message-plan", "message-run", "rule", "strategy-run", "ai-run", "backup-point",
    "restore-plan", "role", "file-cleanup-plan", "file-cleanup-operation", "registered-user"]
VIEWS = {"accounts": {"list", "summary"}, "content": {"list", "sections", "tags"},
    "cases": {"list"}, "chat-reports": {"list"}, "feedback": {"list"},
    "files": {"list", "summary", "cleanup-candidates", "cleanup-plans"}, "resources": {"projects", "methods"},
    "analytics": {"overview", "business", "retention", "paths", "account"},
    "recommendations": {"overview", "history"}, "search": {"overview", "history"},
    "messaging": {"plans", "runs", "recipients", "history"},
    "strategies": {"overview", "versions", "records"}, "rules": {"overview", "versions"},
    "maintenance": {"overview", "backups", "plans", "logs"}, "audit": {"list"},
    "runs": {"list"}, "jobs": {"list"}, "permissions": {"roles", "personnel", "automation"},
    "registered-users": {"list"}, "system-settings": {"overview", "general", "mail", "service-connections", "advanced"}}
Token = Annotated[str, Field(pattern=r"^[A-Za-z0-9_.-]{1,80}$")]


class QueryFilters(ClosedArguments):
    """Finite filter fields; Node further validates the exact module/view schema.

    Pagination values and IDs come from tool results. These are neither SQL
    filters nor a general HTTP parameter bag. Null optional values are omitted.
    """
    after: Annotated[str, Field(max_length=1024)] | None = None
    limit: Annotated[int, Field(strict=True, ge=1, le=100, description="Requested page size, not a total. content/list applies at most 20 rows; use separate kind=post and kind=reply queries for separate samples.")] | None = None
    query: Annotated[str, Field(max_length=320)] | None = None
    subjectType: Literal["person", "organization", "agent", "unknown"] | None = None
    restriction: Literal["normal", "restricted"] | None = None
    days: Annotated[Annotated[int, Field(strict=True, ge=1, le=90)] | Literal["all"] | None,
        Field(description="Relative window: analytics accepts integers 1..90 (default 7); recommendations/overview accepts 7,30,90 (default 30); search/overview accepts 7,30,90 (default 7); content/list and feedback/list accept 7,28,all (default 7). Explicitly pass the requested supported window; defaults differ by module. Returned period/basis is authoritative.")] = None
    kind: Annotated[Literal["post", "reply", "chat", "forum", "all", "business", "reads"] | None,
        Field(description="content/list accepts post or reply; omission returns one mixed page, not a separate page for each kind. Other modules retain their declared kinds.")] = None
    topic: Topic | None = None
    visibility: Literal["visible", "hidden", "unavailable"] | None = None
    pinned: bool | None = None
    featured: bool | None = None
    state: Token | None = None
    category: Topic | Literal["problem", "suggestion"] | None = None
    roomId: UUID | None = None
    module: Literal["account", "community", "chat", "work", "discovery", "other"] | None = None
    processing: Literal["scan", "cleanup"] | None = None
    issue: Literal["any", "scan", "cleanup", "all", "no-results", "no-recorded-click",
        "scan-limited", "unmeasured"] | None = None
    scope: Literal["accounts"] | None = None
    accountId: UUID | None = None
    planId: UUID | None = None
    runId: UUID | None = None
    channel: Annotated[Literal["inapp", "email"], Field(
        description="Official messaging recipients view only; pass its real runId.")] | None = None
    strategyId: UUID | None = None
    key: Literal["resource-budget", "community-quota", "forum-quota", "business-controls"] | None = None
    component: Annotated[str, Field(pattern=r"^[a-z][a-z0-9-]{0,63}$")] | None = None
    level: Literal["all", "info", "warn", "error"] | None = None
    period: Literal["15m", "1h", "24h"] | None = None
    before: Annotated[str, Field(max_length=64)] | None = None
    resourceId: UUID | None = None
    targetId: UUID | None = None
    action: Token | None = None
    day: Annotated[str, Field(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
        description="Business audit list date only; analytics does not accept a calendar day.")] | None = None
    page: Annotated[int, Field(strict=True, ge=1, le=100000)] | None = None
    pageSize: Literal[20, 50, 100] | None = None
    source: Literal["all", "registered", "business-only"] | None = None
    business: Literal["formed", "not-formed"] | None = None
    login: Literal["enabled", "disabled"] | None = None
    emailVerified: Literal["yes", "no"] | None = None
    participation: Literal["restricted", "unrestricted"] | None = None
    registeredFrom: Annotated[str, Field(max_length=64)] | None = None
    registeredTo: Annotated[str, Field(max_length=64)] | None = None
    sort: Literal["registered-desc", "registered-asc"] | None = None
    domain: Literal["overview", "governance", "messaging", "discovery", "maintenance"] | None = None
    queue: Literal["information-watch", "search-recovery", "content-publication", "account-notice",
        "retention-cleanup", "messaging-run", "messaging-delivery"] | None = None


class AccountSummaryReadFilters(ClosedArguments):
    """Only account-summary reads accept a selected 7 or 28 day window."""
    days: Annotated[int, Field(strict=True, json_schema_extra={"enum": [7, 28]})] | None = None

    @model_validator(mode="after")
    def selected_window(self):
        if self.days not in {None, 7, 28}:
            raise ValueError("account-summary read days must be 7 or 28")
        return self


class FeedbackMetadataFilters(ClosedArguments):
    """The feedback/list route exposes metadata filters, never prose search."""
    category: Literal["unclassified", "problem", "suggestion"] | None = None
    module: Literal["account", "community", "chat", "work", "discovery", "other"] | None = None
    state: Literal["pending", "processing", "closed"] | None = None
    days: Literal[7, 28, "all"] | None = None
    after: Annotated[str, Field(pattern=r"^[1-9][0-9]{0,18}$", max_length=19)] | None = None
    limit: Annotated[int, Field(strict=True, ge=1, le=100)] | None = None

    @model_validator(mode="after")
    def sequence_boundary(self):
        if self.after is not None and int(self.after) > 9223372036854775807:
            raise ValueError("agentos_feedback_cursor_invalid")
        return self


class Visibility(ClosedArguments):
    targetId: UUID
    action: Literal["hide", "restore"]
    until: Deadline | None = None
    reason: Reason

    @model_validator(mode="after")
    def exact_deadline(self):
        if (self.action == "hide") != (self.until is not None):
            raise ValueError("agentos_hide_deadline_required")
        return self


class ContentVisibility(Visibility):
    kind: Literal["content-visibility"]
    targetKind: Literal["post", "reply"]


class PublicContentItem(ClosedArguments):
    kind: Literal["post", "reply"]
    id: UUID


class PublicContentBatch(ClosedArguments):
    kind: Literal["public-content-batch"]
    items: Annotated[list[PublicContentItem], Field(min_length=1, max_length=25)]
    action: Literal["hide", "restore"]
    until: Deadline | None = None
    reason: Reason

    @model_validator(mode="after")
    def bounded_selection(self):
        if len({(item.kind, item.id) for item in self.items}) != len(self.items):
            raise ValueError("agentos_duplicate_selected_object")
        if (self.action == "hide") != (self.until is not None):
            raise ValueError("agentos_hide_deadline_required")
        return self


class PrivateCaseMessage(ClosedArguments):
    kind: Literal["private-case-message"]
    reportId: UUID
    messageId: UUID
    action: Literal["hide", "restore", "keep"]
    summary: Annotated[str, Field(min_length=1, max_length=1600)]


class SectionVisibility(Visibility):
    kind: Literal["section-visibility"]


class ResourceVisibility(Visibility):
    kind: Literal["resource-visibility"]
    targetKind: Literal["projects", "methods"]


class ContentCuration(ClosedArguments):
    kind: Literal["content-curation"]
    targetKind: Literal["post", "reply"]
    targetId: UUID
    topic: Topic | None = Field(default=None, description=(
        "Omit topic to leave the existing operational category override unchanged. "
        "Explicit topic=null clears that override and uses the current source author's "
        "originalTopic; it does not set an unclassified category or edit the source. "
        "Read the current object and originalTopic before preparing this change."))
    pinned: bool | None = None
    featured: bool | None = None
    tagIds: Annotated[list[UUID], Field(max_length=8)] | None = None
    reason: Reason

    @model_validator(mode="after")
    def changed_field(self):
        if not any(name in self.model_fields_set and (name == "topic" or getattr(self, name) is not None)
                for name in ("topic", "pinned", "featured", "tagIds")):
            raise ValueError("agentos_ordinary_change_required")
        if self.tagIds is not None and len(set(self.tagIds)) != len(self.tagIds):
            raise ValueError("agentos_tool_arguments_invalid")
        return self


class SectionClassification(ClosedArguments):
    kind: Literal["section-classification"]
    targetId: UUID
    category: Topic
    reason: Reason


class FeedbackUpdate(ClosedArguments):
    kind: Literal["feedback-update"]
    targetId: UUID
    category: Literal["problem", "suggestion"] | None = None
    module: Literal["account", "community", "chat", "work", "discovery", "other"] | None = None
    state: Literal["pending", "processing", "closed"] | None = None
    note: Annotated[str, Field(min_length=1, max_length=2000,
        description="Adds an internal note as a separate business change. Omit unless the user explicitly requests that note. Restoring category/module/state does not authorize adding a reason or note; omission keeps existing notes unchanged.")] | None = None

    @model_validator(mode="after")
    def changed_field(self):
        if not any(name in self.model_fields_set and (name == "category" or getattr(self, name) is not None)
                for name in ("category", "module", "state", "note")):
            raise ValueError("agentos_ordinary_change_required")
        return self


class FileScanRetry(ClosedArguments):
    kind: Literal["file-scan-retry"]
    targetKind: Literal["chat", "forum"]
    targetId: UUID
    reason: Reason


class FileCleanupApprove(ClosedArguments):
    kind: Literal["file-cleanup-approve"]
    planId: UUID


class AccountRestriction(ClosedArguments):
    kind: Literal["account-restriction"]
    targetId: UUID
    action: Literal["apply", "release"]
    reason: Annotated[str, Field(min_length=3, max_length=2000)]
    until: Annotated[str, Field(max_length=64,
        pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$")] | None = None

    @model_validator(mode="after")
    def explicit_deadline(self):
        if self.action == "apply":
            if self.until is None:
                raise ValueError("agentos_account_restriction_deadline_required")
            # Preserve the exact ISO string. Node owns the authoritative clock,
            # current account revision, deadline eligibility and actual effect.
            parsed = datetime.fromisoformat(self.until)
            if parsed.utcoffset() is None:
                raise ValueError("agentos_account_restriction_deadline_required")
        elif self.until is not None:
            raise ValueError("agentos_account_release_has_no_deadline")
        return self


class FileAccess(ClosedArguments):
    kind: Literal["file-access"]
    targetKind: Literal["chat", "forum"]
    targetId: UUID
    action: Literal["stop", "restore"]
    reason: Reason
    until: Annotated[int, Field(strict=True, gt=0, le=253402300799)] | None = None

    @model_validator(mode="after")
    def explicit_stop_deadline(self):
        if self.action == "stop" and self.until is None:
            raise ValueError("agentos_file_access_deadline_required")
        if self.action == "restore" and self.until is not None:
            raise ValueError("agentos_file_access_restore_has_no_deadline")
        return self


class CaseResolve(ClosedArguments):
    kind: Literal["case-resolve"]
    targetId: UUID
    resolution: Literal["accepted", "dismissed", "needs-review"]
    summary: Reason
    restrictionAction: Literal["keep", "release", "hide"] | None = None
    hideUntil: Deadline | None = None

    @model_validator(mode="after")
    def restriction_deadline(self):
        effect = self.restrictionAction or ("hide" if self.hideUntil is not None else "keep")
        if (effect == "hide") != (self.hideUntil is not None):
            raise ValueError("agentos_hide_deadline_required")
        return self


class MessagingState(ClosedArguments):
    kind: Literal["messaging-state"]
    targetId: UUID
    action: Literal["activate", "pause", "resume", "stop", "withdraw"]


class StrategyControl(ClosedArguments):
    kind: Literal["strategy-control"]
    action: Literal["pause", "resume"]
    reason: Reason


class StrategyContinue(ClosedArguments):
    kind: Literal["strategy-continue"]
    runId: UUID
    decision: Literal["proceed", "no-action"]


class OrdinaryParameterEdit(ClosedArguments):
    path: Annotated[list[Annotated[int, Field(ge=0, le=19)]], Field(min_length=1, max_length=6)]
    value: Annotated[int, Field(ge=0)]


class OrdinaryStrategyDraft(ClosedArguments):
    kind: Literal["ordinary-strategy-draft"]
    strategyId: UUID
    parameterEdits: Annotated[list[OrdinaryParameterEdit], Field(max_length=30)] = Field(default_factory=list)
    mode: Literal["code-automatic", "ai-autonomous", "ai-human-participation", "human-led"] | None = None
    enabled: bool | None = None

    @model_validator(mode="after")
    def changed_field(self):
        if not self.parameterEdits and self.mode is None and self.enabled is None:
            raise ValueError("agentos_ordinary_change_required")
        return self


class OrdinaryStrategyPublish(ClosedArguments):
    kind: Literal["ordinary-strategy-publish"]
    strategyId: UUID
    versionId: UUID


SearchReason = Annotated[str, Field(min_length=1, max_length=500)]


class JobCancel(ClosedArguments):
    kind: Literal["job-cancel"]
    queue: Literal["information-watch", "search-recovery", "content-publication", "account-notice", "retention-cleanup", "messaging-run", "messaging-delivery"]
    targetId: UUID
    reason: Reason


class JobRetry(JobCancel):
    kind: Literal["job-retry"]


class SearchRetry(ClosedArguments):
    kind: Literal["search-retry"]
    targetId: UUID
    reason: Reason


class SearchApply(ClosedArguments):
    kind: Literal["search-apply"]
    reason: SearchReason


class SearchRestore(ClosedArguments):
    kind: Literal["search-restore"]
    versionId: UUID
    reason: SearchReason


RecommendationThemeKey = Annotated[str, Field(max_length=80,
    pattern=r"^(?:category:(?:technology|arts|learning|life|galaxy|unclassified)|(?:tag|theme):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$")]


class RecommendationDirection(ClosedArguments):
    kind: Literal["recommendation-direction"]
    themeKey: RecommendationThemeKey
    direction: Literal["increase", "keep", "decrease"]
    reason: SearchReason


RuleKey = Literal["resource-budget", "community-quota", "forum-quota", "business-controls"]
RuleReason = Annotated[str, Field(min_length=1, max_length=500)]


class RulePublish(ClosedArguments):
    kind: Literal["rule-publish"]
    key: RuleKey
    reason: RuleReason


class RuleRestore(ClosedArguments):
    kind: Literal["rule-restore"]
    key: RuleKey
    versionId: UUID
    reason: RuleReason


from .conversation_message_drafts import MessageDraftCreate, MessageDraftSave
from .conversation_ai_management import AiWorkPromptSave, AiRoleCommand


_BusinessOperation = Union[JobCancel, JobRetry, SearchRetry, ContentVisibility, ContentCuration, PublicContentBatch, PrivateCaseMessage, MessageDraftCreate, MessageDraftSave,
    SectionClassification, SectionVisibility, ResourceVisibility, FeedbackUpdate,
    FileScanRetry, FileCleanupApprove, AccountRestriction, FileAccess, CaseResolve, MessagingState, StrategyControl, StrategyContinue,
    OrdinaryStrategyDraft, OrdinaryStrategyPublish,
    SearchApply, SearchRestore, RulePublish, RuleRestore, RecommendationDirection]
DutyPreparedOperation = Annotated[_BusinessOperation, Field(discriminator="kind")]
PreparedOperation = Annotated[Union[_BusinessOperation, AiWorkPromptSave, AiRoleCommand], Field(discriminator="kind")]


def _preparation_type(domain):
    """Role permission is authoritative; a domain name is only task context."""
    if domain is not None and (not isinstance(domain, str) or domain not in {
            "overview", "governance", "messaging", "discovery", "maintenance"}):
        raise ValueError("agentos_conversation_domain_invalid")
    return PreparedOperation


def _prepared_arguments(operation):
    """Omit only optional nonnullable Node fields; keep real clearing nulls."""
    value = operation.model_dump(mode="json", exclude_unset=True)
    optional_only = {
        "content-visibility": ("until",), "section-visibility": ("until",),
        "public-content-batch": ("until",),
        "resource-visibility": ("until",),
        "account-restriction": ("until",), "file-access": ("until",),
        "content-curation": ("pinned", "featured", "tagIds"),
        "feedback-update": ("module", "state", "note"),
        "case-resolve": ("restrictionAction", "hideUntil"),
        "ordinary-strategy-draft": ("mode", "enabled"),
    }
    for name in optional_only.get(value["kind"], ()):
        if value.get(name) is None:
            value.pop(name, None)
    if value["kind"] == "ai-role-command" and value["command"]["kind"] == "assignment-save":
        if value["command"].get("id") is None:
            value["command"].pop("id", None)
    # topic=null and category=null remain explicit business clearing intents.
    return value


# Exact affected Node read schemas. These are argument diagnostics only;
# Node still owns current permissions, defaults, page caps and period/basis.
_QUERY_FILTER_CONTRACTS = {
    ("recommendations", "overview"): {
        "allowedFilters": ["days", "query"], "allowedDays": [7, 30, 90],
        "defaultDays": 30,
    },
    ("search", "overview"): {
        "allowedFilters": ["days", "query", "issue", "after", "limit"],
        "allowedDays": [7, 30, 90], "defaultDays": 7,
    },
    ("content", "list"): {
        "allowedFilters": ["query", "targetId", "kind", "topic", "visibility",
            "pinned", "featured", "days", "after", "limit"],
        "allowedDays": [7, 28, "all"], "defaultDays": 7,
        "allowedKinds": ["post", "reply"], "maxReturnedItems": 20,
    },
}


_FEEDBACK_FILTER_KEYS = ["category", "module", "state", "days", "after", "limit"]
_FEEDBACK_FILTER_ENUMS = {
    "category": ["unclassified", "problem", "suggestion"],
    "module": ["account", "community", "chat", "work", "discovery", "other"],
    "state": ["pending", "processing", "closed"], "days": [7, 28, "all"],
}


# Exact F14 agentOsQueryArgumentsSchema routes that actually accept days.
# Requiring a choice here prevents provider-generated omissions from silently
# selecting different Node defaults. It never infers a window from prose.
_WINDOW_DAYS = {
    ("accounts", "summary"): [7, 28],
    ("content", "list"): [7, 28, "all"],
    ("feedback", "list"): [7, 28, "all"],
    ("recommendations", "overview"): [7, 30, 90],
    ("search", "overview"): [7, 30, 90],
    **{("analytics", view): list(range(1, 91))
        for view in ("overview", "business", "retention", "paths", "account")},
}

# Derived from F14 agentOsQueryArgumentsSchema.parse(...).filters.days;
# the exact defaults are checked against the actual Node schemas locally.
_WINDOW_DEFAULT_DAYS = {
    ("accounts", "summary"): 7, ("content", "list"): 7, ("feedback", "list"): 7,
    ("recommendations", "overview"): 30, ("search", "overview"): 7,
    ("analytics", "overview"): 7, ("analytics", "business"): 7,
    ("analytics", "retention"): 7, ("analytics", "paths"): 7, ("analytics", "account"): 7,
}


def _window_filter_feedback(module, view, values):
    allowed = _WINDOW_DAYS.get((module, view))
    if allowed is None:
        return None
    supplied = values.get("days")
    if "days" in values and type(supplied) in {int, str} and supplied in allowed:
        return None
    return {"state": "invalid-request", "reason": "agentos_query_window_required" if "days" not in values else "agentos_query_window_invalid",
        "module": module, "view": view, "requiredFilterKeys": ["days"], "allowedDays": list(allowed),
        "defaultDays": _WINDOW_DEFAULT_DAYS[(module, view)],
        "windowRequired": True, "dataRead": False, "effectExecuted": False,
        "nextStep": "supply-explicit-supported-days-matching-user-request",
        "explanation": "该视图必须显式传days。用户指定范围时逐项匹配；未指定时间时可显式采用本视图已发布defaultDays并在答复标注，无需追问。本工具不自动填入范围，也不推断用户意图。"}


def _analysis_constraints(result, *, module=None, view=None, filters=None):
    """Add fixed interpretation limits; preserve every original source value."""
    constraints = {"requestedDays": (filters or {}).get("days") if (module, view) in _WINDOW_DAYS else None,
        "rules": [
            "逐项核对原返回period/basis/coverage；请求days不证明每个指标都采用同一窗口，固定周留存、终身值和当前存量必须分别标明。",
            "统计0只表示该返回口径观察到0；不能据此排除采集故障、漏报、覆盖不足，或断言确实没有人使用。",
            "null/unknown不是0；有样本也可能unknown。原因只按来源明确reason/status说明，不猜没样本、未到期、未运行或未定型。",
            "比例须同时核分子、分母、时间和覆盖范围；高CTR或小样本不能推出用户意愿、兴趣或需求极高。",
            "feedback业务状态与共同task状态、model状态、人工决定状态分别说明；task/model completed不能证明feedback已关闭或业务处理完成。",
        ]}
    if module == "maintenance" and view == "logs":
        constraints["runtimeEventMeanings"] = {"runtime_event_rejected":
            "Node runtimeLogEvent对非事件名allowlist输入的安全归一化名称；该名称本身不表示反向代理、访问拦截或非法访问。具体HTTP/安全原因仅认来源明确字段。"}
    return {**result, "analysisConstraints": constraints}


def _feedback_filter_feedback(values):
    try:
        FeedbackMetadataFilters.model_validate(values)
        return None
    except ValidationError as error:
        # Only schema-owned paths and closed codes reach the model. Neither
        # supplied values nor an unknown user-provided key is echoed back.
        issues = []
        for issue in error.errors(include_input=False, include_context=False, include_url=False)[:5]:
            field = next((part for part in issue["loc"] if part in _FEEDBACK_FILTER_KEYS), None)
            issues.append({"path": "filters." + field if field else "filters",
                "code": "unsupported-filter" if issue["type"] == "extra_forbidden" else "invalid-filter-value"})
        return {"state": "invalid-request", "reason": "agentos_tool_arguments_invalid",
            "module": "feedback", "view": "list", "allowedFilterKeys": _FEEDBACK_FILTER_KEYS,
            "filterEnums": _FEEDBACK_FILTER_ENUMS, "defaults": {"days": 7, "limit": 30},
            "issues": issues, "scope": "feedback-metadata-only", "dataRead": False,
            "effectExecuted": False, "nextStep": "use-metadata-filters-or-read-selected-feedback"}


def _query_filter_feedback(module, view, values):
    window_feedback = _window_filter_feedback(module, view, values)
    if window_feedback is not None:
        return window_feedback
    if (module, view) == ("feedback", "list"):
        return _feedback_filter_feedback(values)
    contract = _QUERY_FILTER_CONTRACTS.get((module, view))
    if contract is None:
        return None
    invalid = (bool(set(values) - set(contract["allowedFilters"]))
        or "days" in values and values["days"] not in contract["allowedDays"]
        or "allowedKinds" in contract and "kind" in values
        and values["kind"] not in contract["allowedKinds"])
    if not invalid:
        return None
    return {"state": "invalid-request", "reason": "agentos_tool_arguments_invalid",
        "module": module, "view": view, **contract, "effectExecuted": False}


def _preparation_feedback(result):
    """Explain the original receipt without changing it or inferring effects."""
    card = result.get("card")
    state = result.get("state")
    card_id = card.get("cardId") if isinstance(card, dict) else None
    try:
        valid_card = isinstance(card_id, str) and str(UUID(card_id)) == card_id
    except (ValueError, TypeError, AttributeError):
        valid_card = False
    if state in {"unknown", "processing"}:
        feedback = {"state": state, "cardPrepared": None,
            "nextStep": "query-original-operation", "mayClaimPrepared": False,
            "report": "结果仍未知或处理中；只能核对原operation，不得重发prepare或声称已制卡、已执行。"}
    elif state == "prepared" and isinstance(card, dict) and card.get("state") == "prepared" and valid_card:
        feedback = {"state": "prepared", "cardPrepared": True,
            "nextStep": "review-returned-card", "mayClaimPrepared": True,
            "report": "原Node回执已返回prepared卡及card.cardId；可说明卡已准备，仍须人工确认，不能声称业务已执行。"}
    elif state == "prepared":
        feedback = {"state": "unknown", "cardPrepared": None,
            "nextStep": "query-original-operation", "mayClaimPrepared": False,
            "report": "prepared回执缺少可核对的card.state/card.cardId；不能声称制卡成功，只查原operation，不重发。"}
    elif result.get("code") == "operations_ai_prompt_no_change" or result.get("reason") == "operations_ai_prompt_no_change":
        feedback = {"state": "not-prepared", "cardPrepared": False,
            "nextStep": "explain-no-change-needed", "mayClaimPrepared": False,
            "report": "原回执明确无变化，无新卡且没有本次变更效果；说明无需变更，不得称准备成功或自动重试。"}
    elif state == "completed" or isinstance(card, dict) and card.get("state") == "completed":
        feedback = {"state": "original-receipt-required", "cardPrepared": False,
            "nextStep": "read-original-card-receipt", "mayClaimPrepared": False,
            "report": "这是原卡/原处理结果；只能依据原业务回执说明结果，不得把本次prepare当新卡或新执行。"}
    else:
        feedback = {"state": "not-prepared", "cardPrepared": False,
            "nextStep": "explain-original-refusal", "mayClaimPrepared": False,
            "report": "本次未返回已准备的真实卡；如实说明原拒绝或限制，不得声称制卡成功，也不猜被隐去的具体原因。"}
    return {**result, "preparationFeedback": {**feedback,
        "businessEffect": "not-proven-by-preparation", "automaticRetry": False}}


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
        event name outside the Node allowlist, not a proxy/security finding.
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

        Node checks current grants, frozen command, object/CAS and original
        human boundaries on every call. Existing human-review waits cannot be
        bypassed. A pending or unknown receipt is not successful execution.
        """
        return send(run_context, fc, "run-authorized-work", {"executionId": str(execution_id)})

    def read_ai_delegation(run_context: RunContext, fc: FunctionCall,
            ai_account_id: UUID | None = None) -> str:
        """Read current human-approved AI-only management scope or one prompt.

        With no ID, return only the actual delegation, target AI IDs and role
        metadata. For one genuine target ai_account_id, Node returns its role
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
        Node. It performs no business mutation and grants no AI authority.
        This human-confirmed route does not require a pre-existing execution
        or automatic grant. An empty list_authorized_work is not a refusal of
        this route; Node separately checks the current manager and AI's actual
        preparation permissions, source and CAS. For content-curation, omit
        topic to keep its override; explicitly include topic=null to clear only
        the operational category override and return to current originalTopic.
        Keep unrelated pinned/featured/tagIds absent unless the user asks for
        them. This supports clearing the override without a separate action.
        Supply the intended business change; Node determines CAS and stable
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
        16000 characters); Node freezes its current revision/prompt/delegation
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
        Node preserves policy/theme switches, other directions, controls and
        mappings. A saved direction does not mean ranking is active when the
        policy or theme is disabled. This route still requires a human card.
        In maintenance or overview, file-cleanup-approve only prepares review
        of an existing awaiting-approval plan returned by the query tools.
        Supply only its real planId. Node shows the complete frozen selection
        and derives the current revision. No approval or deletion occurs here;
        the manager must explicitly confirm the card before code can approve.
        In governance or overview, account-restriction prepares the existing
        community participation restriction, not a login suspension. Query the
        real account first. Apply requires the manager's explicit future ISO
        deadline including timezone and a reason; never invent a duration.
        Release has a reason and until=null in nullable tool formats. The native
        adapter omits only this null before Node. Both only prepare a human
        confirmation card and never enter automatic authorized work here.
        In maintenance or overview, file-access prepares an operational stop
        or restoration for a real chat/forum file returned by a query. Stop
        requires an explicit future epoch deadline and reason; restore has
        until=null in nullable tool formats; the native adapter omits this null.
        Node supplies both current file and access revisions.
        This is neither a revoke/delete nor a scan bypass or retention change.
        No business change occurs until the manager confirms the exact card.
        """
        return send(run_context, fc, "prepare-operation",
            _prepared_arguments(operation))

    query_operations.__doc__ += "\nExact module views: " + "; ".join(
        name + " " + "/".join(sorted(views)) for name, views in VIEWS.items()) + "."
    return [query_operations, read_operation_object, list_authorized_work,
        run_authorized_work, read_ai_delegation, prepare_operation]
