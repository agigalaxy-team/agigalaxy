"""Bounded continuation of one conversation run using its actual tool facts."""
import hashlib
import json
from functools import wraps
from agno.models.message import Message
from agno.models.response import ModelResponse
from .conversation_turn_plan import PLAN, ASSESSMENT, ACTIVITY
from .tool_reliability import PREPARED_CARD_IDS

_BLOCKED = "这项工作尚未完成，暂时无法继续处理。"
_PROMPT = ("继续当前原请求，按本轮实际工具回执处理。未知写入只读取原操作，不能重发。"
    "仅有真实cardId才可称卡已准备，准备不代表业务完成；需要人工确认时停止。"
    "按已声明方案数量完成可行的独立卡或说明真实限制，然后调用assess_turn。")

def with_conversation_completion(model):
    response, aresponse = model.response, model.aresponse
    stream, astream = model.response_stream, model.aresponse_stream
    def context(args, kwargs, streaming=False):
        messages = kwargs.get("messages", args[0] if args else None)
        index = 6 if streaming else 5
        run = kwargs.get("run_response", args[index] if len(args) > index else None)
        return messages, run
    def state(run):
        metadata = getattr(run, "metadata", None) or {}
        activity = metadata.get(ACTIVITY, 0)
        if not activity: return "done"
        plan = metadata.get(PLAN) or {}
        ids = metadata.get(PREPARED_CARD_IDS) or []
        target = 3 if plan.get("intent") == "prepare" and plan.get("proposalCount") == 3 and plan.get("alternatives") is True else 1
        assessment = metadata.get(ASSESSMENT) or {}
        valid = assessment.get("activity") == activity
        disposition = assessment.get("disposition") if valid else None
        if disposition == "awaiting-confirmation" and ids and len(ids) >= target: return "done"
        if disposition in {"needs-information", "blocked"}: return "done"
        if disposition == "completed" and plan.get("intent") != "prepare": return "done"
        return "continue"
    def facts(messages):
        seen = set()
        for message in messages or []:
            if getattr(message, "role", None) != "tool" or getattr(message, "from_history", False): continue
            if getattr(message, "tool_name", None) in {"assess_turn", "plan_turn"}: continue
            try:
                value = json.loads(message.content)
                if not isinstance(value, dict) or value.get("state") in {"invalid-request", "unavailable", "denied", "unknown", "processing"}: continue
                def clean(v):
                    if isinstance(v, dict): return {k:clean(x) for k,x in v.items() if k not in {"callId", "runId", "checkedAt", "readExpiresAt"}}
                    if isinstance(v, list): return [clean(x) for x in v]
                    return v
                data = json.dumps([message.tool_name, clean(value)], sort_keys=True, ensure_ascii=False, default=str)
                seen.add(hashlib.sha256(data.encode()).digest())
            except (TypeError, ValueError): pass
        return seen
    def advance(messages, run, seen, idle, extra):
        if state(run) == "done": return False, seen, idle, extra
        current = facts(messages)
        idle = 0 if current - seen else idle + 1
        seen |= current
        if idle >= 2 or extra >= 3:
            run.metadata = {**(run.metadata or {}), ASSESSMENT:{"disposition":"blocked", "reason":"未取得新进展", "remaining":[], "activity":(run.metadata or {}).get(ACTIVITY, 0)}}
            return False, seen, idle, -1
        messages.append(Message(role="system", content=_PROMPT))
        return True, seen, idle, extra + 1
    def merge(parts, value):
        tools = {}
        for part in parts:
            for tool in part.tool_executions or []: tools[tool.tool_call_id] = tool
        value.tool_executions = list(tools.values())
        return value
    @wraps(response)
    def checked(*args, **kwargs):
        messages, run = context(args, kwargs)
        if messages is None or run is None: return response(*args, **kwargs)
        parts, seen, idle, extra = [], set(), 0, 0
        while True:
            value = response(*args, **kwargs); parts.append(value)
            again, seen, idle, extra = advance(messages, run, seen, idle, extra)
            if not again:
                if extra == -1: value.content = _BLOCKED
                return merge(parts, value)
    @wraps(aresponse)
    async def achecked(*args, **kwargs):
        messages, run = context(args, kwargs)
        if messages is None or run is None: return await aresponse(*args, **kwargs)
        parts, seen, idle, extra = [], set(), 0, 0
        while True:
            value = await aresponse(*args, **kwargs); parts.append(value)
            again, seen, idle, extra = advance(messages, run, seen, idle, extra)
            if not again:
                if extra == -1: value.content = _BLOCKED
                return merge(parts, value)
    def visible(event):
        # Agno text deltas carry AssistantResponse; tool/progress/usage events
        # must remain live even while the model is repairing an incomplete turn.
        return getattr(event, "event", None) == "AssistantResponse" and bool(getattr(event, "content", None))
    @wraps(stream)
    def checked_stream(*args, **kwargs):
        messages, run = context(args, kwargs, streaming=True)
        if messages is None or run is None:
            yield from stream(*args, **kwargs); return
        seen, idle, extra = set(), 0, 0
        while True:
            pending = []
            for event in stream(*args, **kwargs):
                if visible(event) and state(run) != "done": pending.append(event)
                else:
                    if pending and state(run) == "done":
                        yield from pending; pending.clear()
                    yield event
            again, seen, idle, extra = advance(messages, run, seen, idle, extra)
            if not again:
                if extra == -1: yield ModelResponse(content=_BLOCKED)
                else: yield from pending
                return
    @wraps(astream)
    async def achecked_stream(*args, **kwargs):
        messages, run = context(args, kwargs, streaming=True)
        if messages is None or run is None:
            async for event in astream(*args, **kwargs): yield event
            return
        seen, idle, extra = set(), 0, 0
        while True:
            pending = []
            async for event in astream(*args, **kwargs):
                if visible(event) and state(run) != "done": pending.append(event)
                else:
                    if pending and state(run) == "done":
                        for item in pending: yield item
                        pending.clear()
                    yield event
            again, seen, idle, extra = advance(messages, run, seen, idle, extra)
            if not again:
                if extra == -1: yield ModelResponse(content=_BLOCKED)
                else:
                    for event in pending: yield event
                return
    model.response, model.aresponse = checked, achecked
    model.response_stream, model.aresponse_stream = checked_stream, achecked_stream
    return model
