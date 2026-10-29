"""Continue the same bounded duty run until its persisted goal assessment is ready."""
import asyncio
import json
import hashlib
from functools import wraps
from uuid import UUID

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
        # The server owns this bounded, task-scoped projection. Do not copy
        # returned source bodies or interpret an incomplete page as a full set.
        assessment = completion.get("modelAssessment")
        assessment = assessment if isinstance(assessment, dict) else {}
        remaining = assessment.get("remainingWork")
        remaining = [{"kind": item.get("kind"), "description": item.get("description")}
            for item in remaining[:8] if isinstance(item, dict)
            and item.get("kind") in {"read", "action", "human"}
            and isinstance(item.get("description"), str) and len(item["description"]) <= 240] if isinstance(remaining, list) else []
        coverage = completion.get("readCoverage")
        coverage = coverage if isinstance(coverage, dict) else {}
        receipt_evidence = completion.get("resolutionEvidence")
        receipt_evidence = receipt_evidence if isinstance(receipt_evidence, list) else []
        def facts(key):
            values = coverage.get(key)
            if not isinstance(values, list):
                return []
            result = []
            for item in values[:40]:
                if not isinstance(item, dict):
                    continue
                fact = {k: item[k] for k in ("tool", "module", "view", "kind", "id", "scope", "coverage", "basis", "reason", "inspectionOutcome") if k in item}
                try:
                    call_id = item.get("callId")
                    if isinstance(call_id, str) and str(UUID(call_id)) == call_id:
                        fact["callId"] = call_id
                except (ValueError, TypeError, AttributeError):
                    pass
                result.append(fact)
            return result
        status = {"disposition": completion.get("disposition"), "reasonCode": completion.get("reasonCode"),
            "nextAction": completion.get("nextAction"), "businessState": completion.get("businessState"),
            "remainingWork": remaining, "unresolved": facts("unresolved"), "unverified": facts("unverified"),
            "successful": facts("successful"),
            "resolutionEvidence": [{k: item[k] for k in ("callId", "operationId", "targetId", "action", "state", "basis") if k in item}
                for item in receipt_evidence[:40] if isinstance(item, dict)],
            "incidentalReadFailures": facts("incidentalReadFailures"),
            "omittedCounts": {key: max(0, len(coverage.get(key)) - 40) if isinstance(coverage.get(key), list) else 0
                for key in ("successful", "unresolved", "unverified", "incidentalReadFailures")},
            "omittedResolutionEvidence": max(0, len(receipt_evidence) - 40) + (
                completion.get("resolutionEvidenceOmitted") if type(completion.get("resolutionEvidenceOmitted")) is int
                and completion.get("resolutionEvidenceOmitted") >= 0 else 0)}
        messages.append(Message(role="user", content=(
            "系统要求继续当前原任务；以当前授权和原操作回执为准。"
            "按以下程序裁决处理未决范围；取得有界页不代表全库已穷尽。"
            "未知写入只核查原操作，不能重发；完成有效工作后调用 assess_task。"
            "可用原callId和后续成功证据提出readResolutions；程序仍核原范围及证据，旁读不变成成功。"
            "当前程序裁决：" + json.dumps(status, ensure_ascii=False, allow_nan=False, separators=(",", ":")))))

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
                    name == "inspect_operations" and isinstance(fact.get("segments"), dict) and any(isinstance(segment, dict) and segment.get("availability") == "available" for segment in fact["segments"].values()) or
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
