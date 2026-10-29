"""Metadata-only native duty history; Node owns task materials and effects.

The native queue, transaction fencing and run rows are reused. Callback failure
does not change an already persisted run; Node reconciles the same task/run.
"""
from copy import copy
import math
from uuid import UUID
from agno.run.status_persist import RunPersistOutcome

from .conversation_storage import conversation_storage_fields
from .duty_continuation import WRITE_TOOLS, call_reference
from .gateway import AuthorityDenied, AuthorityUnavailable


MODEL_STATES = {"PENDING": "accepted", "RUNNING": "running", "COMPLETED": "completed",
    "PAUSED": "running", "ERROR": "failed", "CANCELLED": "cancelled"}


def manual_pause_marker(value):
    if not isinstance(value, dict) or set(value) != {"pauseOperationId", "checkpointCallIds"}:
        return None
    ids = value.get("checkpointCallIds")
    try:
        if not isinstance(ids, list) or len(ids) != 1:
            return None
        op = str(UUID(value["pauseOperationId"]))
        call = str(UUID(ids[0]))
        if op != value["pauseOperationId"] or call != ids[0]:
            return None
    except (KeyError, ValueError, TypeError, AttributeError):
        return None
    return {"pauseOperationId": op, "checkpointCallIds": [call]}


def manual_resume_consumed(value):
    if not isinstance(value, dict) or set(value) != {"pauseOperationId", "resumeOperationId", "checkpointCallIds"}:
        return None
    marker = manual_pause_marker({key: value[key] for key in ("pauseOperationId", "checkpointCallIds")})
    try:
        operation = str(UUID(value["resumeOperationId"]))
        if marker is None or operation != value["resumeOperationId"]:
            return None
    except (ValueError, TypeError, AttributeError):
        return None
    return {**marker, "resumeOperationId": operation}


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
        **({"code": code} if status == "ERROR" else {}),
        **({"manualPause": marker} if status == "PAUSED" and (marker := manual_pause_marker((metadata or {}).get("manualPause"))) else {}),
        **({"manualResumeConsumed": consumed} if status == "RUNNING" and (consumed := manual_resume_consumed((metadata or {}).get("manualResumeConsumed"))) else {})}


def duty_storage_fields(fields):
    result = conversation_storage_fields(fields)
    if "tools" in result:
        # Preserve only the native pause coordinate. Arguments, result bodies
        # and approvals cannot become an alternate business authority.
        metadata = fields.get("metadata") if isinstance(fields.get("metadata"), dict) else {}
        marker = manual_pause_marker(metadata.get("manualPause"))
        task_id, run_id = metadata.get("taskId"), fields.get("run_id")
        def manual_anchor(tool):
            return (marker is not None and isinstance(task_id, str) and isinstance(run_id, str)
                and isinstance(tool.get("tool_call_id"), str)
                and call_reference(task_id, run_id, tool["tool_call_id"]) in marker["checkpointCallIds"])
        paused = {tool.get("tool_call_id") for tool in fields.get("tools") or []
            if isinstance(tool, dict) and (tool.get("tool_name") in WRITE_TOOLS or manual_anchor(tool))
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
        marker = manual_pause_marker(metadata.get("manualPause"))
        if marker is not None:
            result["metadata"]["manualPause"] = marker
        consumed = manual_resume_consumed(metadata.get("manualResumeConsumed"))
        if consumed is not None:
            result["metadata"]["manualResumeConsumed"] = consumed
        versions = metadata.get("modelSettingsVersions")
        if isinstance(versions, list) and len(versions) <= 32 and all(isinstance(value, str) and len(value) <= 128 for value in versions):
            result["metadata"]["modelSettingsVersions"] = list(versions)
    return result


def duty_database(db, gateway):
    projected = copy(db)
    projected.id = str(db.id) + "-duty-storage"

    def report(run_id, fields=None, *, session_id=None, user_id=None, strong_binding=False):
        try:
            row = db.get_run(run_id=run_id, deserialize=False)
            if not isinstance(row, dict) or row.get("agent_id") != "galaxy-duty":
                return
            nested = row.get("run_data") if isinstance(row.get("run_data"), dict) else {}
            row_user = row.get("user_id") or nested.get("user_id")
            if not isinstance(row_user, str) or not row_user.startswith("autonomy:"):
                return
            UUID(row_user[9:])
            output = duty_report_fields(row)
            # Only the original, unfiltered fields from this successful persist
            # may supply a final result. A later GET cannot reconstruct it.
            if isinstance(fields, dict) and output["status"] == "completed" and output["modelState"] == "completed":
                source_status = fields.get("status")
                source_status = str(getattr(source_status, "value", source_status) or "").upper()
                source_run = fields.get("run_id") or run_id
                source_meta = fields.get("metadata") if isinstance(fields.get("metadata"), dict) else {}
                row_meta = nested.get("metadata") if isinstance(nested.get("metadata"), dict) else row.get("metadata")
                row_meta = row_meta if isinstance(row_meta, dict) else {}
                source_session = fields.get("session_id") or session_id
                row_session = row.get("session_id") or nested.get("session_id")
                keys = ("taskId", "operationId", "planId", "planVersion", "promptVersion", "boundaryVersion", "delegationVersion", "roleVersion", "domain", "aiAccountId", "modelSettingsVersion", "modelSettingsVersions", "runtimeRevision")
                bindings_match = all(key not in source_meta or source_meta[key] == row_meta.get(key) for key in keys)
                required = ("taskId", "operationId", "planId", "planVersion", "promptVersion", "domain", "aiAccountId", "modelSettingsVersion")
                strong = not strong_binding or (all(source_meta.get(key) is not None for key in required)
                    and source_meta.get("taskId") == row_user[9:] and bool(source_session))
                content = fields.get("content")
                if (source_status == "COMPLETED" and isinstance(content, str) and content.strip()
                        and output["nativeRunId"] == run_id == source_run and row_meta.get("taskId") == row_user[9:]
                        and (user_id is None or user_id == row_user) and (source_session is None or source_session == row_session)
                        and bindings_match and strong):
                    try:
                        size = len(content.encode("utf-8"))
                    except UnicodeEncodeError:
                        size = None
                    if size is not None:
                        output["finalAnalysis"] = ({"state": "available", "text": content} if size <= 12000
                            else {"state": "too-large", "byteLength": size})
            gateway.duty_report(row_user, output)
        except Exception:
            # The committed native record is the original result. Never retry
            # the model or invent a business success because a callback failed.
            return

    def upsert_run(run, *args, **kwargs):
        fields = run.to_dict() if hasattr(run, "to_dict") else run
        result = db.upsert_run(duty_storage_fields(fields), *args, **kwargs)
        report(fields.get("run_id"), fields if result is None or result is True or result == RunPersistOutcome.UPDATED else None, session_id=kwargs.get("session_id") or (args[0] if args else None),
            user_id=kwargs.get("user_id") or (args[1] if len(args) > 1 else None), strong_binding=True)
        return result

    def update_run_in_session(*args, fields, **kwargs):
        # Native timeout/error producers can supply provider exception text in
        # this fallback field even when the normal run body was projected.
        if "content_if_absent" in kwargs:
            kwargs["content_if_absent"] = None
        result = db.update_run_in_session(*args, fields=duty_storage_fields(fields), **kwargs)
        if result is True or result == RunPersistOutcome.UPDATED:
            report(kwargs.get("run_id") or (args[1] if len(args) > 1 else None), fields,
                session_id=kwargs.get("session_id") or (args[0] if args else None), user_id=kwargs.get("user_id"))
        return result

    def append_run_to_session_if_absent(*args, run_dict, **kwargs):
        result = db.append_run_to_session_if_absent(*args, run_dict=duty_storage_fields(run_dict), **kwargs)
        if result is True:
            report(run_dict.get("run_id"), run_dict, session_id=kwargs.get("session_id") or (args[0] if args else None), user_id=kwargs.get("user_id"))
        return result

    projected.upsert_run = upsert_run
    if callable(getattr(db, "update_run_in_session", None)):
        projected.update_run_in_session = update_run_in_session
    if callable(getattr(db, "append_run_to_session_if_absent", None)):
        projected.append_run_to_session_if_absent = append_run_to_session_if_absent
    return projected
