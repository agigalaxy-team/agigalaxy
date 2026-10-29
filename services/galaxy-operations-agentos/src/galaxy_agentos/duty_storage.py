"""Metadata-only native duty history; Node owns task materials and effects.

The native queue, transaction fencing and run rows are reused. Callback failure
does not change an already persisted run; Node reconciles the same task/run.
"""
from copy import copy
import math
from uuid import UUID
from agno.run.status_persist import RunPersistOutcome

from .conversation_storage import conversation_storage_fields
from .duty_continuation import WRITE_TOOLS
from .gateway import AuthorityDenied, AuthorityUnavailable


MODEL_STATES = {"PENDING": "accepted", "RUNNING": "running", "COMPLETED": "completed",
    "PAUSED": "running", "ERROR": "failed", "CANCELLED": "cancelled"}


def duty_report_fields(run):
    nested = run.get("run_data") if isinstance(run.get("run_data"), dict) else {}
    status_value = run.get("status") or nested.get("status")
    status = str(getattr(status_value, "value", status_value) or "").upper()
    metadata = run.get("metadata") if isinstance(run.get("metadata"), dict) else nested.get("metadata")
    failure = (metadata or {}).get("completionFailureCode")
    code = failure if isinstance(failure, str) and failure in {"operations_autonomy_completion_incomplete", "operations_autonomy_validation_ledger_unavailable"} else "operations_autonomy_model_failed"
    return {"nativeRunId": run.get("run_id") or nested.get("run_id"),
        "modelState": MODEL_STATES.get(status, "unknown"),
        "status": "waiting-human" if status == "PAUSED" else "completed" if status == "COMPLETED"
            else "failed" if status in {"ERROR", "CANCELLED"} else "running" if status in {"PENDING", "RUNNING"} else "unknown",
        **({"code": code} if status == "ERROR" else {})}


def duty_storage_fields(fields):
    result = conversation_storage_fields(fields)
    if "tools" in result:
        # Preserve only the native pause coordinate. Arguments, result bodies
        # and approvals cannot become an alternate business authority.
        paused = {tool.get("tool_call_id") for tool in fields.get("tools") or []
            if isinstance(tool, dict) and tool.get("tool_name") in WRITE_TOOLS
            and tool.get("external_execution_required") is True}
        for tool in result["tools"]:
            if tool.get("tool_call_id") in paused:
                tool.update(tool_args={}, external_execution_required=True, external_execution_silent=True, result=None)
    if "requirements" in result:
        result["requirements"] = [
            {"id": requirement.get("id"), "tool_execution": next(tool for tool in result.get("tools") or []
                if tool.get("tool_call_id") == (requirement.get("tool_execution") or {}).get("tool_call_id"))}
            for requirement in fields.get("requirements") or [] if isinstance(requirement, dict)
            and any(tool.get("external_execution_required") is True
                and tool.get("tool_call_id") == (requirement.get("tool_execution") or {}).get("tool_call_id")
                for tool in result.get("tools") or [])]
    # Duties read task-scoped context again from Node on a later authorized
    # round. Native history is not a private-chat/evidence retention store.
    for key in ("messages", "content", "input", "additional_input", "reasoning_content", "reasoning_steps"):
        if key in result:
            result[key] = None
    metadata = result.get("metadata")
    if isinstance(metadata, dict):
        allowed = {"taskId", "operationId", "planId", "planVersion", "promptVersion", "boundaryVersion",
            "delegationVersion", "roleVersion", "domain", "aiAccountId", "source", "purpose", "modelSettingsVersion",
            "roundSeconds", "runtimeRevision", "modelCalls", "activeDurationBefore", "completionFailureCode"}
        result["metadata"] = {key: value for key, value in metadata.items() if key in allowed
            and (key != "completionFailureCode" or isinstance(value, str) and value in {"operations_autonomy_completion_incomplete", "operations_autonomy_validation_ledger_unavailable"})
            and (value is None or type(value) in {str, int, bool}
                or key == "activeDurationBefore" and type(value) is float and math.isfinite(value) and value >= 0)}
        versions = metadata.get("modelSettingsVersions")
        if isinstance(versions, list) and len(versions) <= 32 and all(isinstance(value, str) and len(value) <= 128 for value in versions):
            result["metadata"]["modelSettingsVersions"] = list(versions)
    return result


def duty_database(db, gateway):
    projected = copy(db)
    projected.id = str(db.id) + "-duty-storage"

    def report(run_id, fields=None):
        try:
            row = db.get_run(run_id=run_id, deserialize=False)
            if not isinstance(row, dict) or row.get("agent_id") != "galaxy-duty":
                return
            user_id = row.get("user_id") or (row.get("run_data") or {}).get("user_id")
            if not isinstance(user_id, str) or not user_id.startswith("autonomy:"):
                return
            UUID(user_id[9:])
            gateway.duty_report(user_id, duty_report_fields(row))
        except Exception:
            # The committed native record is the original result. Never retry
            # the model or invent a business success because a callback failed.
            return

    def upsert_run(run, *args, **kwargs):
        fields = run.to_dict() if hasattr(run, "to_dict") else run
        result = db.upsert_run(duty_storage_fields(fields), *args, **kwargs)
        report(fields.get("run_id"))
        return result

    def update_run_in_session(*args, fields, **kwargs):
        # Native timeout/error producers can supply provider exception text in
        # this fallback field even when the normal run body was projected.
        if "content_if_absent" in kwargs:
            kwargs["content_if_absent"] = None
        result = db.update_run_in_session(*args, fields=duty_storage_fields(fields), **kwargs)
        if result is True or result == RunPersistOutcome.UPDATED:
            report(kwargs.get("run_id") or (args[1] if len(args) > 1 else None))
        return result

    def append_run_to_session_if_absent(*args, run_dict, **kwargs):
        result = db.append_run_to_session_if_absent(*args, run_dict=duty_storage_fields(run_dict), **kwargs)
        if result is True:
            report(run_dict.get("run_id"))
        return result

    projected.upsert_run = upsert_run
    if callable(getattr(db, "update_run_in_session", None)):
        projected.update_run_in_session = update_run_in_session
    if callable(getattr(db, "append_run_to_session_if_absent", None)):
        projected.append_run_to_session_if_absent = append_run_to_session_if_absent
    return projected
