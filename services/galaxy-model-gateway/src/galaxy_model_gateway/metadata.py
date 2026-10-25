import re
import httpx
from litellm.integrations.custom_logger import CustomLogger
from .output import emit
from .policy import ALIAS, CONFIG_VERSION, SCENARIOS

_usage_store = None


def configure_usage(store):
    global _usage_store
    _usage_store = store


def nonnegative_int(value):
    return value if type(value) is int and value >= 0 else None


def safe_failure(exception):
    """Use typed exception metadata, never its message/body/request/headers."""
    names = {kind.__name__ for kind in type(exception).__mro__}
    def attribute(name):
        try:
            return getattr(exception, name, None)
        except Exception:
            return None
    reported = attribute("status_code")
    reported = reported if type(reported) is int and 400 <= reported <= 599 else None
    response = attribute("response")
    actual = response.status_code if isinstance(response, httpx.Response) else None
    actual = actual if type(actual) is int and 400 <= actual <= 599 else None
    status = actual if actual is not None else reported
    if names & {"ContextWindowExceededError", "ContextWindowExceededException"}:
        category = "context-limit"
    elif names & {"RateLimitError", "ModelRateLimitError"} or status in {429, 529}:
        category = "rate-limit"
    elif names & {"Timeout", "TimeoutError", "APITimeoutError", "ReadTimeout", "ConnectTimeout"} or status in {408, 504}:
        category = "timeout"
    elif names & {"APIConnectionError", "ConnectionError", "ConnectError"}:
        category = "connection"
    elif status is not None and status >= 500:
        category = "service-unavailable"
    elif status is not None:
        category = "request-rejected"
    else:
        category = "unknown"
    return {"stage": "model-request", "category": category,
        "reportedStatus": reported, "httpStatus": actual}


def safe_record(kwargs, response, start_time, end_time, *, failed=False):
    params = kwargs.get("litellm_params") or {}
    metadata = params.get("metadata") or params.get("litellm_metadata") or kwargs.get("litellm_metadata") or {}
    alias, scene = metadata.get("galaxy_model_alias"), metadata.get("galaxy_scenario")
    version, call_id = metadata.get("galaxy_config_version"), metadata.get("galaxy_call_id")
    if (not isinstance(alias, str) or not ALIAS.fullmatch(alias) or scene not in SCENARIOS
            or not isinstance(version, str) or not CONFIG_VERSION.fullmatch(version)
            or not isinstance(call_id, str) or not re.fullmatch(r"[a-f0-9-]{36}", call_id)):
        return None
    usage = response.get("usage") if isinstance(response, dict) else getattr(response, "usage", None)
    def field(obj, key):
        return obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)
    def token(*keys):
        for key in keys:
            value = nonnegative_int(field(usage, key))
            if value is not None: return value
        return None
    input_tokens, output_tokens, total_tokens = token("input_tokens", "prompt_tokens"), token("output_tokens", "completion_tokens"), token("total_tokens")
    # Some compatible-provider adapters normalize missing usage to all-zero.
    # Every Galaxy call carries instructions/context, so preserve this as
    # unreported rather than manufacture a zero-token inference receipt.
    if input_tokens == output_tokens == total_tokens == 0:
        input_tokens = output_tokens = total_tokens = None
    input_details = field(usage, "input_tokens_details") or field(usage, "prompt_tokens_details")
    output_details = field(usage, "output_tokens_details") or field(usage, "completion_tokens_details")
    duration = None
    if start_time is not None and end_time is not None:
        try: duration = max(0, round((end_time - start_time).total_seconds() * 1000))
        except (TypeError, AttributeError): pass
    result = {"event": "model-call", "callId": call_id, "scenario": scene, "modelAlias": alias,
        "configVersion": version, "state": "failed" if failed else "completed",
        "code": "model_gateway_request_failed" if failed else None, "durationMs": duration,
        "inputTokens": input_tokens, "outputTokens": output_tokens, "totalTokens": total_tokens,
        "cachedInputTokens": nonnegative_int(field(input_details, "cached_tokens")),
        "reasoningTokens": nonnegative_int(field(output_details, "reasoning_tokens"))}
    if failed:
        result["failure"] = safe_failure(kwargs.get("exception"))
    return result


class MetadataLogger(CustomLogger):
    def record(self, row):
        if not row: return
        if _usage_store is not None:
            try: _usage_store.finish(row)
            except Exception: emit({"event": "model-usage-error", "code": "model_gateway_usage_write_failed"})
        emit(row)

    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        row = safe_record(kwargs, response_obj, start_time, end_time)
        self.record(row)
    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        self.log_success_event(kwargs, response_obj, start_time, end_time)
    def log_failure_event(self, kwargs, response_obj, start_time, end_time):
        row = safe_record(kwargs, None, start_time, end_time, failed=True)
        self.record(row)
    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        self.log_failure_event(kwargs, response_obj, start_time, end_time)


logger = MetadataLogger()
