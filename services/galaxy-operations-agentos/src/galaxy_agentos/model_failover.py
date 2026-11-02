"""Bounded provider failover at the SDK invocation, never whole-task replay.

Reuse Agno models and history; unlike Agno's response-level fallback, this
boundary cannot restart a completed tool loop. Galaxy denials do not qualify.
"""
import json
import re
from copy import deepcopy
from functools import wraps
from agno.exceptions import ModelProviderError
from agno.models.response import ModelResponse
from .task_loop import observe_provider, _start_provider_request

STATUSES=frozenset({401,402,403,408,429,*range(500,600)})

def failover_view(metadata):
    rows=metadata.get('modelFallbacks',[]) if isinstance(metadata,dict) else []
    if not isinstance(rows,list):return []
    return [{'from':row['from'],'to':row['to'],'status':row['status']} for row in rows[-16:]
        if isinstance(row,dict) and row.get('source')=='provider' and row.get('status') in STATUSES
        and all(isinstance(row.get(key),str) and re.fullmatch(r'galaxy-[a-z0-9][a-z0-9_-]{0,62}',row[key]) for key in ['from','to'])]


def provider_failure(error):
    if not isinstance(error,ModelProviderError):return None
    reported=getattr(error,'status_code',None)
    if reported is not None and reported not in STATUSES:return None
    current=error
    for _ in range(5):
        body=getattr(current,'body',None)
        if isinstance(body,dict):
            info=body.get('error',body)
            if isinstance(info,dict) and info.get('source')=='provider' and info.get('code')=='model_gateway_request_failed':
                # A failed SSE frame arrives after HTTP 200. The native SDK
                # keeps its closed gateway error body, but no HTTP status.
                status=reported if reported is not None else info.get('status')
                return {'status':status,'source':'provider'} if type(status) is int and status in STATUSES else None
        current=getattr(current,'__cause__',None) or getattr(current,'__context__',None)
        if current is None:break
    return None


def _event(primary,backup,failure,state,run=None):
    print(json.dumps({'event':'model-failover','primaryAlias':primary.id,'fallbackAlias':backup.id,
        'status':failure['status'],'source':'provider','state':state,'runId':getattr(run,'run_id',None)}),flush=True)
    if state=='completed' and run is not None:
        metadata=run.metadata if isinstance(run.metadata,dict) else {}
        rows=metadata.get('modelFallbacks',[])
        run.metadata={**metadata,'activeModelFallbackAlias':backup.id,'modelFallbacks':[
            *(rows[-15:] if isinstance(rows,list) else []),{'from':primary.id,'to':backup.id,'status':failure['status'],'source':'provider'}]}



def _useful_stream_delta(chunk):
    """Only actual output bars fallback; usage and metadata are not output."""
    if not isinstance(chunk, ModelResponse):
        # Unknown output is treated conservatively: it may already be visible.
        return bool(chunk)
    return any(getattr(chunk, name, None) for name in (
        "content", "reasoning_content", "redacted_reasoning_content", "tool_calls",
        "audio", "images", "videos", "audios", "files", "parsed"))


def with_model_failover(primary,backups):
    if not backups:return primary
    if len(backups)>3 or len({model.id for model in [primary,*backups]})!=len(backups)+1:raise ValueError('agentos_model_fallback_invalid')
    for backup in backups:
        observe_provider(backup)
    invoke,ainvoke=primary.invoke,primary.ainvoke
    invoke_stream,ainvoke_stream=primary.invoke_stream,primary.ainvoke_stream

    def order(kwargs):
        run=kwargs.get('run_response');metadata=getattr(run,'metadata',None)
        active=metadata.get('activeModelFallbackAlias') if isinstance(metadata,dict) else None
        index=next((i for i,model in enumerate(backups) if model.id==active),None)
        return (primary,backups) if index is None else (backups[index],backups[index+1:])

    def seed(args,kwargs):
        fresh_args=list(args);fresh_kwargs=dict(kwargs)
        if fresh_args and isinstance(fresh_args[0],list):fresh_args[0]=deepcopy(fresh_args[0])
        if isinstance(fresh_kwargs.get('messages'),list):fresh_kwargs['messages']=deepcopy(fresh_kwargs['messages'])
        return fresh_args,fresh_kwargs

    @wraps(invoke)
    def checked(*args,**kwargs):
        first,remaining=order(kwargs);snapshot=seed(args,kwargs)
        _start_provider_request()
        try:return (invoke if first is primary else first.invoke)(*args,**kwargs)
        except ModelProviderError as original:
            failure=provider_failure(original)
            if not failure:raise
            for backup in remaining:
                _event(first,backup,failure,'attempting',kwargs.get('run_response'))
                _start_provider_request()
                try:
                    fresh_args,fresh_kwargs=seed(*snapshot)
                    result=backup.invoke(*fresh_args,**fresh_kwargs);_event(first,backup,failure,'completed',kwargs.get('run_response'));return result
                except ModelProviderError as error:
                    if not provider_failure(error):raise
                    _event(first,backup,provider_failure(error),'failed',kwargs.get('run_response'))
            raise original

    @wraps(ainvoke)
    async def achecked(*args,**kwargs):
        first,remaining=order(kwargs);snapshot=seed(args,kwargs)
        _start_provider_request()
        try:return await (ainvoke if first is primary else first.ainvoke)(*args,**kwargs)
        except ModelProviderError as original:
            failure=provider_failure(original)
            if not failure:raise
            for backup in remaining:
                _event(first,backup,failure,'attempting',kwargs.get('run_response'))
                _start_provider_request()
                try:
                    fresh_args,fresh_kwargs=seed(*snapshot)
                    result=await backup.ainvoke(*fresh_args,**fresh_kwargs);_event(first,backup,failure,'completed',kwargs.get('run_response'));return result
                except ModelProviderError as error:
                    if not provider_failure(error):raise
                    _event(first,backup,provider_failure(error),'failed',kwargs.get('run_response'))
            raise original

    @wraps(invoke_stream)
    def stream(*args,**kwargs):
        first,remaining=order(kwargs);snapshot=seed(args,kwargs)
        _start_provider_request()
        emitted=False
        try:
            for chunk in (invoke_stream if first is primary else first.invoke_stream)(*args,**kwargs):
                emitted = emitted or _useful_stream_delta(chunk)
                yield chunk
            return
        except ModelProviderError as original:
            failure=provider_failure(original)
            if emitted or not failure:raise
            for backup in remaining:
                _event(first,backup,failure,'attempting',kwargs.get('run_response'))
                _start_provider_request()
                emitted=False
                try:
                    fresh_args,fresh_kwargs=seed(*snapshot)
                    for chunk in backup.invoke_stream(*fresh_args,**fresh_kwargs):
                        emitted = emitted or _useful_stream_delta(chunk)
                        yield chunk
                    _event(first,backup,failure,'completed',kwargs.get('run_response'))
                    return
                except ModelProviderError as error:
                    if emitted or not provider_failure(error):raise
                    _event(first,backup,provider_failure(error),'failed',kwargs.get('run_response'))
            raise original

    @wraps(ainvoke_stream)
    async def astream(*args,**kwargs):
        first,remaining=order(kwargs);snapshot=seed(args,kwargs)
        _start_provider_request()
        emitted=False
        try:
            async for chunk in (ainvoke_stream if first is primary else first.ainvoke_stream)(*args,**kwargs):
                emitted = emitted or _useful_stream_delta(chunk)
                yield chunk
            return
        except ModelProviderError as original:
            failure=provider_failure(original)
            if emitted or not failure:raise
            for backup in remaining:
                _event(first,backup,failure,'attempting',kwargs.get('run_response'))
                _start_provider_request()
                emitted=False
                try:
                    fresh_args,fresh_kwargs=seed(*snapshot)
                    async for chunk in backup.ainvoke_stream(*fresh_args,**fresh_kwargs):
                        emitted = emitted or _useful_stream_delta(chunk)
                        yield chunk
                    _event(first,backup,failure,'completed',kwargs.get('run_response'))
                    return
                except ModelProviderError as error:
                    if emitted or not provider_failure(error):raise
                    _event(first,backup,provider_failure(error),'failed',kwargs.get('run_response'))
            raise original

    primary.invoke,primary.ainvoke=checked,achecked
    primary.invoke_stream,primary.ainvoke_stream=stream,astream
    return primary
