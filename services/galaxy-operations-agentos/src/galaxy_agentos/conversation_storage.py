"""Keep native run history while storing business tool payloads in Node only.

Agno 3.1.7's store_tool_messages=False removes message pairs, but does not
scrub RunOutput.tools or event payloads. Both normal saves and durable-worker
attempt-fenced saves therefore need the same projection at the native DB
boundary. This adapter retains the existing DB class, engine, transaction
primitives and attempt fencing; it adds no database, queue or history store.
"""
from copy import copy, deepcopy
import re

from agno.run.agent import RunEvent
from .tool_call_ids import projected_tool_call_id


TOOL_NAMES = frozenset({"current_summary", "query_operations", "read_operation_object",
    "list_authorized_work", "run_authorized_work", "prepare_operation", "execute_operation",
    "manage_ai_role", "manage_ai_prompt", "read_ai_delegation"})
EVENT_NAMES = frozenset(event.value for event in RunEvent)
ERROR_TYPES = frozenset({"AuthorityDenied", "AuthorityUnavailable"})


def _identifier(value):
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9:_-]{1,160}", value) else None


def _tool(value):
    if not isinstance(value, dict):
        return None
    return {"tool_call_id": projected_tool_call_id(value.get("tool_call_id")),
        "tool_name": value.get("tool_name") if value.get("tool_name") in TOOL_NAMES else None,
        "tool_call_error": value.get("tool_call_error") if type(value.get("tool_call_error")) is bool else None,
        "created_at": value.get("created_at") if type(value.get("created_at")) is int else None,
        "metrics": deepcopy(value.get("metrics")) if isinstance(value.get("metrics"), dict) else None}


def _event(value):
    if not isinstance(value, dict) or value.get("event") not in EVENT_NAMES:
        return None
    result = {key: value[key] for key in ("event", "created_at", "event_index")
        if key in value and (key == "event" or type(value[key]) is int)}
    for key in ("agent_id", "run_id", "session_id", "parent_run_id"):
        if _identifier(value.get(key)):
            result[key] = value[key]
    if value.get("error_type") in ERROR_TYPES:
        result["error_type"] = value["error_type"]
    if isinstance(value.get("tool"), dict):
        result["tool"] = _tool(value["tool"])
    return result


def conversation_storage_fields(fields):
    """Project either a complete native RunOutput dictionary or a CAS patch.

    User messages and the final assistant reply remain native multi-turn
    history. Node binds their source references and rotates the session before
    later reads/runs if a reference is no longer permitted. Tool arguments,
    tool result bodies and event bodies are never that history's authority.
    """
    result = deepcopy(fields)
    if "tools" in result:
        result["tools"] = [projected for item in result.get("tools") or []
            if (projected := _tool(item)) is not None]
    if "events" in result:
        result["events"] = [projected for item in result.get("events") or []
            if (projected := _event(item)) is not None]
    if "messages" in result and result["messages"]:
        # Also cover atomic full-run error writes, which can bypass Agno's
        # ordinary store_tool_messages cleanup.
        result["messages"] = [item for item in result["messages"]
            if isinstance(item, dict) and item.get("role") != "tool"
            and not (item.get("role") == "assistant" and item.get("tool_calls"))]
    if "additional_input" in result:
        result["additional_input"] = None
    return result


def conversation_database(db):
    """Wrap only this conversation Agent's native per-run write methods.

    The shallow copy remains a real PostgresDb/SqliteDb and shares the existing
    engine and native tables. Its distinct adapter ID prevents the AgentOS
    registry from shadowing this write policy with the unwrapped original DB.
    AgentOS/execution agents keep the original DB.
    Native Postgres/SQLite session rows do not embed runs (include_runs=False).
    """
    projected = copy(db)
    projected.id = str(db.id) + "-conversation-storage"

    def upsert_run(run, *args, **kwargs):
        fields = run.to_dict() if hasattr(run, "to_dict") else run
        return db.upsert_run(conversation_storage_fields(fields), *args, **kwargs)

    def update_run_in_session(*args, fields, **kwargs):
        return db.update_run_in_session(*args, fields=conversation_storage_fields(fields), **kwargs)

    def append_run_to_session_if_absent(*args, run_dict, **kwargs):
        return db.append_run_to_session_if_absent(*args,
            run_dict=conversation_storage_fields(run_dict), **kwargs)

    projected.upsert_run = upsert_run
    if callable(getattr(db, "update_run_in_session", None)):
        projected.update_run_in_session = update_run_in_session
    if callable(getattr(db, "append_run_to_session_if_absent", None)):
        projected.append_run_to_session_if_absent = append_run_to_session_if_absent
    return projected
