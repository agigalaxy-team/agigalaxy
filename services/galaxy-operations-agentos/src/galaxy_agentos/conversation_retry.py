"""Bind native regeneration to its new attempt without appending user input."""
import asyncio
from copy import deepcopy
from agno.agent import Agent
from .gateway import AuthorityDenied

_ATTEMPT_FIELDS = frozenset({"modelCalls", "modelSettingsVersion", "modelSettingsVersions",
    "modelFallbacks", "activeModelFallbackAlias", "toolRecovery", "rolePromptVersion",
    "boundaryVersion", "_galaxyConversationCallReferences"})

class ConversationAgent(Agent):
    def _retry_source(self, run_response, options):
        metadata = options.get("metadata")
        if not options.get("regenerate") or not isinstance(metadata, dict) or not metadata.get("retryOfRunId"):
            return run_response
        ident = options.get("run_id") or getattr(run_response, "run_id", None)
        original = run_response if run_response is not None else self.db.get_run(run_id=ident)
        status = getattr(getattr(original, "status", None), "value", getattr(original, "status", None))
        if (original is None or str(status).upper() != "ERROR" or ident != metadata["retryOfRunId"]
                or getattr(original, "user_id", None) != options.get("user_id")
                or getattr(original, "session_id", None) != options.get("session_id")
                or (getattr(original, "metadata", None) or {}).get("operationId") != metadata.get("retryOfOperationId")):
            raise AuthorityDenied("agentos_conversation_retry_denied")
        selected = deepcopy(original)
        # Agno forks the original RunOutput for regeneration. Its output object
        # otherwise retains old metadata even when the new RunContext uses the
        # caller's metadata. Bind both to this server-approved attempt first.
        selected.metadata = {**{key:value for key,value in (original.metadata or {}).items()
            if key not in _ATTEMPT_FIELDS}, **metadata}
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
