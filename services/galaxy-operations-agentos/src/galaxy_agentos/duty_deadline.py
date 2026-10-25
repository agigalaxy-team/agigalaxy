"""Per-task deadline around the existing Agno execution, never another worker."""
import asyncio
from contextlib import suppress

from agno.agent import Agent
from agno.run.concurrency import set_cancellation_cause


MAX_ROUND_SECONDS = 3600


class DutyRoundTimeout(RuntimeError):
    pass


async def await_duty_deadline(execution, *, run_id, seconds):
    task = asyncio.ensure_future(execution)
    try:
        done, _ = await asyncio.wait({task}, timeout=seconds)
    except asyncio.CancelledError:
        # Preserve the worker's already stamped drain/user cause.
        task.cancel()
        with suppress(Exception, asyncio.CancelledError):
            await task
        raise
    if task not in done:
        # Native foreground cancellation persistence consults this registry.
        # Stamp before cancel so its CANCELLED write cannot race the worker's
        # attempt-fenced terminal ERROR. max_attempts remains one.
        if run_id:
            set_cancellation_cause(run_id, "timeout")
        task.cancel()
        with suppress(Exception, asyncio.CancelledError):
            await task
        raise DutyRoundTimeout("agentos_autonomy_round_timeout")
    return task.result()


class DutyAgent(Agent):
    def __init__(self, *, round_seconds, current_task, **kwargs):
        super().__init__(**kwargs)
        self.round_seconds = round_seconds
        self.current_task = current_task

    def arun(self, *args, **kwargs):
        # The closed duty HTTP seam always submits non-streaming durable runs.
        # A future stream/inline path must add its own bounded contract first.
        if kwargs.get("stream") or kwargs.get("background"):
            raise ValueError("agentos_autonomy_durable_run_required")
        execution = super().arun(*args, **kwargs)
        return await_duty_deadline(execution, run_id=kwargs.get("run_id"), seconds=self.round_seconds)

    def acontinue_run(self, *args, **kwargs):
        if args or kwargs.get("stream") or kwargs.get("background") or kwargs.get("fork") or kwargs.get("regenerate"):
            raise ValueError("agentos_autonomy_durable_continue_required")
        from agno.models.response import ToolExecution
        from agno.run.requirement import RunRequirement
        from .duty_continuation import continuation_tools, rehydrate_paused
        user_id, run_id = kwargs.get("user_id"), kwargs.get("run_id")
        task = self.current_task(user_id)
        original = self.get_run_output(run_id, session_id=kwargs.get("session_id"), user_id=user_id)
        tools = continuation_tools(task, original)
        kwargs["run_response"] = rehydrate_paused(original, task=task, instructions=self.instructions, tools=tools, model_metadata=self.metadata)
        # Discard any stale queued requirements. Claim-time Node facts win;
        # no confirmation flag can cause Agno to rerun the original writer.
        kwargs["requirements"] = [RunRequirement(tool_execution=ToolExecution.from_dict(tool)) for tool in tools]
        execution = super().acontinue_run(**kwargs)
        return await_duty_deadline(execution, run_id=run_id, seconds=self.round_seconds)
