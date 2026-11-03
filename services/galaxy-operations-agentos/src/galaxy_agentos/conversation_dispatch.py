"""Workbench work requests; scheduling stays in the durable business service."""
from typing import Annotated, Literal, Union
from uuid import UUID

from agno.run.base import RunContext
from agno.tools.function import FunctionCall
from pydantic import BaseModel, ConfigDict, Field


class Trigger(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Once(Trigger):
    kind: Literal["once"]


class Interval(Trigger):
    kind: Literal["interval"]
    minutes: int = Field(ge=1)


class Daily(Trigger):
    kind: Literal["daily"]
    at: str = Field(pattern=r"^(?:[01][0-9]|2[0-3]):[0-5][0-9]$")


class Event(Trigger):
    kind: Literal["event"]
    eventTypes: list[str] = Field(min_length=1)


TaskTrigger = Annotated[Union[Once, Interval, Daily, Event], Field(discriminator="kind")]


def dispatch_tools(send):
    def request_task(run_context: RunContext, fc: FunctionCall,
            target_domain: Literal["overview", "governance", "messaging", "discovery", "maintenance"],
            title: str, goal: str, trigger: TaskTrigger,
            start_now: bool = True, mode: Literal["ai", "ai-human"] = "ai-human",
            actions: list[str] | None = None, grant_ids: list[UUID] | None = None,
            resource_ids: list[UUID] | None = None, strategy_ids: list[UUID] | None = None) -> str:
        """Prepare a real task-assignment card for any supported operations goal.

        Use once for one background task, interval/daily for recurring work, or
        event for supported business events. The task is independent of routine
        position settings; it does not edit role prompts, models or permissions.
        The manager confirms the card in this chat before scheduling starts.
        Preparation is NOT assignment success: report waiting for confirmation.
        After confirmation, use read_dispatched_task with the actual dispatchId
        from its receipt. Scheduling success is distinct from a completed round.
        Omitted actions/grants make this a read/analysis task. For write actions,
        select actual existing grants, published strategies and targets as required
        by that business action; this request grants no rights.
        Preserve the user's goal, timing and human conditions; no fixed task
        template or round count is required. An observation period does not
        imply canceling or disabling the assignment at its end.
        """
        return send(run_context, fc, "prepare-operation", {
            "kind": "task-dispatch", "targetDomain": target_domain,
            "title": title, "goal": goal, "trigger": trigger.model_dump(mode="json"),
            "startNow": start_now, "mode": mode, "actions": actions or [],
            "grantIds": [str(v) for v in grant_ids or []],
            "resourceIds": [str(v) for v in resource_ids or []],
            "strategyIds": [str(v) for v in strategy_ids or []]})

    def read_dispatched_task(run_context: RunContext, fc: FunctionCall,
            dispatch_id: UUID) -> str:
        """Read the actual assignment switch, next due time and latest task state.

        Use its real ID from the confirmed card receipt. This is read-only and
        never starts, resumes, retries or cancels a task. Completed model output
        alone is not proof that a business operation or future round completed.
        """
        return send(run_context, fc, "read-dispatched-task", {"dispatchId": str(dispatch_id)})

    return [request_task, read_dispatched_task]
