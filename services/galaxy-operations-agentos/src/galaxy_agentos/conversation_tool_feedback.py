"""Deterministic argument diagnostics and interpretation of original Node receipts."""
from uuid import UUID
from pydantic import ValidationError

from .conversation_tool_contracts import FeedbackMetadataFilters

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
