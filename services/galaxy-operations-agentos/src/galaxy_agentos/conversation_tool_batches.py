"""Reject ambiguous simultaneous confirmation preparations before any executes."""
from functools import wraps
import json
import hashlib

from agno.models.message import Message
from .model_usage import _RUN
from .conversation_turn_plan import PLAN
from .tool_reliability import PREPARED_CARD_IDS, PREPARED_FINGERPRINTS

def fingerprint(arguments):
    try:
        encoded = json.dumps(arguments, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    except (TypeError, ValueError):
        return None


def with_conversation_tool_batches(model):
    if not hasattr(model, "run_function_calls") or not hasattr(model, "arun_function_calls"):
        return model
    run, arun = model.run_function_calls, model.arun_function_calls

    def partition(args, kwargs):
        calls = kwargs.get("function_calls", args[0] if args else None)
        results = kwargs.get("function_call_results", args[1] if len(args) > 1 else None)
        if not isinstance(calls, list) or not isinstance(results, list):
            return args, kwargs
        assessments = [call for call in calls if call.function.name == "assess_turn"]
        if assessments and any(call.function.name != "assess_turn" for call in calls):
            content = json.dumps({"state":"invalid-request", "reason":"assess_after_tool_results"})
            for call in assessments:
                results.append(Message(role=model.tool_message_role, content=content, tool_call_id=call.call_id, tool_name=call.function.name, tool_call_error=True))
            calls = [call for call in calls if call.function.name != "assess_turn"]
            if args: args = (calls, *args[1:])
            else: kwargs = {**kwargs, "function_calls": calls}
        prepared = [call for call in calls if call.function.name == "prepare_operation"]
        if not prepared:
            return args, kwargs
        run = _RUN.get()
        metadata = getattr(run, "metadata", None) or {}
        plan = metadata.get(PLAN) or {}
        quota = 3 if plan.get("intent") == "prepare" and plan.get("proposalCount") == 3 and plan.get("alternatives") is True else 1
        ids = metadata.get(PREPARED_CARD_IDS) or []
        prior = metadata.get(PREPARED_FINGERPRINTS) or []
        keys = [fingerprint(call.arguments) for call in prepared]
        if not any(call.function.name == "plan_turn" for call in calls) and not metadata.get("_galaxyPrepareUnknown") and len(ids) + len(prepared) <= quota and None not in keys and len(set(keys)) == len(keys) and not set(keys).intersection(prior):
            return args, kwargs
        content = json.dumps({"state": "invalid-request", "reason": "候选重复或超出本轮计划数量；请依据已准备的真实卡继续。", "cardPrepared": False, "effectExecuted": False}, ensure_ascii=False)
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
