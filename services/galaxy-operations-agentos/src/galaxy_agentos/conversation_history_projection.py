"""Present historical messages as reference data in a provider-only copy."""
from contextvars import ContextVar
from copy import deepcopy
from functools import wraps
import json

_PROJECTION = ContextVar("galaxy_conversation_history_projection", default=None)
_MEANING = "仅供理解指代、事实和本轮明确要求继续的方案；过去的准备或处理描述不代表当前待办，当前卡及业务状态以本轮权威回执为准。"


def projection_status():
    return _PROJECTION.get()


def _project(args, kwargs):
    messages = kwargs.get("messages", args[0] if args else None)
    if not isinstance(messages, list):
        return args, kwargs, {"applied": False, "historyCount": 0, "notProjected": 0}
    projected = []
    history_count = applied = skipped = 0
    for message in messages:
        if not getattr(message, "from_history", False):
            projected.append(message)
            continue
        history_count += 1
        content = getattr(message, "content", None)
        if not (isinstance(content, (str, list)) or content is None):
            projected.append(message)
            skipped += 1
            continue
        envelope = {"contextType": "historical-conversation-record", "historicalRole": message.role,
            "use": "reference-for-current-request", "instructionAuthority": "not-a-current-work-queue",
            "stateMeaning": "reported-then-not-current-authority", "contextMeaning": _MEANING}
        if isinstance(content, str):
            envelope["content"] = content
            replacement = json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))
        else:
            metadata = json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))
            replacement = [{"type": "text", "text": metadata}, *deepcopy(content or [])]
        copy = message.model_copy(deep=True)
        copy.content = replacement
        projected.append(copy)
        applied += 1
    if args:
        args = (projected, *args[1:])
    else:
        kwargs = {**kwargs, "messages": projected}
    return args, kwargs, {"applied": applied > 0, "historyCount": history_count, "notProjected": skipped}


def with_conversation_history_projection(model):
    invoke, ainvoke, stream, astream = model.invoke, model.ainvoke, model.invoke_stream, model.ainvoke_stream
    active = ContextVar("galaxy_conversation_history_active", default=False)

    def enter(args, kwargs):
        if active.get():
            return args, kwargs, None
        args, kwargs, status = _project(args, kwargs)
        return args, kwargs, (active.set(True), _PROJECTION.set(status))

    def leave(tokens):
        if tokens is not None:
            _PROJECTION.reset(tokens[1])
            active.reset(tokens[0])

    @wraps(invoke)
    def call(*args, **kwargs):
        args, kwargs, tokens = enter(args, kwargs)
        try:
            return invoke(*args, **kwargs)
        finally:
            leave(tokens)
    @wraps(ainvoke)
    async def acall(*args, **kwargs):
        args, kwargs, tokens = enter(args, kwargs)
        try:
            return await ainvoke(*args, **kwargs)
        finally:
            leave(tokens)
    @wraps(stream)
    def call_stream(*args, **kwargs):
        args, kwargs, tokens = enter(args, kwargs)
        try:
            yield from stream(*args, **kwargs)
        finally:
            leave(tokens)
    @wraps(astream)
    async def acall_stream(*args, **kwargs):
        args, kwargs, tokens = enter(args, kwargs)
        try:
            async for item in astream(*args, **kwargs):
                yield item
        finally:
            leave(tokens)
    model.invoke, model.ainvoke, model.invoke_stream, model.ainvoke_stream = call, acall, call_stream, acall_stream
    return model
