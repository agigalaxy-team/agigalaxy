"""Bounded, content-free diagnostics of messages passed to the conversation model."""
from functools import wraps
import hashlib
import json
import re

from .model_usage import _RUN

_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
_ROLES = {"system", "developer", "user", "assistant", "tool"}


def _record(args, kwargs):
    run = _RUN.get()
    messages = kwargs.get("messages", args[0] if args else None)
    if run is None or not isinstance(messages, list):
        return
    input_content = getattr(getattr(run, "input", None), "input_content", None)
    input_hash = hashlib.sha256(input_content.encode("utf-8")).hexdigest() if isinstance(input_content, str) else None
    current = [m for m in messages if getattr(m, "role", None) == "user" and not getattr(m, "from_history", False)]
    last_user = next((m for m in reversed(messages) if getattr(m, "role", None) == "user"), None)
    run_id = getattr(run, "run_id", None)
    operation_id = (getattr(run, "metadata", None) or {}).get("operationId")
    event = {"event": "conversation-turn-context", "runId": run_id if isinstance(run_id, str) and _ID.fullmatch(run_id) else None,
        "operationId": operation_id if isinstance(operation_id, str) and _ID.fullmatch(operation_id) else None,
        "currentInputSha256": input_hash, "currentUserCount": len(current),
        "currentInputMatchesLastUser": isinstance(input_content, str) and last_user is not None and getattr(last_user, "content", None) == input_content,
        "historyCount": sum(bool(getattr(m, "from_history", False)) for m in messages),
        "currentToolCount": sum(getattr(m, "role", None) == "tool" and not getattr(m, "from_history", False) for m in messages),
        "roles": [{"role": getattr(m, "role", None) if getattr(m, "role", None) in _ROLES else "other",
            "fromHistory": bool(getattr(m, "from_history", False))} for m in messages[:128]],
        "rolesTruncated": len(messages) > 128}
    print(json.dumps(event, ensure_ascii=True, separators=(",", ":")), flush=True)


def with_conversation_turn_context(model):
    invoke, ainvoke, stream, astream = model.invoke, model.ainvoke, model.invoke_stream, model.ainvoke_stream
    @wraps(invoke)
    def call(*args, **kwargs):
        _record(args, kwargs)
        return invoke(*args, **kwargs)
    @wraps(ainvoke)
    async def acall(*args, **kwargs):
        _record(args, kwargs)
        return await ainvoke(*args, **kwargs)
    @wraps(stream)
    def call_stream(*args, **kwargs):
        _record(args, kwargs)
        yield from stream(*args, **kwargs)
    @wraps(astream)
    async def acall_stream(*args, **kwargs):
        _record(args, kwargs)
        async for item in astream(*args, **kwargs):
            yield item
    model.invoke, model.ainvoke, model.invoke_stream, model.ainvoke_stream = call, acall, call_stream, acall_stream
    return model
