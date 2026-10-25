"""Count native provider invocations independently from per-model token totals."""
import asyncio
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
import inspect
import re

from agno.run.concurrency import get_worker_ownership
from agno.run.status_persist import RunPersistOutcome

from .gateway import AuthorityDenied, AuthorityUnavailable


_RUN = ContextVar("galaxy_model_usage_run", default=None)
_ACTIVE = ContextVar("galaxy_model_usage_active", default=frozenset())
_SETTINGS_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")


def _valid_settings_version(value):
    return isinstance(value, str) and _SETTINGS_VERSION.fullmatch(value) is not None


def _record_settings_version(metadata, model):
    # This is the exact model instance about to be invoked. Reading the
    # current global configuration here would relabel a previously selected
    # model (or an old run) with a configuration it did not use.
    previous = metadata.get("modelSettingsVersions")
    versions = []
    for value in [*(previous if isinstance(previous, list) else []), metadata.get("modelSettingsVersion")]:
        if _valid_settings_version(value) and value not in versions:
            versions.append(value)
    selected = getattr(model, "_galaxy_settings_version", None)
    if _valid_settings_version(selected):
        metadata["modelSettingsVersion"] = selected
        if selected not in versions:
            versions.append(selected)
    else:
        # A versionless invocation is unknown, even after a known version.
        # Keep only previously recorded known versions, with no fake default.
        metadata.pop("modelSettingsVersion", None)
    if versions:
        metadata["modelSettingsVersions"] = versions
    else:
        metadata.pop("modelSettingsVersions", None)


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
    _record_settings_version(run.metadata, model)
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
