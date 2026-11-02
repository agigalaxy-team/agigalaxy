"""Preserve tool result order without imposing a preparation workflow."""
from functools import wraps
import json
import hashlib


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

    def batch_order(args, kwargs):
        calls = kwargs.get("function_calls", args[0] if args else None)
        results = kwargs.get("function_call_results", args[1] if len(args) > 1 else None)
        if not isinstance(calls, list) or not isinstance(results, list):
            return None
        order = {}
        for index, call in enumerate(calls):
            if isinstance(call.call_id, str): order.setdefault(call.call_id, index)
        return results, len(results), order, len(calls)

    def restore_order(batch):
        if batch is None: return
        results, start, order, unmatched = batch
        # Keep pre-existing results and the original Message instances intact.
        # Unmatched additions remain stable after the known call IDs.
        results[start:] = sorted(results[start:], key=lambda item: order.get(getattr(item, "tool_call_id", None), unmatched))

    @wraps(run)
    def guarded(*args, **kwargs):
        batch = batch_order(args, kwargs)
        yield from run(*args, **kwargs)
        restore_order(batch)

    @wraps(arun)
    async def aguard(*args, **kwargs):
        batch = batch_order(args, kwargs)
        async for item in arun(*args, **kwargs):
            yield item
        restore_order(batch)

    model.run_function_calls, model.arun_function_calls = guarded, aguard
    return model
