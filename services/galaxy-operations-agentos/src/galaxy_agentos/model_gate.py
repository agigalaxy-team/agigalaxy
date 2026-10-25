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
        current()
        with provider_call(model, count_calls) as first:
            if first:
                await arecord_model_call(model)
            result = await ainvoke(*args, **kwargs)
        current()
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
        current()
        with provider_call(model, count_calls) as first:
            if first:
                await arecord_model_call(model)
            async for chunk in ainvoke_stream(*args, **kwargs):
                yield chunk
        current()

    model.invoke, model.ainvoke = checked, achecked
    model.invoke_stream, model.ainvoke_stream = stream, astream
    return model
