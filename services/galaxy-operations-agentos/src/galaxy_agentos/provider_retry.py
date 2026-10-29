"""Retry one failed provider invocation without replaying the agent tool loop."""
import asyncio
import json
import time
from copy import deepcopy
from contextvars import ContextVar
from functools import wraps

from agno.exceptions import ModelProviderError

from .model_failover import provider_failure
from .model_usage import _RUN

_ACTIVE = ContextVar('galaxy_provider_retry_active', default=frozenset())


def gateway_transient_failure(error):
    if not isinstance(error, ModelProviderError):
        return None
    reported = getattr(error, 'status_code', None)
    if reported is not None and (type(reported) is not int or reported != 503):
        return None
    current = error
    for _ in range(5):
        body = getattr(current, 'body', None)
        if isinstance(body, dict):
            info = body.get('error', body)
            if (isinstance(info, dict) and set(info) == {'code', 'source', 'status', 'category', 'outputStarted'}
                    and info.get('code') == 'model_gateway_transient_failure'
                    and info.get('source') == 'model-gateway' and type(info.get('status')) is int
                    and info['status'] == 503 and info.get('category') == 'service-unavailable'
                    and info.get('outputStarted') is False):
                return {'status': 503, 'source': 'model-gateway'}
        current = getattr(current, '__cause__', None) or getattr(current, '__context__', None)
        if current is None:
            break
    return None


def _retryable(error):
    failure = provider_failure(error)
    if failure and (failure['status'] in (408, 429) or 500 <= failure['status'] <= 599):
        return failure
    return gateway_transient_failure(error)


def _snapshot(args, kwargs):
    args, kwargs = list(args), dict(kwargs)
    if args and isinstance(args[0], list):
        args[0] = deepcopy(args[0])
    if isinstance(kwargs.get('messages'), list):
        kwargs['messages'] = deepcopy(kwargs['messages'])
    return args, kwargs


def _assistant_snapshot(args, kwargs):
    assistant = kwargs.get('assistant_message')
    if assistant is None and len(args) > 1:
        assistant = args[1]
    copy = getattr(assistant, 'model_copy', None)
    return (assistant, copy(deep=True)) if callable(copy) else (None, None)


def _restore_assistant(snapshot):
    assistant, saved = snapshot
    if assistant is None:
        return
    # Preserve the SDK's object identity while discarding a failed request's
    # partial tool calls and timing fields. Never replace the enclosing run.
    for field in ('__dict__', '__pydantic_fields_set__', '__pydantic_extra__', '__pydantic_private__'):
        if hasattr(saved, field):
            object.__setattr__(assistant, field, deepcopy(getattr(saved, field)))


def _event(model, failure, kwargs):
    run = kwargs.get('run_response') or _RUN.get()
    if run is not None:
        metadata = run.metadata if isinstance(run.metadata, dict) else {}
        run.metadata = {**metadata, 'modelProviderRetry': {'attempts': 1, 'statuses': [failure['status']], 'sources': [failure['source']]}}
    print(json.dumps({'event': 'model-provider-retry', 'source': failure['source'], 'status': failure['status'],
        'attempt': 2, 'state': 'scheduled', 'runId': getattr(run, 'run_id', None), 'alias': model.id}), flush=True)


def _finished(kwargs, error=None):
    run = kwargs.get('run_response') or _RUN.get()
    if run is not None and isinstance(run.metadata, dict):
        info = run.metadata.get('modelProviderRetry')
        if isinstance(info, dict):
            failure = _retryable(error) if error is not None else None
            run.metadata = {**run.metadata, 'modelProviderRetry': {
                'attempts': 2, 'statuses': [*info['statuses'], *([failure['status'] if failure else None] if error is not None else [])],
                'sources': [*info['sources'], *([failure['source'] if failure else None] if error is not None else [])]}}


def with_provider_retry(model):
    # These methods already carry the current-authority and usage gates. Calling
    # each one again rechecks admission and counts the actual provider attempt.
    invoke, ainvoke = model.invoke, model.ainvoke
    invoke_stream, ainvoke_stream = model.invoke_stream, model.ainvoke_stream

    @wraps(invoke)
    def retry_invoke(*args, **kwargs):
        snapshot = _snapshot(args, kwargs)
        assistant = _assistant_snapshot(args, kwargs)
        try:
            first_args, first_kwargs = _snapshot(*snapshot)
            return invoke(*first_args, **first_kwargs)
        except ModelProviderError as original:
            failure = _retryable(original)
            if not failure:
                raise
            _event(model, failure, kwargs)
            time.sleep(0.25)
            _restore_assistant(assistant)
            try:
                result = invoke(*snapshot[0], **snapshot[1])
            except ModelProviderError as second:
                _finished(kwargs, second)
                raise
            _finished(kwargs)
            return result

    @wraps(ainvoke)
    async def retry_ainvoke(*args, **kwargs):
        snapshot = _snapshot(args, kwargs)
        assistant = _assistant_snapshot(args, kwargs)
        try:
            first_args, first_kwargs = _snapshot(*snapshot)
            return await ainvoke(*first_args, **first_kwargs)
        except ModelProviderError as original:
            failure = _retryable(original)
            if not failure:
                raise
            _event(model, failure, kwargs)
            await asyncio.sleep(0.25)
            _restore_assistant(assistant)
            try:
                result = await ainvoke(*snapshot[0], **snapshot[1])
            except ModelProviderError as second:
                _finished(kwargs, second)
                raise
            _finished(kwargs)
            return result

    @wraps(invoke_stream)
    def retry_stream(*args, **kwargs):
        snapshot, emitted = _snapshot(args, kwargs), False
        assistant = _assistant_snapshot(args, kwargs)
        try:
            first_args, first_kwargs = _snapshot(*snapshot)
            for chunk in invoke_stream(*first_args, **first_kwargs):
                emitted = True
                yield chunk
        except ModelProviderError as original:
            failure = _retryable(original)
            if emitted or not failure:
                raise
            _event(model, failure, kwargs)
            time.sleep(0.25)
            _restore_assistant(assistant)
            try:
                yield from invoke_stream(*snapshot[0], **snapshot[1])
            except ModelProviderError as second:
                _finished(kwargs, second)
                raise
            _finished(kwargs)

    @wraps(ainvoke_stream)
    async def retry_astream(*args, **kwargs):
        snapshot, emitted = _snapshot(args, kwargs), False
        assistant = _assistant_snapshot(args, kwargs)
        try:
            first_args, first_kwargs = _snapshot(*snapshot)
            async for chunk in ainvoke_stream(*first_args, **first_kwargs):
                emitted = True
                yield chunk
        except ModelProviderError as original:
            failure = _retryable(original)
            if emitted or not failure:
                raise
            _event(model, failure, kwargs)
            await asyncio.sleep(0.25)
            _restore_assistant(assistant)
            try:
                async for chunk in ainvoke_stream(*snapshot[0], **snapshot[1]):
                    yield chunk
            except ModelProviderError as second:
                _finished(kwargs, second)
                raise
            _finished(kwargs)

    @wraps(invoke)
    def checked(*args, **kwargs):
        active = _ACTIVE.get()
        if id(model) in active:
            return invoke(*args, **kwargs)
        token = _ACTIVE.set(active | {id(model)})
        try:
            return retry_invoke(*args, **kwargs)
        finally:
            _ACTIVE.reset(token)

    @wraps(ainvoke)
    async def achecked(*args, **kwargs):
        active = _ACTIVE.get()
        if id(model) in active:
            return await ainvoke(*args, **kwargs)
        token = _ACTIVE.set(active | {id(model)})
        try:
            return await retry_ainvoke(*args, **kwargs)
        finally:
            _ACTIVE.reset(token)

    @wraps(invoke_stream)
    def stream(*args, **kwargs):
        active = _ACTIVE.get()
        if id(model) in active:
            yield from invoke_stream(*args, **kwargs)
            return
        token = _ACTIVE.set(active | {id(model)})
        try:
            yield from retry_stream(*args, **kwargs)
        finally:
            _ACTIVE.reset(token)

    @wraps(ainvoke_stream)
    async def astream(*args, **kwargs):
        active = _ACTIVE.get()
        if id(model) in active:
            async for chunk in ainvoke_stream(*args, **kwargs):
                yield chunk
            return
        token = _ACTIVE.set(active | {id(model)})
        try:
            async for chunk in retry_astream(*args, **kwargs):
                yield chunk
        finally:
            _ACTIVE.reset(token)

    model.invoke, model.ainvoke = checked, achecked
    model.invoke_stream, model.ainvoke_stream = stream, astream
    return model
