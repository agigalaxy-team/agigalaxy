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
from .tool_call_ids import (conversation_call_reference, projected_tool_call_id,
    valid_conversation_reference, valid_run_context_id)


TOOL_NAMES = frozenset({"current_summary", "query_operations", "read_operation_object",
    "list_authorized_work", "run_authorized_work", "prepare_operation", "execute_operation",
    "manage_ai_role", "manage_ai_prompt", "read_ai_delegation"})
EVENT_NAMES = frozenset(event.value for event in RunEvent)
ERROR_TYPES = frozenset({"AuthorityDenied", "AuthorityUnavailable"})
_REFERENCE_KIND = "galaxy-conversation-reference-v1"
_REFERENCE_METADATA = "_galaxyConversationCallReferences"
_SOURCE_TOKEN = object()


class _StoredReferences:
    """Only the adapter's same-run database read can create trusted evidence."""
    def __init__(self, token, run_id, values):
        if token is not _SOURCE_TOKEN:
            raise ValueError("agentos_storage_reference_source_required")
        self.run_id, self.values = run_id, values


def _reference_source(db, run_id):
    if not valid_run_context_id(run_id) or not callable(getattr(db, "get_run", None)):
        return None
    try:
        row = db.get_run(run_id=run_id, deserialize=False)
        if not isinstance(row, dict) or row.get("run_id") != run_id or not str(row.get("agent_id", "")).startswith("galaxy-conversation-"):
            return None
        data = row.get("run_data") or {}
        values = []
        for item in [*(data.get("tools") or []), *(event.get("tool") for event in data.get("events") or [] if isinstance(event, dict))]:
            if (isinstance(item, dict) and item.get("call_reference_kind") == _REFERENCE_KIND
                    and valid_conversation_reference(item.get("tool_call_id"))):
                values.append((item["tool_call_id"], item.get("tool_name"), item.get("created_at")))
        return _StoredReferences(_SOURCE_TOKEN, run_id, values)
    except Exception:
        # A missing read is not proof that an incoming ID was already projected.
        return None


def _context_run_id(fields, supplied=None):
    embedded = fields.get("run_id")
    if supplied is not None and embedded is not None and supplied != embedded:
        return None
    value = supplied if supplied is not None else embedded
    return value if valid_run_context_id(value) else None


def _identifier(value):
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9:_-]{1,160}", value) else None


def _tool(value, *, reference_ids=False, run_id=None, stored_references=None, provenance_missing=False):
    if not isinstance(value, dict):
        return None
    call_id = value.get("tool_call_id")
    if reference_ids:
        # A provider-supplied marker or UUID-looking value is not trusted. The
        # exact reference/name/creation coordinate must already exist in this
        # adapter's same-run persisted projection (including after SDK reload,
        # which may discard the additional marker field on ToolExecution).
        already_stored = (isinstance(stored_references, _StoredReferences)
            and stored_references.run_id == run_id
            and (call_id, value.get("tool_name"), value.get("created_at")) in stored_references.values)
        if already_stored:
            call_id = call_id
        elif provenance_missing or value.get("call_reference_kind") == _REFERENCE_KIND:
            # An unverified projection marker grants no trust. Do not mistake
            # a stored tracking reference for a raw provider ID and hash twice.
            call_id = None
        else:
            call_id = conversation_call_reference(run_id, call_id)
    else:
        call_id = projected_tool_call_id(call_id)
    result = {"tool_call_id": call_id,
        "tool_name": value.get("tool_name") if value.get("tool_name") in TOOL_NAMES else None,
        "tool_call_error": value.get("tool_call_error") if type(value.get("tool_call_error")) is bool else None,
        "created_at": value.get("created_at") if type(value.get("created_at")) is int else None,
        "metrics": deepcopy(value.get("metrics")) if isinstance(value.get("metrics"), dict) else None}
    if reference_ids and call_id is not None:
        result["call_reference_kind"] = _REFERENCE_KIND
    return result


def _event(value, *, reference_ids=False, run_id=None, stored_references=None, provenance_missing=False):
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
        context = run_id if value.get("run_id") in {None, run_id} else None
        result["tool"] = _tool(value["tool"], reference_ids=reference_ids,
            run_id=context, stored_references=stored_references, provenance_missing=provenance_missing)
    return result


def conversation_storage_fields(fields, *, reference_ids=False, run_id=None, stored_references=None):
    """Project either a complete native RunOutput dictionary or a CAS patch.

    User messages and the final assistant reply remain native multi-turn
    history. Node binds their source references and rotates the session before
    later reads/runs if a reference is no longer permitted. Tool arguments,
    tool result bodies and event bodies are never that history's authority.
    """
    result = deepcopy(fields)
    run_id = _context_run_id(fields, run_id) if reference_ids else None
    metadata = fields.get("metadata")
    provenance_missing = (reference_ids and isinstance(metadata, dict)
        and metadata.get(_REFERENCE_METADATA) == 1 and stored_references is None)
    if "tools" in result:
        result["tools"] = [projected for item in result.get("tools") or []
            if (projected := _tool(item, reference_ids=reference_ids, run_id=run_id,
                stored_references=stored_references, provenance_missing=provenance_missing)) is not None]
    if "events" in result:
        result["events"] = [projected for item in result.get("events") or []
            if (projected := _event(item, reference_ids=reference_ids, run_id=run_id,
                stored_references=stored_references, provenance_missing=provenance_missing)) is not None]
    if reference_ids and isinstance(result.get("metadata"), dict):
        result["metadata"][_REFERENCE_METADATA] = 1
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
        run_id = _context_run_id(fields)
        return db.upsert_run(conversation_storage_fields(fields, reference_ids=True,
            run_id=run_id, stored_references=_reference_source(db, run_id)), *args, **kwargs)

    def update_run_in_session(*args, fields, **kwargs):
        # Actual Agno 3.1.7 signature: (session_id, run_id, fields, ...).
        run_id = kwargs.get("run_id") if "run_id" in kwargs else args[1] if len(args) > 1 else None
        run_id = _context_run_id(fields, run_id)
        return db.update_run_in_session(*args, fields=conversation_storage_fields(fields,
            reference_ids=True, run_id=run_id, stored_references=_reference_source(db, run_id)), **kwargs)

    def append_run_to_session_if_absent(*args, run_dict, **kwargs):
        run_id = _context_run_id(run_dict)
        return db.append_run_to_session_if_absent(*args, run_dict=conversation_storage_fields(run_dict,
            reference_ids=True, run_id=run_id, stored_references=_reference_source(db, run_id)), **kwargs)

    projected.upsert_run = upsert_run
    if callable(getattr(db, "update_run_in_session", None)):
        projected.update_run_in_session = update_run_in_session
    if callable(getattr(db, "append_run_to_session_if_absent", None)):
        projected.append_run_to_session_if_absent = append_run_to_session_if_absent
    return projected
