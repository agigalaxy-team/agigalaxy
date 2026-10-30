"""Bounded continuation of one conversation run using its actual tool facts."""
import hashlib
import json
from functools import wraps
from uuid import UUID
from agno.models.message import Message
from agno.models.response import ModelResponse
from .conversation_turn_state import turn_state, PLAN, ASSESSMENT, ACTIVITY, PREPARED_CARD_IDS

_BLOCKED = "这项工作尚未完成，暂时无法继续处理。"
_PROMPT = ("继续当前原请求，按本轮实际工具回执处理。未知写入只读取原操作，不能重发。"
    "仅有真实cardId才可称卡已准备，准备不代表业务完成；需要人工确认时停止。"
    "按已声明方案数量完成可行的独立卡或说明真实限制，然后调用assess_turn。")

_PREPARED_ONE = "方案已准备，请在下方确认。当前尚未执行。"
_PREPARED_THREE = "已准备 3 个备选方案，请在下方选择一项。当前尚未执行。"

def _verified_prepared_ids(state):
    values = state.get(PREPARED_CARD_IDS)
    result = set()
    if isinstance(values, list):
        for ident in values:
            try:
                if isinstance(ident, str) and str(UUID(ident)) == ident: result.add(ident)
            except (ValueError, TypeError, AttributeError):
                pass
    return result

def prepared_notification(run):
    state = turn_state(run)
    plan = state.get(PLAN) or {}
    if not isinstance(plan, dict) or plan.get("intent") != "prepare": return None
    target = 3 if plan.get("proposalCount") == 3 and plan.get("alternatives") is True else 1
    if len(_verified_prepared_ids(state)) < target: return None
    return _PREPARED_THREE if target == 3 else _PREPARED_ONE

def with_conversation_completion(model):
    response, aresponse = model.response, model.aresponse
    stream, astream = model.response_stream, model.aresponse_stream
    def context(args, kwargs, streaming=False):
        messages = kwargs.get("messages", args[0] if args else None)
        index = 6 if streaming else 5
        run = kwargs.get("run_response", args[index] if len(args) > index else None)
        return messages, run
    def state(run):
        metadata = turn_state(run)
        activity = metadata.get(ACTIVITY, 0)
        plan = metadata.get(PLAN) or {}
        if not activity and plan.get("intent") != "prepare": return "done"
        verified_ids = _verified_prepared_ids(metadata)
        target = 3 if plan.get("intent") == "prepare" and plan.get("proposalCount") == 3 and plan.get("alternatives") is True else 1
        if prepared_notification(run): return "done"
        assessment = metadata.get(ASSESSMENT) or {}
        valid = assessment.get("activity") == activity
        disposition = assessment.get("disposition") if valid else None
        if disposition == "awaiting-confirmation" and len(verified_ids) >= target: return "done"
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
            current = turn_state(run)
            current[ASSESSMENT] = {"disposition":"blocked", "reason":"未取得新进展", "remaining":[], "activity":current.get(ACTIVITY, 0)}
            return False, seen, idle, -1
        for index, message in enumerate(messages):
            if getattr(message, "role", None) == "system" and not getattr(message, "from_history", False) and isinstance(getattr(message, "content", None), str):
                if _PROMPT not in message.content:
                    messages[index] = message.model_copy(update={"content": message.content + "\n\n" + _PROMPT})
                break
        else:
            messages.insert(0, Message(role="system", content=_PROMPT))
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
                elif prepared_notification(run): value.content = prepared_notification(run)
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
                elif prepared_notification(run): value.content = prepared_notification(run)
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
                plan = turn_state(run).get(PLAN) or {}
                if visible(event) and (plan.get("intent") == "prepare" or state(run) != "done"): pending.append(event)
                else:
                    if pending and state(run) == "done" and plan.get("intent") != "prepare":
                        yield from pending; pending.clear()
                    yield event
            again, seen, idle, extra = advance(messages, run, seen, idle, extra)
            if not again:
                if extra == -1: yield ModelResponse(content=_BLOCKED)
                elif prepared_notification(run): yield ModelResponse(content=prepared_notification(run))
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
                plan = turn_state(run).get(PLAN) or {}
                if visible(event) and (plan.get("intent") == "prepare" or state(run) != "done"): pending.append(event)
                else:
                    if pending and state(run) == "done" and plan.get("intent") != "prepare":
                        for item in pending: yield item
                        pending.clear()
                    yield event
            again, seen, idle, extra = advance(messages, run, seen, idle, extra)
            if not again:
                if extra == -1: yield ModelResponse(content=_BLOCKED)
                elif prepared_notification(run): yield ModelResponse(content=prepared_notification(run))
                else:
                    for event in pending: yield event
                return
    model.response, model.aresponse = checked, achecked
    model.response_stream, model.aresponse_stream = checked_stream, achecked_stream
    return model
