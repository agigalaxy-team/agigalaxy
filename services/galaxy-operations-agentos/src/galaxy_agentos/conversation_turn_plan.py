"""Turn planning and bounded self-assessment; neither grants business authority."""
import json
from typing import Literal, Annotated
from pydantic import Field
from agno.run.base import RunContext
from agno.tools.function import FunctionCall

PLAN = "_galaxyTurnPlan"
ASSESSMENT = "_galaxyTurnAssessment"
ACTIVITY = "_galaxyTurnActivity"

def plan_turn_tool(send):
    def plan_turn(run_context: RunContext, fc: FunctionCall,
            intent: Literal["answer", "prepare"], proposal_count: Literal[1, 3],
            alternatives: bool, summary: Annotated[str, Field(max_length=240)]) -> str:
        """Declare the current user request before preparing; three is for alternatives only, not authority.

        For a choice such as option 2, continue the selected prior proposal without asking again.
        Three proposals means distinct alternatives, each needing separate human confirmation.
        """
        if proposal_count == 3 and (intent != "prepare" or not alternatives):
            return json.dumps({"state":"invalid-request", "reason":"three_requires_alternatives", "effectExecuted":False})
        result = send(run_context, fc, "plan-conversation-turn", {"intent":intent, "proposalCount":proposal_count,
            "alternatives":alternatives, "summary":summary})
        try:
            value = json.loads(result)
            plan = value.get("turnPlan")
            if isinstance(plan, dict) and plan.get("intent") == intent and plan.get("proposalCount") == proposal_count and plan.get("alternatives") is alternatives:
                if run_context.metadata is None: run_context.metadata = {}
                run_context.metadata[PLAN] = plan
        except (TypeError, ValueError, AttributeError):
            pass
        return result
    return plan_turn

def assess_turn_tool():
    def assess_turn(run_context: RunContext, fc: FunctionCall,
            disposition: Literal["completed", "awaiting-confirmation", "needs-information", "blocked"],
            reason: Annotated[str, Field(max_length=240)],
            remaining: Annotated[list[Annotated[str, Field(max_length=240)]], Field(max_length=8)]) -> str:
        """Assess this turn after tools; a prepared card waits for a human, not business completion."""
        if run_context.metadata is None: run_context.metadata = {}
        run_context.metadata[ASSESSMENT] = {"disposition": disposition, "reason":reason,
            "remaining": remaining, "activity": run_context.metadata.get(ACTIVITY, 0)}
        return json.dumps({"state":"recorded", "disposition":disposition}, ensure_ascii=False)
    return assess_turn
