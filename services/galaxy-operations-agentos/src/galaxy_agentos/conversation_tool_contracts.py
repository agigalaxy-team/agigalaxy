"""Closed conversation query and preparation contracts; no transport or effects."""
from datetime import datetime
from typing import Annotated, Literal, Union
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

Topic = Literal["technology", "arts", "learning", "life", "galaxy", "unclassified"]
Reason = Annotated[str, Field(min_length=3, max_length=1600)]
Deadline = Annotated[int, Field(strict=True, gt=0)]


class ClosedArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


Module = Literal["accounts", "content", "cases", "chat-reports", "feedback", "files",
    "resources", "analytics", "recommendations", "search", "messaging", "strategies",
    "rules", "maintenance", "audit", "runs", "jobs", "permissions", "registered-users", "system-settings"]
View = Literal["list", "summary", "sections", "tags", "projects", "methods", "overview",
    "business", "retention", "paths", "account", "history", "plans", "runs", "recipients", "notices", "policy",
    "versions", "records", "backups", "logs", "roles", "personnel", "automation",
    "cleanup-candidates", "cleanup-plans", "general", "mail", "service-connections", "advanced"]
ReadKind = Literal["account", "account-summary", "post", "reply", "section", "case",
    "chat-report", "feedback", "chat-file", "forum-file", "project", "method",
    "message-plan", "message-run", "notice", "recommendation-theme", "content-tag", "rule", "strategy-run", "strategy-version", "search-version", "ai-run", "backup-point",
    "restore-plan", "role", "file-cleanup-plan", "file-cleanup-operation", "registered-user"]
VIEWS = {"accounts": {"list", "summary"}, "content": {"list", "sections", "tags"},
    "cases": {"list"}, "chat-reports": {"list"}, "feedback": {"list"},
    "files": {"list", "summary", "cleanup-candidates", "cleanup-plans"}, "resources": {"projects", "methods"},
    "analytics": {"overview", "business", "retention", "paths", "account"},
    "recommendations": {"overview", "history", "policy"}, "search": {"overview", "history"},
    "messaging": {"notices", "plans", "runs", "recipients", "history"},
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


class StrategyDraft(ClosedArguments):
    kind: Literal["strategy-draft"]
    configuration: dict
    reason: Reason
    expectedDraftId: UUID | None = None


class StrategyRehearsal(ClosedArguments):
    kind: Literal["strategy-rehearsal"]
    versionId: UUID
    executionIds: Annotated[list[UUID], Field(max_length=200)]


class StrategyPublish(ClosedArguments):
    kind: Literal["strategy-publish"]
    versionId: UUID
    rehearsalId: UUID
    reason: Reason


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


class SearchDraftSave(ClosedArguments):
    kind: Literal["search-draft-save"]
    settings: dict
    reason: SearchReason
    expectedDraftId: UUID | None = None


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


class ContentTagCreate(ClosedArguments):
    kind: Literal["content-tag-create"]
    name: Annotated[str, Field(min_length=1, max_length=40)]

    @model_validator(mode="after")
    def no_control_characters(self):
        if any(__import__("unicodedata").category(c) == "Cc" for c in self.name):
            raise ValueError("agentos_tag_name_invalid")
        return self


class ContentTagUpdate(ClosedArguments):
    kind: Literal["content-tag-update"]
    targetId: UUID
    expectedVersion: Annotated[int, Field(strict=True, ge=0, le=2147483646)]
    name: Annotated[str, Field(min_length=1, max_length=40)] | None = None
    enabled: bool | None = None

    @model_validator(mode="after")
    def changed_field(self):
        if self.name is None and self.enabled is None:
            raise ValueError("agentos_tag_change_required")
        if self.name is not None and any(__import__("unicodedata").category(c) == "Cc" for c in self.name):
            raise ValueError("agentos_tag_name_invalid")
        return self


class RecommendationControls(ClosedArguments):
    avoidRepetition: bool
    avoidConcentration: bool


class RecommendationPolicySave(ClosedArguments):
    kind: Literal["recommendation-policy-save"]
    expectedVersion: Annotated[int, Field(strict=True, ge=0, le=2147483646)]
    enabled: bool
    controls: RecommendationControls
    reason: SearchReason


class RecommendationMapping(ClosedArguments):
    categories: Annotated[list[Topic], Field(max_length=6)]
    tagIds: Annotated[list[UUID], Field(max_length=32)]
    queryTerms: Annotated[list[Annotated[str, Field(min_length=1, max_length=80)]], Field(max_length=24)]


class RecommendationThemeUpdate(ClosedArguments):
    kind: Literal["recommendation-theme-update"]
    themeId: UUID
    expectedVersion: Annotated[int, Field(strict=True, ge=1, le=2147483646)]
    label: Annotated[str, Field(min_length=1, max_length=80)]
    enabled: bool
    mapping: RecommendationMapping
    reason: SearchReason


from .conversation_message_drafts import MessageDraftCreate, MessageDraftSave, NoticeDraftCreate, NoticeDraftSave, NoticeState
from .conversation_ai_management import AiWorkPromptSave, AiRoleCommand


_BusinessOperation = Union[ContentTagCreate, ContentTagUpdate, JobCancel, JobRetry, SearchRetry, ContentVisibility, ContentCuration, PublicContentBatch, PrivateCaseMessage, MessageDraftCreate, MessageDraftSave, NoticeDraftCreate, NoticeDraftSave, NoticeState,
    SectionClassification, SectionVisibility, ResourceVisibility, FeedbackUpdate,
    FileScanRetry, FileCleanupApprove, AccountRestriction, FileAccess, CaseResolve, MessagingState, StrategyControl, StrategyContinue,
    OrdinaryStrategyDraft, OrdinaryStrategyPublish, StrategyDraft, StrategyRehearsal, StrategyPublish,
    SearchDraftSave, SearchApply, SearchRestore, RulePublish, RuleRestore, RecommendationDirection, RecommendationPolicySave, RecommendationThemeUpdate]
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
        "strategy-draft": ("expectedDraftId",),
        "search-draft-save": ("expectedDraftId",),
        "content-tag-update": ("name", "enabled"),
    }
    for name in optional_only.get(value["kind"], ()):
        if value.get(name) is None:
            value.pop(name, None)
    if value["kind"] == "ai-role-command" and value["command"]["kind"] == "assignment-save":
        if value["command"].get("id") is None:
            value["command"].pop("id", None)
    # topic=null and category=null remain explicit business clearing intents.
    return value
