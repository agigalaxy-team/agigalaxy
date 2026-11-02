"""Project persisted duty facts and optional fresh progress into the common loop."""
from .task_loop import TaskDecision, response_requires_continuation, with_task_loop


class DutyCompletionIncomplete(RuntimeError):
    pass


def with_duty_completion(model, gateway, progress, round_seconds):
    def decide(run):
        if not run.user_id:
            raise DutyCompletionIncomplete("agentos_autonomy_completion_context_missing")
        completion = (gateway.duty_authorize(run.user_id, operation="run").get("task") or {}).get("completion") or {}
        updates = progress[:]
        progress.clear()
        disposition = completion.get("disposition")
        states = {"waiting-human": "waiting-human", "unknown": "waiting-result", "failed": "failed", "continue": "waiting-result"}
        if disposition in states:
            return TaskDecision(state=states[disposition], reason=str(completion.get("reasonCode") or ""))
        if response_requires_continuation():
            return TaskDecision(state="continue", reason="继续尚未输出的内容")
        # A persisted assessment is current only until the next actual tool
        # call. A previous response or resumed attempt must never force a loop.
        assessment = completion.get("modelAssessment")
        if updates and assessment == updates[-1] and assessment.get("goalSatisfied") is False:
            remaining = tuple(item["description"] for item in assessment.get("remainingWork", [])
                if isinstance(item, dict) and isinstance(item.get("description"), str))
            if remaining and disposition == "completed":
                return TaskDecision(state="continue", remaining=remaining)
        return TaskDecision()

    return with_task_loop(model, decide=decide, timeout_seconds=round_seconds)
