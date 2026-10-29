"""Continue the same bounded duty run until its persisted goal assessment is ready."""
import asyncio
import json
import hashlib
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

    def progressing_facts(value):
        # Keep only digests in this execution, never a second material store.
        volatile = {"checkedAt", "readExpiresAt", "callId", "runId", "operationId", "nativeRunId"}
        def stable(item):
            if isinstance(item, dict):
                return {key: stable(val) for key, val in item.items() if key not in volatile}
            if isinstance(item, list):
                return [stable(val) for val in item]
            return item
        facts = set()
        for tool in value.tool_executions or []:
            name = tool.tool_name
            if name == "assess_task":
                continue
            try:
                fact = json.loads(tool.result) if isinstance(tool.result, str) else {}
            except (ValueError, TypeError):
                continue
            if not isinstance(fact, dict):
                continue
            if name == "current_summary" and fact.get("inspectionChecked") is not True:
                continue
            if name == "reconcile_task_operations":
                operations = fact.get("operations")
                if not isinstance(operations, list) or not any(isinstance(v, dict) and v.get("state") == "completed" for v in operations):
                    continue
            elif not (fact.get("availability") == "available" or
                    fact.get("state") == "completed" and fact.get("effectState") == "completed" or
                    name == "read_ai_delegation" and (isinstance(fact.get("prompt"), dict) or isinstance(fact.get("delegation"), dict))):
                continue
            try:
                payload = json.dumps(stable({"tool": name, "arguments": tool.tool_args or {}, "result": fact}),
                    sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                facts.add(hashlib.sha256(payload.encode("utf-8")).digest())
            except (TypeError, ValueError):
                continue
        return facts

    def validate_ledger(run):
        if (run.metadata or {}).get("_galaxyDutyValidationLedgerFailed") is True:
            run.metadata = {**(run.metadata or {}), "completionFailureCode": "operations_autonomy_validation_ledger_unavailable"}
            raise DutyCompletionIncomplete("agentos_autonomy_validation_ledger_unavailable")

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
            validate_ledger(run)
            if pending(value, run):
                return merge(parts, value)
            current = facts(run)
            if current.get("disposition") in {"completed", "waiting-human", "failed"}:
                return merge(parts, value)
            facts_seen = progressing_facts(value)
            idle = 0 if facts_seen - seen else idle + 1
            seen.update(facts_seen)
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
            validate_ledger(run)
            if pending(value, run):
                return merge(parts, value)
            current = await asyncio.to_thread(facts, run)
            if current.get("disposition") in {"completed", "waiting-human", "failed"}:
                return merge(parts, value)
            facts_seen = progressing_facts(value)
            idle = 0 if facts_seen - seen else idle + 1
            seen.update(facts_seen)
            if idle >= 3:
                incomplete(run)
            append_prompt(messages, current)

    model.response, model.aresponse = checked, achecked
    return model
