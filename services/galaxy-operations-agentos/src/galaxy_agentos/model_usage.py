"""Count native provider invocations independently from per-model token totals."""
import asyncio
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
import inspect

from agno.run.concurrency import get_worker_ownership
from agno.run.status_persist import RunPersistOutcome

from .gateway import AuthorityDenied, AuthorityUnavailable


_RUN = ContextVar("galaxy_model_usage_run", default=None)
_ACTIVE = ContextVar("galaxy_model_usage_active", default=frozenset())


@contextmanager
def provider_call(model, enabled):
    active = _ACTIVE.get()
    first = enabled and id(model) not in active
    if not first:
        yield False
        return
    token = _ACTIVE.set(active | {id(model)})
    try:
        yield True
    finally:
        _ACTIVE.reset(token)


def install_usage_scope(model):
    if getattr(model, "_galaxy_usage_scope_installed", False):
        return
    model._galaxy_usage_scope_installed = True
    response, aresponse = model.response, model.aresponse
    response_stream, aresponse_stream = model.response_stream, model.aresponse_stream

    @wraps(response)
    def call(*args, **kwargs):
        token = _RUN.set(kwargs.get("run_response"))
        try:
            return response(*args, **kwargs)
        finally:
            _RUN.reset(token)

    @wraps(aresponse)
    async def acall(*args, **kwargs):
        token = _RUN.set(kwargs.get("run_response"))
        try:
            return await aresponse(*args, **kwargs)
        finally:
            _RUN.reset(token)

    @wraps(response_stream)
    def stream(*args, **kwargs):
        token = _RUN.set(kwargs.get("run_response"))
        try:
            yield from response_stream(*args, **kwargs)
        finally:
            _RUN.reset(token)

    @wraps(aresponse_stream)
    async def astream(*args, **kwargs):
        token = _RUN.set(kwargs.get("run_response"))
        try:
            async for event in aresponse_stream(*args, **kwargs):
                yield event
        finally:
            _RUN.reset(token)

    model.response, model.aresponse = call, acall
    model.response_stream, model.aresponse_stream = stream, astream


def _begin(model):
    run = _RUN.get()
    if run is None:
        return None
    before = run.metadata
    previous = (before or {}).get("modelCalls")
    count = previous if type(previous) is int and previous >= 0 else 0
    run.metadata = {**(before or {}), "modelCalls": count + 1}
    db = getattr(model, "_galaxy_usage_database", None)
    method = getattr(db, "update_run_in_session", None)
    if not callable(method):
        # Explicit local SQLite tests and transient native agents retain the
        # counter in their RunOutput. Production task DBs provide atomic CAS.
        return run, before, None, None
    ownership = get_worker_ownership(run.run_id)
    return run, before, method, {"session_id": run.session_id, "run_id": run.run_id,
        "user_id": run.user_id, "expected_attempt": ownership.attempt if ownership else None,
        "fields": {"metadata": dict(run.metadata)}}


def _finish(value, result):
    if result is True or result == RunPersistOutcome.UPDATED:
        return
    value[0].metadata = value[1]
    if result in {RunPersistOutcome.STALE_ATTEMPT, RunPersistOutcome.TERMINAL_REFUSED}:
        raise AuthorityDenied("agentos_model_call_attempt_changed")
    raise AuthorityUnavailable("agentos_model_call_metadata_unavailable")


def record_model_call(model):
    value = _begin(model)
    if value is None or value[2] is None:
        return
    try:
        _finish(value, value[2](**value[3]))
    except Exception:
        value[0].metadata = value[1]
        raise


async def arecord_model_call(model):
    value = _begin(model)
    if value is None or value[2] is None:
        return
    try:
        result = await value[2](**value[3]) if inspect.iscoroutinefunction(value[2]) else await asyncio.to_thread(value[2], **value[3])
        _finish(value, result)
    except Exception:
        value[0].metadata = value[1]
        raise
