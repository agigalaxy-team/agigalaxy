"""One task boundary around Agno's native model/tool execution.

Agno owns tool dispatch and message pairing. This boundary only continues an
explicitly unfinished task or settles it; business rules live in the caller.
"""
import asyncio
import time
from contextvars import ContextVar
from dataclasses import dataclass
from functools import wraps

from agno.models.message import Message


@dataclass(frozen=True)
class TaskDecision:
    state: str = "completed"
    remaining: tuple[str, ...] = ()
    reason: str = ""


class TaskLoopTimeout(TimeoutError):
    pass


_CONTINUE = ("运行器接续，不是新的用户请求。继续当前原任务，使用已有结果处理剩余工作，"
             "不要重复已经完成的操作。需要人工决定、信息或原操作结果时等待；完成后直接答复。")


def with_task_loop(model, *, decide, continue_input=None, timeout_seconds=None, on_timeout=None):
    """Share full/streaming and sync/async task continuation without step quotas."""
    deadline = ContextVar("galaxy_task_deadline", default=None)
    signals = ContextVar("galaxy_task_continuations", default=None)

    def context(args, kwargs, streaming=False):
        return (kwargs.get("messages", args[0] if args else None),
                kwargs.get("run_response", args[6 if streaming else 5] if len(args) > (6 if streaming else 5) else None))

    def begin():
        return (deadline.set(time.monotonic() + timeout_seconds if timeout_seconds else None), signals.set({}))

    def end(tokens):
        signals.reset(tokens[1])
        deadline.reset(tokens[0])

    def project(args, kwargs):
        messages = kwargs.get("messages", args[0] if args else None)
        pending = signals.get()
        if not pending or not isinstance(messages, list):
            return args, kwargs
        existing = {message.id for message in messages}
        output = []
        for message in messages:
            output.append(message)
            signal = pending.get(message.id)
            if signal is not None and signal.id not in existing:
                output.append(signal)
        return ((output, *args[1:]), kwargs) if args else (args, {**kwargs, "messages": output})

    def check_time():
        value = deadline.get()
        if value is not None and time.monotonic() >= value:
            raise TaskLoopTimeout("agentos_task_timeout")
        return value

    # Check at the provider boundary; don't cancel a business writer mid-commit.
    for name in ("invoke", "ainvoke", "invoke_stream", "ainvoke_stream"):
        original = getattr(model, name)
        if name == "invoke":
            def call(*args, _fn=original, **kwargs):
                check_time()
                args, kwargs = project(args, kwargs)
                return _fn(*args, **kwargs)
        elif name == "ainvoke":
            async def call(*args, _fn=original, **kwargs):
                limit = check_time()
                args, kwargs = project(args, kwargs)
                if limit is None:
                    return await _fn(*args, **kwargs)
                timer = asyncio.timeout(max(0, limit - time.monotonic()))
                try:
                    async with timer:
                        return await _fn(*args, **kwargs)
                except TimeoutError:
                    if timer.expired():
                        raise TaskLoopTimeout("agentos_task_timeout") from None
                    raise
        elif name == "invoke_stream":
            def call(*args, _fn=original, **kwargs):
                check_time()
                args, kwargs = project(args, kwargs)
                yield from _fn(*args, **kwargs)
        else:
            async def call(*args, _fn=original, **kwargs):
                limit = check_time()
                args, kwargs = project(args, kwargs)
                if limit is None:
                    async for value in _fn(*args, **kwargs):
                        yield value
                    return
                timer = asyncio.timeout(max(0, limit - time.monotonic()))
                try:
                    async with timer:
                        async for value in _fn(*args, **kwargs):
                            yield value
                except TimeoutError:
                    if timer.expired():
                        raise TaskLoopTimeout("agentos_task_timeout") from None
                    raise
        setattr(model, name, wraps(original)(call))

    def advance(messages, run):
        if any(not requirement.is_resolved() for requirement in (getattr(run, "requirements", None) or [])):
            return False
        decision = decide(run)
        if not isinstance(decision, TaskDecision):
            raise TypeError("agentos_task_decision_invalid")
        if decision.state != "continue":
            return False
        check_time()
        # An explicit runtime input is required by providers rejecting assistant
        # prefill. It only enters provider copies, never native stored history.
        if messages and messages[-1].role == "assistant" and not messages[-1].tool_calls:
            content = continue_input(run, decision) if continue_input else _CONTINUE
            if decision.remaining:
                content += "\n剩余工作：\n" + "\n".join(decision.remaining)
            signals.get().setdefault(messages[-1].id, Message(role="user", name="galaxy_runtime_continuation", content=content))
        return True

    def merge(parts, value):
        tools = {}
        for part in parts:
            for tool in part.tool_executions or []:
                tools[tool.tool_call_id] = tool
        value.tool_executions = list(tools.values())
        return value

    for name in ("response", "aresponse", "response_stream", "aresponse_stream"):
        original = getattr(model, name)
        if name == "response":
            def call(*args, _fn=original, **kwargs):
                messages, run = context(args, kwargs)
                if not isinstance(messages, list) or run is None:
                    return _fn(*args, **kwargs)
                tokens, parts = begin(), []
                try:
                    while True:
                        value = _fn(*args, **kwargs)
                        parts.append(value)
                        if not advance(messages, run):
                            return merge(parts, value)
                except TaskLoopTimeout:
                    if on_timeout:
                        on_timeout(run)
                    raise
                finally:
                    end(tokens)
        elif name == "aresponse":
            async def call(*args, _fn=original, **kwargs):
                messages, run = context(args, kwargs)
                if not isinstance(messages, list) or run is None:
                    return await _fn(*args, **kwargs)
                tokens, parts = begin(), []
                try:
                    while True:
                        value = await _fn(*args, **kwargs)
                        parts.append(value)
                        if not await asyncio.to_thread(advance, messages, run):
                            return merge(parts, value)
                except TaskLoopTimeout:
                    if on_timeout:
                        await asyncio.to_thread(on_timeout, run)
                    raise
                finally:
                    end(tokens)
        elif name == "response_stream":
            def call(*args, _fn=original, **kwargs):
                messages, run = context(args, kwargs, True)
                if not isinstance(messages, list) or run is None:
                    yield from _fn(*args, **kwargs)
                    return
                tokens = begin()
                try:
                    while True:
                        yield from _fn(*args, **kwargs)
                        if not advance(messages, run):
                            return
                except TaskLoopTimeout:
                    if on_timeout:
                        on_timeout(run)
                    raise
                finally:
                    end(tokens)
        else:
            async def call(*args, _fn=original, **kwargs):
                messages, run = context(args, kwargs, True)
                if not isinstance(messages, list) or run is None:
                    async for value in _fn(*args, **kwargs):
                        yield value
                    return
                tokens = begin()
                try:
                    while True:
                        async for value in _fn(*args, **kwargs):
                            yield value
                        if not await asyncio.to_thread(advance, messages, run):
                            return
                except TaskLoopTimeout:
                    if on_timeout:
                        await asyncio.to_thread(on_timeout, run)
                    raise
                finally:
                    end(tokens)
        setattr(model, name, wraps(original)(call))
    return model
