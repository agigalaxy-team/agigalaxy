"""Bounded continuation of one conversation run using its actual tool facts."""
import asyncio
import hashlib
import json
import time
from contextvars import ContextVar
from functools import wraps
from uuid import UUID
from agno.models.message import Message
from agno.models.response import ModelResponse
from .conversation_turn_state import turn_state, PLAN, ASSESSMENT, ACTIVITY, PREPARED_CARD_IDS, TASK_PROGRESS, TASK_CONTEXT, RECEIPT_FEEDBACK

_BLOCKED = "这项工作尚未完成，暂时无法继续处理。"
_INTERRUPTED = "本次处理已中断，工作尚未完成。"

class _TaskTimedOut(Exception):
    pass
_PROMPT = ("继续当前原请求，按本轮实际工具回执处理。未知写入只读取原操作，不能重发。"
    "仅有真实cardId才可称卡已准备，准备不代表业务完成；需要人工确认时停止。"
    "继续原任务及其剩余工作；需具体人工处理时按已声明数量准备独立卡，等待确认不等于任务完成。"
    "根据真实回执调用assess_turn：继续、等待结果、等待人工、缺信息、受阻、中断或已完成；已完成不能有剩余工作。")

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
    assessment = state.get(ASSESSMENT) or {}
    if (assessment.get("activity") == state.get(ACTIVITY, 0) and
            assessment.get("disposition") in {"continue", "completed", "needs-information", "waiting-result", "blocked", "interrupted"}):
        return None
    target = 3 if plan.get("proposalCount") == 3 and plan.get("alternatives") is True else 1
    if len(_verified_prepared_ids(state)) < target: return None
    return _PREPARED_THREE if target == 3 else _PREPARED_ONE

def with_conversation_completion(model, *, timeout_seconds=600, gateway=None):
    response, aresponse = model.response, model.aresponse
    stream, astream = model.response_stream, model.aresponse_stream
    def context(args, kwargs, streaming=False):
        messages = kwargs.get("messages", args[0] if args else None)
        index = 6 if streaming else 5
        run = kwargs.get("run_response", args[index] if len(args) > index else None)
        return messages, run
    deadline = ContextVar("galaxy_conversation_deadline", default=None)
    def expired():
        limit = deadline.get()
        return limit is not None and time.monotonic() >= limit
    def state(run):
        metadata = turn_state(run)
        activity = metadata.get(ACTIVITY, 0)
        plan = metadata.get(PLAN) or {}
        progress = metadata.get(TASK_PROGRESS) or {}
        assessment = metadata.get(ASSESSMENT) or {}
        valid = assessment.get("activity") == activity
        disposition = assessment.get("disposition") if valid else None
        if disposition in {"needs-information", "waiting-result", "blocked", "interrupted"}: return disposition
        if prepared_notification(run): return "waiting-confirmation"
        if disposition == "continue": return "continue"
        if disposition == "completed" and not assessment.get("remaining"): return "completed"
        if disposition == "waiting-confirmation": return "waiting-confirmation"
        task = metadata.get(TASK_CONTEXT)
        root = task.get("rootOperationId") if isinstance(task, dict) else None
        operation = (getattr(run, "metadata", None) or {}).get("operationId")
        resumed = isinstance(root, str) and bool(root) and isinstance(operation, str) and bool(operation) and root != operation
        if (not activity and plan.get("intent") != "prepare" and not metadata.get(RECEIPT_FEEDBACK)
                and not resumed and not (progress.get("phase") == "continue" and progress.get("remaining"))): return "completed"
        return "continue"
    def facts(messages):
        seen = set()
        calls = {}
        for message in messages or []:
            if getattr(message, "role", None) == "assistant" and not getattr(message, "from_history", False):
                for call in getattr(message, "tool_calls", None) or []:
                    if isinstance(call, dict) and isinstance(call.get("function"), dict):
                        calls[call.get("id")] = call["function"].get("arguments")
        for message in messages or []:
            if getattr(message, "role", None) != "tool" or getattr(message, "from_history", False): continue
            if getattr(message, "tool_name", None) in {"assess_turn", "plan_turn"}: continue
            try:
                value = json.loads(message.content)
                if not isinstance(value, dict): continue
                def clean(v):
                    if isinstance(v, dict): return {k:clean(x) for k,x in v.items() if k not in {"callId", "runId", "checkedAt", "readExpiresAt"}}
                    if isinstance(v, list): return [clean(x) for x in v]
                    return v
                data = json.dumps([message.tool_name, calls.get(message.tool_call_id), clean(value)], sort_keys=True, ensure_ascii=False, default=str)
                seen.add(hashlib.sha256(data.encode()).digest())
            except (TypeError, ValueError): pass
        return seen
    def checkpoint(run, disposition, reason):
        current = turn_state(run)
        progress = current.get(TASK_PROGRESS) or {}
        remaining = progress.get("remaining", []) if isinstance(progress, dict) else []
        if not (isinstance(remaining, list) and len(remaining) <= 40 and all(isinstance(item, str) and item.strip() and len(item) <= 1000 for item in remaining)):
            from .gateway import AuthorityUnavailable
            raise AuthorityUnavailable("agentos_conversation_checkpoint_unavailable")
        remaining = list(remaining)
        if gateway is not None:
            from .gateway import AuthorityUnavailable
            operation_id = (run.metadata or {}).get("operationId")
            result = gateway.conversation_tool(run.user_id, "assess-conversation-task",
                {"disposition":disposition, "reason":reason, "remaining":remaining},
                run_id=run.run_id, session_id=run.session_id, turn_id=operation_id,
                call_id={"interrupted":"runtime:task-timeout:", "blocked":"runtime:task-loop:",
                    "completed":"runtime:task-completed:", "awaiting-confirmation":"runtime:task-waiting:"}[disposition] + str(operation_id))
            progress = result.get("taskProgress") if isinstance(result, dict) else None
            phases = {"continue", "completed", "waiting-confirmation", "needs-information", "waiting-result", "blocked", "interrupted"}
            if not (isinstance(result, dict) and result.get("state") in {"recorded", "needs-continuation"} and isinstance(progress, dict) and progress.get("phase") in phases and isinstance(progress.get("remaining"), list)):
                raise AuthorityUnavailable("agentos_conversation_checkpoint_unavailable")
            expected = "waiting-confirmation" if disposition == "awaiting-confirmation" else disposition
            if disposition in {"blocked", "interrupted", "awaiting-confirmation"} and progress["phase"] != expected:
                if disposition != "awaiting-confirmation" or progress["phase"] not in {"continue", "waiting-result"}:
                    raise AuthorityUnavailable("agentos_conversation_checkpoint_unavailable")
            current[TASK_PROGRESS] = progress
        else:
            progress = {"phase":"waiting-confirmation" if disposition == "awaiting-confirmation" else disposition, "remaining":remaining}
            current[TASK_PROGRESS] = progress
        current[ASSESSMENT] = {"disposition":progress["phase"], "reason":reason, "remaining":progress["remaining"], "activity":current.get(ACTIVITY,0)}
        return progress["phase"]
    def finalize(run, outcome):
        current = turn_state(run)
        assessment = current.get(ASSESSMENT) or {}
        valid = assessment.get("activity") == current.get(ACTIVITY, 0) and assessment.get("disposition") in {"continue", "completed", "waiting-confirmation", "needs-information", "waiting-result", "blocked", "interrupted"}
        if outcome == "waiting-confirmation" and prepared_notification(run) and not valid:
            return checkpoint(run, "awaiting-confirmation", "已准备，等待人工确认")
        if (outcome == "completed" and not valid and not current.get(ACTIVITY, 0)
                and not current.get(RECEIPT_FEEDBACK) and not (current.get(TASK_PROGRESS) or {}).get("remaining")):
            return checkpoint(run, "completed", "本轮回答已完成")
        return outcome
    def advance(messages, run, seen):
        if expired(): return "deadline", seen
        outcome = state(run)
        if outcome != "continue": return outcome, seen
        meta = turn_state(run)
        assessment = meta.get(ASSESSMENT) or {}
        valid = assessment.get("activity") == meta.get(ACTIVITY,0)
        if valid and assessment.get("disposition") == "continue":
            next_step = ["continue", assessment.get("reason"), assessment.get("remaining")]
        else: next_step = ["assess-current-task"]
        signature = (frozenset(facts(messages)), json.dumps(next_step, ensure_ascii=False, sort_keys=True))
        if signature in seen:
            return "blocked-loop", seen
        seen.add(signature)
        for index, message in enumerate(messages):
            if getattr(message, "role", None) == "system" and not getattr(message, "from_history", False) and isinstance(getattr(message, "content", None), str):
                if _PROMPT not in message.content:
                    messages[index] = message.model_copy(update={"content": message.content + "\n\n" + _PROMPT})
                break
        else:
            messages.insert(0, Message(role="system", content=_PROMPT))
        return "continue", seen
    def merge(parts, value):
        tools = {}
        for part in parts:
            for tool in part.tool_executions or []: tools[tool.tool_call_id] = tool
        value.tool_executions = list(tools.values())
        return value
    # Guard each native provider request, including Agno's own tool loop. An
    # in-flight tool is allowed to settle before the next boundary is checked.
    for method_name in ("invoke", "ainvoke", "invoke_stream", "ainvoke_stream"):
        original = getattr(model, method_name, None)
        if original is None: continue
        if method_name == "invoke":
            def guarded(*args, _fn=original, **kwargs):
                if expired(): raise _TaskTimedOut()
                return _fn(*args, **kwargs)
        elif method_name == "ainvoke":
            async def guarded(*args, _fn=original, **kwargs):
                if expired(): raise _TaskTimedOut()
                limit = deadline.get()
                if limit is None: return await _fn(*args, **kwargs)
                timer = asyncio.timeout(max(0, limit - time.monotonic()))
                try:
                    async with timer: return await _fn(*args, **kwargs)
                except TimeoutError:
                    if timer.expired(): raise _TaskTimedOut() from None
                    raise
        elif method_name == "invoke_stream":
            def guarded(*args, _fn=original, **kwargs):
                if expired(): raise _TaskTimedOut()
                yield from _fn(*args, **kwargs)
        else:
            async def guarded(*args, _fn=original, **kwargs):
                if expired(): raise _TaskTimedOut()
                limit = deadline.get()
                if limit is None:
                    async for item in _fn(*args, **kwargs): yield item
                    return
                timer = asyncio.timeout(max(0, limit - time.monotonic()))
                try:
                    async with timer:
                        async for item in _fn(*args, **kwargs): yield item
                except TimeoutError:
                    if timer.expired(): raise _TaskTimedOut() from None
                    raise
        setattr(model, method_name, guarded)
    @wraps(response)
    def checked(*args, **kwargs):
        messages, run = context(args, kwargs)
        if messages is None or run is None: return response(*args, **kwargs)
        token=deadline.set(time.monotonic()+timeout_seconds); parts, seen = [], set()
        try:
            while True:
                try: value=response(*args, **kwargs); parts.append(value)
                except _TaskTimedOut: checkpoint(run,"interrupted","处理时限已到"); return ModelResponse(content=_INTERRUPTED)
                outcome, seen = advance(messages, run, seen)
                if outcome not in {"continue", "deadline", "blocked-loop"}:
                    outcome = finalize(run, outcome)
                    if outcome == "continue": outcome, seen = advance(messages, run, seen)
                if outcome != "continue":
                    if outcome == "deadline": checkpoint(run,"interrupted","处理时限已到"); value.content=_INTERRUPTED
                    elif outcome == "interrupted": value.content=_INTERRUPTED
                    elif outcome == "blocked-loop": checkpoint(run,"blocked","重复相同事实且没有新进展"); value.content=_BLOCKED
                    elif prepared_notification(run): value.content=prepared_notification(run)
                    return merge(parts, value)
        finally: deadline.reset(token)
    @wraps(aresponse)
    async def achecked(*args, **kwargs):
        messages, run = context(args, kwargs)
        if messages is None or run is None: return await aresponse(*args, **kwargs)
        token=deadline.set(time.monotonic()+timeout_seconds); parts, seen = [], set()
        try:
            while True:
                try: value=await aresponse(*args, **kwargs); parts.append(value)
                except _TaskTimedOut: await asyncio.to_thread(checkpoint,run,"interrupted","处理时限已到"); return ModelResponse(content=_INTERRUPTED)
                outcome, seen = advance(messages, run, seen)
                if outcome not in {"continue", "deadline", "blocked-loop"}:
                    outcome = await asyncio.to_thread(finalize,run,outcome)
                    if outcome == "continue": outcome, seen = advance(messages, run, seen)
                if outcome != "continue":
                    if outcome == "deadline": await asyncio.to_thread(checkpoint,run,"interrupted","处理时限已到"); value.content=_INTERRUPTED
                    elif outcome == "interrupted": value.content=_INTERRUPTED
                    elif outcome == "blocked-loop": await asyncio.to_thread(checkpoint,run,"blocked","重复相同事实且没有新进展"); value.content=_BLOCKED
                    elif prepared_notification(run): value.content=prepared_notification(run)
                    return merge(parts, value)
        finally: deadline.reset(token)
    def visible(event):
        return getattr(event, "event", None) == "AssistantResponse" and bool(getattr(event, "content", None))
    @wraps(stream)
    def checked_stream(*args, **kwargs):
        messages, run = context(args, kwargs, streaming=True)
        if messages is None or run is None:
            yield from stream(*args, **kwargs); return
        token=deadline.set(time.monotonic()+timeout_seconds); seen=set()
        try:
            while True:
                pending=[]
                try:
                    for event in stream(*args, **kwargs):
                        plan=turn_state(run).get(PLAN) or {}
                        if visible(event) and (plan.get("intent") == "prepare" or state(run) == "continue"): pending.append(event)
                        else:
                            if pending and state(run) != "continue" and plan.get("intent") != "prepare": yield from pending; pending.clear()
                            yield event
                except _TaskTimedOut:
                    checkpoint(run,"interrupted","处理时限已到"); yield ModelResponse(content=_INTERRUPTED); return
                outcome, seen = advance(messages, run, seen)
                if outcome not in {"continue", "deadline", "blocked-loop"}:
                    outcome = finalize(run, outcome)
                    if outcome == "continue": outcome, seen = advance(messages, run, seen)
                if outcome != "continue":
                    if outcome == "deadline": checkpoint(run,"interrupted","处理时限已到"); yield ModelResponse(content=_INTERRUPTED)
                    elif outcome == "interrupted": yield ModelResponse(content=_INTERRUPTED)
                    elif outcome == "blocked-loop": checkpoint(run,"blocked","重复相同事实且没有新进展"); yield ModelResponse(content=_BLOCKED)
                    elif prepared_notification(run): yield ModelResponse(content=prepared_notification(run))
                    else: yield from pending
                    return
        finally: deadline.reset(token)
    @wraps(astream)
    async def achecked_stream(*args, **kwargs):
        messages, run = context(args, kwargs, streaming=True)
        if messages is None or run is None:
            async for event in astream(*args, **kwargs): yield event
            return
        token=deadline.set(time.monotonic()+timeout_seconds); seen=set()
        try:
            while True:
                pending=[]
                try:
                    async for event in astream(*args, **kwargs):
                        plan=turn_state(run).get(PLAN) or {}
                        if visible(event) and (plan.get("intent") == "prepare" or state(run) == "continue"): pending.append(event)
                        else:
                            if pending and state(run) != "continue" and plan.get("intent") != "prepare":
                                for item in pending: yield item
                                pending.clear()
                            yield event
                except _TaskTimedOut:
                    await asyncio.to_thread(checkpoint,run,"interrupted","处理时限已到"); yield ModelResponse(content=_INTERRUPTED); return
                outcome, seen = advance(messages, run, seen)
                if outcome not in {"continue", "deadline", "blocked-loop"}:
                    outcome = await asyncio.to_thread(finalize,run,outcome)
                    if outcome == "continue": outcome, seen = advance(messages, run, seen)
                if outcome != "continue":
                    if outcome == "deadline": await asyncio.to_thread(checkpoint,run,"interrupted","处理时限已到"); yield ModelResponse(content=_INTERRUPTED)
                    elif outcome == "interrupted": yield ModelResponse(content=_INTERRUPTED)
                    elif outcome == "blocked-loop": await asyncio.to_thread(checkpoint,run,"blocked","重复相同事实且没有新进展"); yield ModelResponse(content=_BLOCKED)
                    elif prepared_notification(run): yield ModelResponse(content=prepared_notification(run))
                    else:
                        for item in pending: yield item
                    return
        finally: deadline.reset(token)
    model.response, model.aresponse = checked, achecked
    model.response_stream, model.aresponse_stream = checked_stream, achecked_stream
    return model
