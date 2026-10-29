"""Continue the same bounded duty run until its persisted goal assessment is ready."""
import asyncio
from functools import wraps

from agno.models.message import Message


class DutyCompletionIncomplete(RuntimeError):
    pass


def with_duty_completion(model, gateway):
    response, aresponse = model.response, model.aresponse

    def pending(value, run):
        if run is not None and any(not req.is_resolved() for req in run.requirements or []):
            return True
        return any(t.external_execution_required or t.requires_confirmation or t.requires_user_input
                   for t in value.tool_executions or [])

    def args_context(args, kwargs):
        messages = kwargs.get("messages", args[0] if args else None)
        run = kwargs.get("run_response", args[5] if len(args) > 5 else None)
        if messages is None or run is None or not run.user_id:
            raise DutyCompletionIncomplete("agentos_autonomy_completion_context_missing")
        return messages, run

    def facts(run):
        result = gateway.duty_authorize(run.user_id, operation="run")
        return ((result.get("task") or {}).get("completion") or {})

    def append_prompt(messages, completion):
        reason = completion.get("reasonCode", "task-assessment-required")
        messages.append(Message(role="user", content=(
            "系统要求继续当前原任务；以当前授权和原操作回执为准。"
            "检查剩余目标并使用已有工具推进；未知写入只核查原操作，不能重发。"
            "完成有效工作后调用 assess_task。当前状态：" + str(reason))))

    def merge(parts, last):
        by_id = {}
        for part in parts:
            for tool in part.tool_executions or []:
                by_id[tool.tool_call_id] = tool
        last.tool_executions = list(by_id.values())
        return last

    def incomplete(run):
        run.metadata = {**(run.metadata or {}), "completionFailureCode": "operations_autonomy_completion_incomplete"}
        raise DutyCompletionIncomplete("agentos_autonomy_completion_incomplete")

    @wraps(response)
    def checked(*args, **kwargs):
        messages, run = args_context(args, kwargs)
        parts, seen, idle = [], set(), 0
        while True:
            value = response(*args, **kwargs)
            parts.append(value)
            if pending(value, run):
                return merge(parts, value)
            current = facts(run)
            if current.get("disposition") in {"completed", "waiting-human", "failed"}:
                return merge(parts, value)
            ids = {t.tool_call_id for t in value.tool_executions or [] if t.tool_call_id
                   and t.tool_name not in {"assess_task", "reconcile_task_operations"}}
            idle = 0 if ids - seen else idle + 1
            seen.update(ids)
            if idle >= 3:
                incomplete(run)
            append_prompt(messages, current)

    @wraps(aresponse)
    async def achecked(*args, **kwargs):
        messages, run = args_context(args, kwargs)
        parts, seen, idle = [], set(), 0
        while True:
            value = await aresponse(*args, **kwargs)
            parts.append(value)
            if pending(value, run):
                return merge(parts, value)
            current = await asyncio.to_thread(facts, run)
            if current.get("disposition") in {"completed", "waiting-human", "failed"}:
                return merge(parts, value)
            ids = {t.tool_call_id for t in value.tool_executions or [] if t.tool_call_id
                   and t.tool_name not in {"assess_task", "reconcile_task_operations"}}
            idle = 0 if ids - seen else idle + 1
            seen.update(ids)
            if idle >= 3:
                incomplete(run)
            append_prompt(messages, current)

    model.response, model.aresponse = checked, achecked
    return model
