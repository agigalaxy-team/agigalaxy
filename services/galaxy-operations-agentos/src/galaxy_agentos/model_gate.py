import asyncio
from functools import wraps

from agno.run.authorization import current_authorization

from .gateway import AuthorityDenied
from .model_usage import install_usage_scope, record_model_call, arecord_model_call, provider_call


def with_current_authority(model, gateway, *, admission=None):
    """Recheck the native trusted caller before/after every model invocation.

    No run metadata, prompt, tool argument or browser permission snapshot can
    supply this identity. AgentOS restores the native authorization context for
    durable queue attempts; a missing context fails closed.
    """
    def current():
        authority = current_authorization()
        user_id = authority.context.principal_id if authority is not None else None
        if not user_id:
            raise AuthorityDenied("agentos_execution_identity_required")
        result = gateway.authorize(user_id, operation="run")
        from .model_usage import _RUN
        from .conversation_turn_state import TURN_STATE
        run = _RUN.get()
        if user_id.startswith("conversation:") and run is not None:
            metadata = run.metadata or {}
            state = metadata.get(TURN_STATE)
            loaded = (state.get("sourceQualification") if isinstance(state, dict)
                and state.get("operationId") == metadata.get("operationId")
                and state.get("runId") == run.run_id else None)
            if loaded is not None:
                from .source_qualification import source_qualification
                current_qualification = source_qualification(result)
                old_affected = set(loaded.get("affectedTurns") or [])
                affected = set(current_qualification.get("affectedTurns") or [])
                old_legacy = loaded.get("legacyUnknown") is True
                legacy = current_qualification.get("legacyUnknown") is True
                old_safe = set(loaded.get("legacySafeTurns") or [])
                safe = set(current_qualification.get("legacySafeTurns") or [])
                if affected - old_affected or legacy and (not old_legacy or old_safe - safe):
                    raise AuthorityDenied("agentos_source_qualification_changed")
                if (run.metadata or {}).get("operationId") in affected:
                    raise AuthorityDenied("agentos_current_source_changed")
        if admission is not None:
            admission(result)

    count_calls = not getattr(model, "_galaxy_usage_gate_installed", False)
    model._galaxy_usage_gate_installed = True
    install_usage_scope(model)
    invoke, ainvoke = model.invoke, model.ainvoke
    invoke_stream, ainvoke_stream = model.invoke_stream, model.ainvoke_stream

    @wraps(invoke)
    def checked(*args, **kwargs):
        current()
        with provider_call(model, count_calls) as first:
            if first:
                record_model_call(model)
            result = invoke(*args, **kwargs)
        current()
        return result

    @wraps(ainvoke)
    async def achecked(*args, **kwargs):
        await asyncio.to_thread(current)
        with provider_call(model, count_calls) as first:
            if first:
                await arecord_model_call(model)
            result = await ainvoke(*args, **kwargs)
        await asyncio.to_thread(current)
        return result

    @wraps(invoke_stream)
    def stream(*args, **kwargs):
        current()
        with provider_call(model, count_calls) as first:
            if first:
                record_model_call(model)
            yield from invoke_stream(*args, **kwargs)
        current()

    @wraps(ainvoke_stream)
    async def astream(*args, **kwargs):
        await asyncio.to_thread(current)
        with provider_call(model, count_calls) as first:
            if first:
                await arecord_model_call(model)
            async for chunk in ainvoke_stream(*args, **kwargs):
                yield chunk
        await asyncio.to_thread(current)

    model.invoke, model.ainvoke = checked, achecked
    model.invoke_stream, model.ainvoke_stream = stream, astream
    return model
