"""Bind native regeneration to its new attempt without appending user input."""
import asyncio
import inspect
from copy import deepcopy
from functools import wraps
from agno.agent import Agent
from agno.tools.function import Function
# Agno is locked to 3.1.7. Keep its regenerate checkpoint/fork semantics in
# this compatibility boundary, before its background wrapper saves a run or
# builds a RunContext. The SDK otherwise saves the parent ID before forking.
from agno.agent._run import _find_regenerate_checkpoint, _fork_run
from .gateway import AuthorityDenied
from .conversation_turn_state import (bind_turn_state, TURN_STATE, PLAN, ASSESSMENT, ACTIVITY,
    PREPARED_CARD_IDS, PREPARED_FINGERPRINTS, PREPARE_UNKNOWN, RECEIPT_FEEDBACK, TASK_PROGRESS, TASK_CONTEXT)

_ATTEMPT_FIELDS = frozenset({"modelCalls", "modelSettingsVersion", "modelSettingsVersions",
    "modelFallbacks", "activeModelFallbackAlias", "toolRecovery", "rolePromptVersion",
    "boundaryVersion", "compactionStatus", "toolCompressionStatus", "_galaxyConversationCallReferences",
    TURN_STATE, PLAN, ASSESSMENT, ACTIVITY, PREPARED_CARD_IDS, PREPARED_FINGERPRINTS, PREPARE_UNKNOWN, RECEIPT_FEEDBACK, TASK_PROGRESS, TASK_CONTEXT})

class ConversationAgent(Agent):
    def get_tools(self, run_response, run_context, session, user_id=None):
        from .conversation_compaction import bind_run
        loader = getattr(self, "_galaxy_authorized_run", None)
        if loader is not None: loader(run_context)
        bind_run(run_response, run_context)
        bind_turn_state(run_response, run_context)
        return super().get_tools(run_response, run_context, session, user_id=user_id)

    async def aget_tools(self, run_response, run_context, session, user_id=None, check_mcp_tools=True):
        from .conversation_compaction import bind_run
        loader = getattr(self, "_galaxy_authorized_run", None)
        if loader is not None: await asyncio.to_thread(loader, run_context)
        bind_run(run_response, run_context)
        bind_turn_state(run_response, run_context)
        tools = await super().aget_tools(run_response, run_context, session, user_id=user_id,
            check_mcp_tools=check_mcp_tools)
        def offload(entrypoint):
            @wraps(entrypoint)
            async def invoke(*args, **kwargs):
                return await asyncio.to_thread(entrypoint, *args, **kwargs)
            return invoke
        result = []
        for tool in tools:
            entrypoint = tool.entrypoint if isinstance(tool, Function) else None
            if (callable(entrypoint) and not inspect.iscoroutinefunction(entrypoint)
                    and not inspect.isgeneratorfunction(entrypoint) and not inspect.isasyncgenfunction(entrypoint)):
                tool = tool.model_copy()
                tool.entrypoint = offload(entrypoint)
            result.append(tool)
        return result

    def _retry_source(self, run_response, options):
        metadata = options.get("metadata")
        if not options.get("regenerate") or not isinstance(metadata, dict) or not metadata.get("retryOfRunId"):
            return run_response
        ident = options.get("run_id") or getattr(run_response, "run_id", None)
        original = run_response if run_response is not None else self.db.get_run(run_id=ident)
        status = getattr(getattr(original, "status", None), "value", getattr(original, "status", None))
        if (original is None or str(status).upper() != "ERROR" or ident != metadata["retryOfRunId"]
                or getattr(original, "run_id", None) != ident
                or getattr(original, "agent_id", None) != self.id
                or getattr(original, "user_id", None) != options.get("user_id")
                or getattr(original, "session_id", None) != options.get("session_id")
                or (getattr(original, "metadata", None) or {}).get("operationId") != metadata.get("retryOfOperationId")):
            raise AuthorityDenied("agentos_conversation_retry_denied")
        # Fork before entering the native background continuation. Passing the
        # parent's ID with this attempt's metadata lets that wrapper overwrite
        # the failed row, and leaves the tool RunContext bound to the parent.
        # The native checkpoint retains any surviving tool exchanges rather
        # than turning regenerate into a second copy of the user's question.
        # Its event reset also drops this parent's authorization observations;
        # the new attempt still passes through the current authority wrappers.
        selected = _fork_run(original, _find_regenerate_checkpoint(original))
        selected.regenerated_from = original.run_id
        selected.metadata = deepcopy({**{key:value for key,value in (original.metadata or {}).items()
            if key not in _ATTEMPT_FIELDS}, **metadata})
        # This already is the independent attempt. Continue it through the
        # public SDK API without a second fork or a REGENERATED parent write.
        options.update(run_id=selected.run_id, regenerate=False, fork=False,
            replace_original=None, continue_from="end", metadata=deepcopy(selected.metadata))
        return selected

    def continue_run(self, run_response=None, **options):
        return super().continue_run(self._retry_source(run_response, options), **options)

    def acontinue_run(self, run_response=None, **options):
        method = super().acontinue_run
        if options.get("stream", self.stream):
            async def events():
                selected = await asyncio.to_thread(self._retry_source, run_response, options)
                async for event in method(selected, **options):
                    yield event
            return events()
        async def result():
            selected = await asyncio.to_thread(self._retry_source, run_response, options)
            return await method(selected, **options)
        return result()
