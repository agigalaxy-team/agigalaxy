"""Conversation state adapter for the shared Agno task boundary."""
from .conversation_turn_state import turn_state, ASSESSMENT, ACTIVITY, TASK_PROGRESS
from .task_loop import TaskDecision, with_task_loop


def with_conversation_completion(model, *, timeout_seconds=600, gateway=None):
    def checkpoint(run, disposition, reason="", remaining=()):
        state = turn_state(run)
        if gateway is None:
            progress = {"phase": disposition, "remaining": list(remaining), "reason": reason}
        else:
            operation_id = (run.metadata or {}).get("operationId")
            result = gateway.conversation_tool(run.user_id, "assess-conversation-task",
                {"disposition": disposition, "reason": reason, "remaining": list(remaining)},
                run_id=run.run_id, session_id=run.session_id, turn_id=operation_id,
                call_id="runtime:task-final:" + str(operation_id))
            progress = result.get("taskProgress") if isinstance(result, dict) else None
            if not isinstance(progress, dict):
                from .gateway import AuthorityUnavailable
                raise AuthorityUnavailable("agentos_conversation_checkpoint_unavailable")
        state[TASK_PROGRESS] = progress
        return TaskDecision(state=progress["phase"], remaining=tuple(progress.get("remaining") or ()), reason=progress.get("reason") or "")

    def decide(run):
        state = turn_state(run)
        assessment = state.pop(ASSESSMENT, None)
        # Explicit updates can continue a task. Old updates are context, not a
        # permanent obligation to call an assessment tool after every action.
        if isinstance(assessment, dict) and assessment.get("activity") == state.get(ACTIVITY, 0):
            phase = assessment.get("disposition")
            if phase == "continue":
                return TaskDecision("continue", tuple(assessment.get("remaining") or ()), assessment.get("reason") or "")
            if phase in {"waiting-confirmation", "needs-information", "waiting-result", "blocked", "interrupted"}:
                return TaskDecision(phase)
        # Go projects actual pending cards/operations, not view counts.
        return checkpoint(run, "completed")

    return with_task_loop(model, decide=decide, timeout_seconds=timeout_seconds,
        on_timeout=lambda run: checkpoint(run, "interrupted", "处理已暂停。"))
