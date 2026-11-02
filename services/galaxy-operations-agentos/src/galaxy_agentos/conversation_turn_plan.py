"""Turn planning and bounded self-assessment; neither grants business authority."""
import json
from typing import Literal, Annotated
from pydantic import Field
from agno.run.base import RunContext
from agno.tools.function import FunctionCall

from .conversation_turn_state import turn_state, PLAN, ASSESSMENT, ACTIVITY, TASK_PROGRESS

def plan_turn_tool(send):
    def plan_turn(run_context: RunContext, fc: FunctionCall,
            intent: Literal["answer", "prepare"], proposal_count: Literal[1, 3],
            alternatives: bool, summary: Annotated[str, Field(max_length=240)],
            read_count: Annotated[int, Field(ge=1,le=100)] | None = None) -> str:
        """Declare the current user request before preparing; three is for alternatives only, not authority.

        For a choice such as option 2, continue the selected prior proposal without asking again.
        Three proposals means distinct alternatives, each needing separate human confirmation.
        The preparation tool schema becomes available after an accepted prepare plan.
        An answer plan covers reads and analysis; it need not be repeated for each read.
        For a request to read a stated number of distinct views, set read_count to
        that requested total, not tool calls or model rounds. Completion is checked
        against successful distinct view receipts. Omit for other requests.
        """
        if proposal_count == 3 and (intent != "prepare" or not alternatives):
            return json.dumps({"state":"invalid-request", "reason":"three_requires_alternatives", "effectExecuted":False})
        arguments={"intent":intent, "proposalCount":proposal_count,"alternatives":alternatives,"summary":summary}
        if read_count is not None: arguments["readCount"]=read_count
        result = send(run_context, fc, "plan-conversation-turn", arguments)
        try:
            value = json.loads(result)
            plan = value.get("turnPlan")
            if isinstance(plan, dict) and plan.get("intent") == intent and plan.get("proposalCount") == proposal_count and plan.get("alternatives") is alternatives:
                turn_state(run_context)[PLAN] = plan
        except (TypeError, ValueError, AttributeError):
            pass
        return result
    return plan_turn

def assess_turn_tool(send):
    def assess_turn(run_context: RunContext, fc: FunctionCall,
            disposition: Literal["continue", "completed", "awaiting-confirmation", "needs-information", "waiting-result", "blocked", "interrupted"],
            reason: Annotated[str, Field(max_length=2000)],
            remaining: Annotated[list[Annotated[str, Field(min_length=1, max_length=1000)]], Field(max_length=40)]) -> str:
        """Record the original task's next state; model completion is not business completion.

        Complete only with no remaining work. A real prepared card waits for human confirmation.
        A pending original operation waits for its result; unknown writes are never replayed.
        """
        turn_state(run_context).pop(ASSESSMENT, None)
        if disposition == "completed" and remaining:
            return json.dumps({"state":"invalid-request", "reason":"remaining-work-not-empty",
                "nextStep":"correct-assessment", "message":"尚有未完成工作，不能评估为完成。"},ensure_ascii=False)
        result = send(run_context, fc, "assess-conversation-task", {"disposition":disposition,"reason":reason,"remaining":remaining})
        try:
            value = json.loads(result)
            progress = value.get("taskProgress")
            phases = {"continue", "completed", "waiting-confirmation", "needs-information", "waiting-result", "blocked", "interrupted"}
            if (value.get("state") in {"recorded", "needs-continuation"} and isinstance(progress, dict)
                    and progress.get("phase") in phases and isinstance(progress.get("remaining"), list)
                    and all(isinstance(item, str) for item in progress["remaining"])
                    and not (progress.get("phase") == "completed" and progress["remaining"])):
                state = turn_state(run_context)
                state[TASK_PROGRESS] = progress
                state[ASSESSMENT] = {"disposition":progress["phase"], "reason":reason,
                    "remaining":progress["remaining"], "activity":state.get(ACTIVITY, 0)}
                return json.dumps({"state":value["state"], **({"readCoverage":value["readCoverage"]} if isinstance(value.get("readCoverage"),dict) else {}), "taskProgress":{
                    "phase":progress["phase"], "remaining":progress["remaining"],
                    "reason":progress.get("reason")}},ensure_ascii=False)
        except (TypeError, ValueError, AttributeError):
            pass
        return result
    return assess_turn
