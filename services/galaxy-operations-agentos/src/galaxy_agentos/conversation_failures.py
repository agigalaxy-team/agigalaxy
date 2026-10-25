"""Preserve closed conversation model failure metadata in the existing run error contract.

Agno durable errors retain ``str(exception)``. This adapter replaces only a
conversation model provider exception with a bounded internal code; no provider
message, response body, model arguments or credentials enter that code.
"""
from functools import wraps
import re

from agno.exceptions import ModelProviderError, ModelRateLimitError, ContextWindowExceededError


_CODE = re.compile(r"galaxy_conversation_model_failure:(rate-limit|timeout|connection|context-limit|service-unavailable|request-rejected|unknown):(none|[45][0-9]{2})")


def model_failure(exception):
    names = {kind.__name__ for kind in type(exception).__mro__}
    status = getattr(exception, "status_code", None)
    status = status if type(status) is int and 400 <= status <= 599 else None
    if isinstance(exception, ContextWindowExceededError):
        category = "context-limit"
    elif isinstance(exception, ModelRateLimitError) or status in {429, 529}:
        category = "rate-limit"
    elif names & {"APITimeoutError", "ReadTimeout", "ConnectTimeout", "TimeoutError"} or status in {408, 504}:
        category = "timeout"
    elif names & {"APIConnectionError", "ConnectError", "ConnectionError"}:
        category = "connection"
    elif status is not None and status >= 500:
        category = "service-unavailable"
    elif status is not None:
        category = "request-rejected"
    else:
        category = "unknown"
    return {"stage": "model-request", "category": category, "reportedStatus": status}


def failure_view(content):
    match = _CODE.fullmatch(content) if isinstance(content, str) else None
    return {"stage": "model-request", "category": match[1],
        "reportedStatus": None if match[2] == "none" else int(match[2])} if match else None


def _closed_exception(exception):
    # Preserve Agno's own specific retry/context-limit classification before
    # replacing its message. The exception prose is inspected only in memory.
    exception = ModelProviderError.classify(exception)
    failure = model_failure(exception)
    code = "galaxy_conversation_model_failure:" + failure["category"] + ":" + (
        str(failure["reportedStatus"]) if failure["reportedStatus"] is not None else "none")
    kind = type(exception) if type(exception) in {ModelRateLimitError, ContextWindowExceededError} else ModelProviderError
    return kind(code, status_code=exception.status_code,
        model_name=exception.model_name, model_id=exception.model_id)


def with_conversation_failures(model):
    """Retain the current model and authority wrappers; add no calls or retries."""
    invoke, ainvoke = model.invoke, model.ainvoke
    invoke_stream, ainvoke_stream = model.invoke_stream, model.ainvoke_stream

    @wraps(invoke)
    def checked(*args, **kwargs):
        try:
            return invoke(*args, **kwargs)
        except ModelProviderError as error:
            raise _closed_exception(error) from None

    @wraps(ainvoke)
    async def achecked(*args, **kwargs):
        try:
            return await ainvoke(*args, **kwargs)
        except ModelProviderError as error:
            raise _closed_exception(error) from None

    @wraps(invoke_stream)
    def stream(*args, **kwargs):
        try:
            yield from invoke_stream(*args, **kwargs)
        except ModelProviderError as error:
            raise _closed_exception(error) from None

    @wraps(ainvoke_stream)
    async def astream(*args, **kwargs):
        try:
            async for chunk in ainvoke_stream(*args, **kwargs):
                yield chunk
        except ModelProviderError as error:
            raise _closed_exception(error) from None

    model.invoke, model.ainvoke = checked, achecked
    model.invoke_stream, model.ainvoke_stream = stream, astream
    return model
