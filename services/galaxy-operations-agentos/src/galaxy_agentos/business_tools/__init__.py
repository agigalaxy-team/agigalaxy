"""On-demand business preparation tool catalog; service authority remains unchanged."""
from typing import Annotated, Literal, Union, get_args

from agno.run.base import RunContext
from agno.tools.function import FunctionCall
from pydantic import Field

from .. import conversation_tool_contracts as c
from ..conversation_turn_state import turn_state

# Each group is a small related action family, independent of UI page/domain.
_GROUPS = {
    "content": ("内容治理", (c.ContentVisibility, c.ContentCuration, c.PublicContentBatch, c.PrivateCaseMessage, c.SectionClassification, c.SectionVisibility, c.ResourceVisibility, c.ContentTagCreate, c.ContentTagUpdate)),
    "feedback_accounts": ("反馈与账户", (c.FeedbackUpdate, c.AccountRestriction, c.CaseResolve)),
    "messaging": ("站内消息与通知", (c.MessageDraftCreate, c.MessageDraftSave, c.NoticeDraftCreate, c.NoticeDraftSave, c.NoticeState, c.MessagingState)),
    "maintenance": ("文件与维护任务", (c.CleanupPlanCreate, c.CleanupPlanCancel, c.FileScanRetry, c.FileCleanupApprove, c.FileAccess, c.JobCancel, c.JobRetry)),
    "search": ("搜索", (c.SearchRetry, c.SearchDraftSave, c.SearchApply, c.SearchRestore)),
    "recommendations": ("推荐", (c.RecommendationDirection, c.RecommendationPolicySave, c.RecommendationThemeUpdate)),
    "community_parameters": ("社区宏观调控", (c.CommunityParameterAdjustment,)),
    "strategy": ("策略与规则", (c.StrategyControl, c.StrategyContinue, c.OrdinaryStrategyDraft, c.OrdinaryStrategyPublish, c.StrategyDraft, c.StrategyRehearsal, c.StrategyPublish, c.RulePublish, c.RuleRestore)),
    "ai_management": ("AI专用角色", (c.AiRoleCommand,)),
}


_GUIDANCE = {
    "content": "For content-curation, omit topic to retain its override; topic=null clears it. Leave unrelated pinned, featured and tags absent. Do not invent an exact deadline.",
    "feedback_accounts": "A feedback note is a separate mutation: omit it unless requested. Account restrictions concern community participation, not login; use the real account and an explicit deadline when required.",
    "messaging": "Use the intended audience and content; preparation does not deliver a message or publish a notice.",
    "maintenance": "File cleanup approval reviews an existing actual awaiting-approval plan. File access stops or restores access; it does not delete a file. Use actual targets and explicit deadlines.",
    "search": "Read the current complete settings and fixed constraints before a draft; explicitly select an existing draft before overwriting. A draft is not an applied configuration.",
    "recommendations": "Use actual theme identifiers and preserve unrelated settings. A saved direction does not imply ranking is active when the policy or theme is disabled.",
    "community_parameters": "Read current community parameters before proposing changes. Use one growth rule or one global content-score or recommendation configuration per card. Propose changed numeric fields and a business reason. These are uniform rules; do not score individual accounts, posts or replies.",
    "strategy": "Use actual drafts, versions and original rehearsal evidence. Historical validity does not establish current publication eligibility.",
    "ai_management": "Read current_summary and read_ai_delegation for actual allowed targets and current role data. These actions cannot expand delegation or edit model settings.",
}


_READ_GUIDANCE = {
    "content": "content/list supports days 7/28/all (default 7), kind post/reply, visibility and limit (server cap 20). A mixed page is not separate samples; pagination and scanLimited describe coverage. Selected public-report case material is service-authorized and may be truncated; it is not itself a violation finding or profile source.",
    "feedback_accounts": "feedback/list is metadata only: category, module, state, days 7/28/all (default 7), after and limit (default 30). Read a real selected feedback ID for its text. accounts/summary supports 7/28 days. Registered-users is the website registration directory, including identities without business profiles; use its returned as-of/count basis. Account summary may contain lifetime and fixed weekly metrics with different bases.",
    "messaging": "messaging recipients requires a real runId and optionally channel inapp/email. A recipient read does not deliver messages.",
    "maintenance": "maintenance/overview contains observed runtime and health facts. File cleanup views only read candidates and progress. runtime_event_rejected normalizes an event outside the allowed names and alone is not a security or proxy finding.",
    "search": "search/overview supports days 7/30/90 and defaults to 7. Search history returns version IDs; read the actual version for complete restore settings.",
    "recommendations": "recommendations/overview supports days 7/30/90 and defaults to 30. Its period is an event window; supply is current public stock, not new posts.",
    "community_parameters": "Use read_community_parameters for the actual version and available aggregate evidence. Omit scope to list growth rule keys, then use one rule key or global for the other areas. The recommendations/overview query adds category and demand evidence when authorized.",
    "strategy": "strategy-version returns same-owner historical rehearsals with after/limit pagination. Historical validity does not establish current publication eligibility.",
    "ai_management": "system-settings is safe configuration and adoption metadata, not a service-health check; general is the current published website configuration, not an admin draft.",
    "analytics": "analytics uses relative days 1..90 (default 7), not calendar day/from/to. overview/business accept days; paths/retention accept scope=accounts and optional accountId, which requires that scope; account requires accountId. Returned period, basis and coverage can differ for fixed weekly, lifetime and current-stock metrics; null/unknown is not zero.",
}


def preparation_tool_catalog():
    catalog = {domain: {"label": label, "tools": ["prepare_" + domain + "_operation"],
                        "kinds": [get_args(model.model_fields["kind"].annotation)[0] for model in models]}
               for domain, (label, models) in _GROUPS.items()}
    catalog["analytics"] = {"label": "分析", "tools": [], "kinds": []}
    return catalog


def is_business_preparation_tool(name):
    return name == "prepare_operation" or any(name in entry["tools"] for entry in preparation_tool_catalog().values())


def is_preparation_tool(name):
    return name == "request_task" or is_business_preparation_tool(name)


def load_business_tools(run_context: RunContext, fc: FunctionCall, domains: list[Literal["content", "feedback_accounts", "messaging", "maintenance", "search", "recommendations", "community_parameters", "strategy", "ai_management", "analytics"]]) -> str:
    """Load preparation tool definitions for the named business domains for this run.

    Available domains: content, feedback_accounts, messaging, maintenance,
    search, recommendations, community_parameters, strategy, ai_management, analytics. Loading definitions
    does not authorize or execute an action; the business service checks it.
    """
    import json
    catalog = preparation_tool_catalog()
    state = turn_state(run_context)
    loaded = state.setdefault("loadedBusinessDomains", [])
    for domain in domains:
        if domain not in loaded:
            loaded.append(domain)
    return json.dumps({"loadedDomains": loaded, "tools": [name for domain in loaded for name in catalog[domain]["tools"]],
                       "readGuidance": {domain: _READ_GUIDANCE[domain] for domain in domains}}, ensure_ascii=False)


def preparation_tools(gateway, *, domains=None):
    """Build registered Agno callables; domains=None selects the full catalog."""
    # Reuse the existing adapter and its original public-reference/run binding.
    from ..conversation_tools import _conversation_tools
    prepare = _conversation_tools(gateway, include_legacy=True)[-1]
    selected = list(_GROUPS) if domains is None else list(domains)
    unknown = set(selected) - set(preparation_tool_catalog())
    if unknown:
        raise ValueError("unknown business preparation domain: " + ", ".join(sorted(unknown)))
    tools = []
    for domain in dict.fromkeys(selected):
        if domain not in _GROUPS:
            continue
        label, models = _GROUPS[domain]
        operation_type = models[0] if len(models) == 1 else Annotated[Union[models], Field(discriminator="kind")]
        def call(run_context, fc, operation):
            return prepare(run_context, fc, operation)
        call.__name__ = "prepare_" + domain + "_operation"
        call.__doc__ = (f"Prepare one {label} action for human review. Use real object identifiers and preserve unspecified fields. "
                        "The original business service checks permissions, source and versions. "
                        "Preparation does not execute the change; report the original card and receipt accurately. "
                        "An unknown result must be resolved through the original operation, never by resending. " + _GUIDANCE[domain])
        call.__annotations__ = {"run_context": RunContext, "fc": FunctionCall, "operation": operation_type, "return": str}
        tools.append(call)
    return tools
