"""Public native run projection shared by execution and conversation readers."""
import math

from .model_failover import failover_view
from .conversation_failures import failure_view
from .tool_reliability import PREPARED_CARD_IDS


def _completed_conversation_content(run, status, fallback):
    if str(status).upper() != "COMPLETED" or getattr(run, "agent_id", None) not in {
            "galaxy-conversation-overview", "galaxy-conversation-governance",
            "galaxy-conversation-messaging", "galaxy-conversation-discovery",
            "galaxy-conversation-maintenance"}:
        return fallback
    metadata = getattr(run, "metadata", None) or {}
    if isinstance(metadata.get(PREPARED_CARD_IDS), list) and metadata[PREPARED_CARD_IDS]:
        return fallback
    messages = getattr(run, "messages", None)
    if not isinstance(messages, (list, tuple)):
        return fallback
    for message in reversed(messages):
        role = message.get("role") if isinstance(message, dict) else getattr(message, "role", None)
        calls = message.get("tool_calls") if isinstance(message, dict) else getattr(message, "tool_calls", None)
        if role == "assistant" and not calls:
            content = message.get("content") if isinstance(message, dict) else getattr(message, "content", None)
            return content if isinstance(content, str) else fallback
    return fallback


def run_view(run):
    status = getattr(run.status, "value", run.status)
    content = run.content if isinstance(run.content, str) and str(status).upper() != "ERROR" else None
    content = _completed_conversation_content(run, status, content)
    events = []
    completed_at = None
    error_code = "operations_agentos_run_failed" if str(status).upper() == "ERROR" else None
    failure = failure_view(run.content) if str(status).upper() in {"ERROR", "REGENERATED"} and getattr(run, "agent_id", None) in {
        "galaxy-conversation-overview", "galaxy-conversation-governance",
        "galaxy-conversation-messaging", "galaxy-conversation-discovery",
        "galaxy-conversation-maintenance"} else None
    if failure:
        error_code = "operations_agentos_model_request_failed"
        if str(status).upper() == "REGENERATED":
            content = None
    for event in getattr(run, "events", None) or []:
        event_name = getattr(event, "event", None)
        error_type = getattr(event, "error_type", None)
        timestamp = getattr(event, "created_at", None)
        if (str(status).upper() == "COMPLETED" and event_name == "RunCompleted"
                and getattr(event, "run_id", None) == run.run_id
                and type(timestamp) in {int, float} and 0 <= timestamp <= 9007199254740991
                and math.isfinite(timestamp)):
            completed_at = timestamp
        if error_code and error_type == "AuthorityUnavailable":
            error_code = "operations_authorization_unavailable"
        elif error_code and error_type == "AuthorityDenied":
            error_code = "operations_agentos_authority_changed"
        if event_name and "Reasoning" not in event_name:
            events.append({"event": event_name, "eventIndex": getattr(event, "event_index", None),
                "createdAt": getattr(event, "created_at", None)})
    if error_code != "operations_agentos_model_request_failed":
        failure = None
    raw_metrics = getattr(run, "metrics", None)
    def metric(key):
        return raw_metrics.get(key) if isinstance(raw_metrics, dict) else getattr(raw_metrics, key, None)
    def tokens(key):
        value = metric(key)
        return value if type(value) is int and value >= 0 else None
    # Native counts start at zero even with no reported usage. Only expose
    # token fields when per-model metrics and a positive count were recorded.
    reported = bool(metric("details")) and any((tokens(key) or 0) > 0
        for key in ("input_tokens", "output_tokens", "total_tokens"))
    duration = metric("duration")
    duration_ms = duration * 1000 if type(duration) in {int, float} and math.isfinite(duration) and duration >= 0 else None
    calls = (getattr(run, "metadata", None) or {}).get("modelCalls")
    if type(calls) is not int or calls < 0:
        calls = None
    return {"runId": run.run_id, "status": status, "content": content,
        "operationId": (getattr(run, "metadata", None) or {}).get("operationId"),
        "regeneratedFrom": getattr(run, "regenerated_from", None),
        "retryOfOperationId": (getattr(run, "metadata", None) or {}).get("retryOfOperationId"),
        "userInput": getattr(getattr(run, "input", None), "input_content", None) if isinstance(getattr(getattr(run, "input", None), "input_content", None), str) else None,
        "createdAt": getattr(run, "created_at", None), "completedAt": completed_at, "events": events,
        "metrics": {"inputTokens": tokens("input_tokens") if reported else None,
            "outputTokens": tokens("output_tokens") if reported else None,
            "totalTokens": tokens("total_tokens") if reported else None, "durationMs": duration_ms},
        "usage": {"calls": calls,
            "inputTokens": tokens("input_tokens") if reported else None,
            "outputTokens": tokens("output_tokens") if reported else None,
            "totalTokens": tokens("total_tokens") if reported else None, "durationMs": duration_ms},
        "errorCode": error_code, "failure": failure,
        "modelFallbacks": failover_view(getattr(run, "metadata", None)),
        "awaitingHuman": status == "PAUSED" or str(status).lower() == "paused"}
