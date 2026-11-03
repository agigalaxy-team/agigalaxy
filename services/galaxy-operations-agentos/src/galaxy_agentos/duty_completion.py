"""Project persisted duty facts and optional fresh progress into the common loop."""
from .task_loop import TaskDecision, response_requires_continuation, with_task_loop


class DutyCompletionIncomplete(RuntimeError):
    pass


def with_duty_completion(model, gateway, progress, round_seconds):
    execution = {}

    def decide(run):
        if not run.user_id:
            raise DutyCompletionIncomplete("agentos_autonomy_completion_context_missing")
        task = gateway.duty_authorize(run.user_id, operation="run").get("task") or {}
        execution.update(((task.get("prompt") or {}).get("context") or {}).get("execution") or {})
        completion = task.get("completion") or {}
        updates = progress[:]
        progress.clear()
        disposition = completion.get("disposition")
        states = {"waiting-human": "waiting-human", "unknown": "waiting-result", "failed": "failed", "continue": "waiting-result"}
        if disposition in states:
            return TaskDecision(state=states[disposition], reason=str(completion.get("reasonCode") or ""))
        if response_requires_continuation():
            return TaskDecision(state="continue", reason="继续尚未输出的内容")
        # Future activations are not remaining work in this execution.
        # They are recorded as deferredWork, and only the scheduler runs them.
        # A persisted assessment is current only until the next actual tool
        # call. A previous response or resumed attempt must never force a loop.
        assessment = completion.get("modelAssessment")
        if updates and assessment == updates[-1] and assessment.get("goalSatisfied") is False:
            remaining = tuple(item["description"] for item in assessment.get("remainingWork", [])
                if isinstance(item, dict) and isinstance(item.get("description"), str))
            if remaining and disposition == "completed":
                return TaskDecision(state="continue", remaining=remaining)
        return TaskDecision()

    def continuation_input(_run, _decision):
        return ("继续同一execution的当前工作，使用已取得的结果。完成目标：" +
                str(execution.get("objective") or "完成本轮适用工作并交付结果") +
                "。remainingWork只记录本轮可推进的步骤；未来调度放入deferredWork，不在本轮等待或反复执行。")

    return with_task_loop(model, decide=decide, continue_input=continuation_input, timeout_seconds=round_seconds)
