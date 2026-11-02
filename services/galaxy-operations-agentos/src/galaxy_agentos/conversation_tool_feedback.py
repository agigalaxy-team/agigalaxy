"""Deterministic argument diagnostics and interpretation of original Node receipts."""
from uuid import UUID
from datetime import datetime, timedelta, timezone
from pydantic import ValidationError

from .conversation_tool_contracts import FeedbackMetadataFilters

# Exact affected Node read schemas. These are argument diagnostics only;
# Node still owns current permissions, defaults, page caps and period/basis.
_QUERY_FILTER_CONTRACTS = {
    ("messaging", "notices"): {"allowedFilters": ["after", "limit"]},
    ("recommendations", "policy"): {"allowedFilters": []},
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
# The business service supplies its published default when days is omitted.
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
    if "days" not in values or type(supplied) in {int, str} and supplied in allowed:
        return None
    return {"state": "invalid-request", "reason": "agentos_query_window_invalid",
        "module": module, "view": view, "requiredFilterKeys": ["days"], "allowedDays": list(allowed),
        "defaultDays": _WINDOW_DEFAULT_DAYS[(module, view)],
        "windowRequired": False, "dataRead": False, "effectExecuted": False,
        "nextStep": "supply-explicit-supported-days-matching-user-request",
        "explanation": "days须使用该视图支持的值；省略时由业务服务采用默认值。"}


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
    elif state == "prepared" and isinstance(card, dict) and valid_card and isinstance(card.get("presentation"), dict) and card["presentation"].get("reviewable") is not True:
        feedback = {"state":"not-prepared", "cardPrepared":False, "mayClaimPrepared":False,
            "nextStep":"explain-card-review-limit", "report":"卡的业务内容尚不可完整审阅，不能称已生成可执行方案；根据原卡的说明给出具体限制。"}
    elif state == "prepared" and isinstance(card, dict) and card.get("state") == "prepared" and valid_card:
        feedback = {"state": "prepared", "cardPrepared": True,
            "nextStep": "review-returned-card", "mayClaimPrepared": True,
            "report": "原业务服务已返回prepared卡及card.cardId；可说明卡已准备，仍须人工确认，不能声称业务已执行。"}
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


def _summary_feedback(result):
    """Interpret independent current capability facts, never confer authority."""
    if not isinstance(result, dict) or result.get("state") in ("denied", "unavailable", "unknown") or result.get("error") is not None or result.get("availability") in ("unavailable", "denied"):
        return result
    capabilities = result.get("managementCapabilities")
    if not isinstance(capabilities, dict):
        return result
    groups = (("AI专用角色", "role", (("读取", "read"), ("创建", "create"), ("修改", "update"), ("分配", "assign"), ("撤回", "revoke"))),
        ("岗位工作提示词", "prompt", (("读取", "read"), ("修改", "update"))),
        ("日常策略", "ordinaryStrategy", (("编辑", "configure"), ("发布", "publish"))))
    facts = {}
    for label, key, actions in groups:
        group = capabilities.get(key)
        group = group if isinstance(group, dict) else {}
        facts[label] = {}
        for action, code in actions:
            fact = group.get(code)
            fact = fact if isinstance(fact, dict) else {}
            support = {"connected": "功能已接通", "not-connected": "功能尚未接通", "human-only": "仅由人工办理"}.get(fact.get("systemSupport") if isinstance(fact.get("systemSupport"), str) else None, "功能接通状态未核实")
            permission = "权限已分配" if fact.get("permissionAllowed") is True else "权限未分配" if fact.get("permissionAllowed") is False else "权限未核实"
            delegated = "已委派" if fact.get("delegated") is True else "尚未委派" if fact.get("delegated") is False else "委派未核实"
            available = "当前可办理" if fact.get("available") is True else "当前不可办理" if fact.get("available") is False else "当前可用性未核实"
            facts[label][action] = "；".join((support, permission, delegated, available))
    feedback = {"capabilityFacts": facts,
        "interpretation": "分别依据本轮功能接通、权限和委派事实回答。未分配权限或尚未委派不表示功能未开发或未接通；已明确不可读取的目录无需再次尝试。采用业务名称，不复述内部字段和错误码，不自行补取数时间。"}
    checked = result.get("checkedAt")
    if type(checked) in (int, float):
        try:
            feedback["observedAt"] = datetime.fromtimestamp(checked, timezone(timedelta(hours=8))).isoformat()
        except (ValueError, OverflowError, OSError):
            pass
    # This is the model's business view, not the server/API authorization
    # contract. Do not offer two competing representations of the same facts.
    # The input and durable Go receipt remain unchanged.
    projected = {key: value for key, value in result.items()
        if key not in {"managementCapabilities", "checkedAt", "readExpiresAt"}}
    feedback["sourceAiAccountId"] = capabilities.get("sourceAiAccountId")
    feedback["targetAiAccounts"] = capabilities.get("targetAiAccounts", [])
    for label, key in (("模型配置", "modelConfiguration"), ("授权边界", "authorityBoundaries")):
        value = capabilities.get(key)
        if isinstance(value, dict) and value.get("systemSupport") == "human-only":
            facts[label] = "仅由人工办理"
    return {**projected, "summaryFeedback": feedback}
