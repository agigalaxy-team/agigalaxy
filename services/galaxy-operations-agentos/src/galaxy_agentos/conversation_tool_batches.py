"""Reject ambiguous simultaneous confirmation preparations before any executes."""
from functools import wraps
import json

from agno.models.message import Message


def with_conversation_tool_batches(model):
    if not hasattr(model, "run_function_calls") or not hasattr(model, "arun_function_calls"):
        return model
    run, arun = model.run_function_calls, model.arun_function_calls

    def partition(args, kwargs):
        calls = kwargs.get("function_calls", args[0] if args else None)
        results = kwargs.get("function_call_results", args[1] if len(args) > 1 else None)
        if not isinstance(calls, list) or not isinstance(results, list):
            return args, kwargs
        prepared = [call for call in calls if call.function.name == "prepare_operation"]
        if len(prepared) <= 1:
            return args, kwargs
        content = json.dumps({"state": "invalid-request", "reason": "单次确认需选择一个具体操作，请选择一个操作后重新准备。"}, ensure_ascii=False)
        for call in prepared:
            results.append(Message(role=model.tool_message_role, content=content,
                tool_call_id=call.call_id, tool_name=call.function.name, tool_call_error=True))
        remaining = [call for call in calls if call.function.name != "prepare_operation"]
        if args:
            args = (remaining, *args[1:])
        else:
            kwargs = {**kwargs, "function_calls": remaining}
        return args, kwargs

    @wraps(run)
    def guarded(*args, **kwargs):
        args, kwargs = partition(args, kwargs)
        yield from run(*args, **kwargs)

    @wraps(arun)
    async def aguard(*args, **kwargs):
        args, kwargs = partition(args, kwargs)
        async for item in arun(*args, **kwargs):
            yield item

    model.run_function_calls, model.arun_function_calls = guarded, aguard
    return model
