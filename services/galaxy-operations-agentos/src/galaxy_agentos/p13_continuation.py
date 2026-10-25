"""P13 decision receipts on the existing native durable queue ticket.

The original Agno continue_job performs the paused -> queued CAS and attempt
fencing. Its own transaction joins this connection through a savepoint, so the
closed Galaxy receipt and that CAS commit together. No second queue, table,
workflow, provider request or detached continuation is introduced.
"""
from contextvars import ContextVar
from copy import copy, deepcopy
from uuid import UUID
from sqlalchemy.exc import SQLAlchemyError
import re

from sqlalchemy import select, update
from sqlalchemy.orm import sessionmaker


_current = ContextVar("galaxy_p13_continuation", default=None)
_receipts = "galaxy_p13_continuations_v1"


class ContinuationConflict(Exception):
    pass


def pause_id(run):
    active = run.active_step_requirements
    if (len(active) != 1 or active[0].step_name != "需要人工时暂停"
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", active[0].step_id or "")):
        return None
    retry = active[0].retry_count
    if not isinstance(retry, int) or isinstance(retry, bool) or not 0 <= retry <= 999999:
        return None
    return active[0].step_id + ":" + str(retry)


def binding(ctx, user_id):
    value = ctx.get("continuation")
    if not isinstance(value, dict) or value.get("runId") != ctx["runId"] or value.get("nativeRunId") != ctx["nativeRunId"]:
        raise ContinuationConflict()
    return {**value, "sessionId": ctx["sessionId"], "userId": user_id}


def _ticket_matches(job, value):
    return bool(job and job["id"] == value["nativeRunId"] and job.get("job_type") == "run"
        and job.get("component_type") == "workflow" and job.get("component_id") == "galaxy-p13-selected-content-v1"
        and job.get("user_id") == value["userId"] and job.get("session_id") == value["sessionId"])


def receipt(db, value):
    """Read only: absence of a retained ticket is unknown, never permission to send."""
    base = {key: value[key] for key in ("operationId", "runId", "nativeRunId", "pauseId")}
    job = db.get_job(value["nativeRunId"], strict=True)
    if job is None:
        return {**base, "state": "unknown"}
    if not _ticket_matches(job, value):
        raise ContinuationConflict()
    old = (job.get("payload") or {}).get(_receipts, {}).get(value["operationId"])
    if old is not None and old != value:
        raise ContinuationConflict()
    return {**base, "state": "accepted" if old is not None else "not-recorded"}


def receipt_metadata(db, *, native_run_id, session_id, user_id):
    """Closed accepted receipts from the retained original ticket, never inference.

    The internal service-key reader supplies the exact native run identity.
    It cannot create a continuation or provide source/approval payloads.
    """
    unknown = {"state": "unavailable", "complete": False, "items": []}
    try:
        job = db.get_job(native_run_id, strict=True)
    except (SQLAlchemyError, ValueError, TypeError, AttributeError, NotImplementedError):
        return unknown
    expected = {"nativeRunId": native_run_id, "sessionId": session_id, "userId": user_id}
    if not _ticket_matches(job, expected):
        return unknown
    payload = job.get("payload") or {}
    if not isinstance(payload, dict):
        return unknown
    retained = payload.get(_receipts, {})
    if not isinstance(retained, dict) or len(retained) > 50:
        return unknown
    items = []
    for operation_id, value in retained.items():
        if not isinstance(value, dict):
            return unknown
        base_keys = {"operationId", "runId", "nativeRunId", "pauseId", "sessionId", "userId"}
        choices = set(value) - base_keys
        if (choices not in ({"confirmed"}, {"inputDecision"})
                or set(value) != base_keys | choices
                or value.get("operationId") != operation_id
                or any(value.get(key) != ident for key, ident in expected.items())
                or not isinstance(value.get("pauseId"), str)
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}:[0-9]{1,6}", value["pauseId"])):
            return unknown
        try:
            if any(not isinstance(value.get(key), str) or str(UUID(value[key])) != value[key]
                    for key in ("operationId", "runId")):
                return unknown
        except (ValueError, TypeError, AttributeError):
            return unknown
        if ("confirmed" in choices and type(value["confirmed"]) is not bool
                or "inputDecision" in choices and (not isinstance(value["inputDecision"], str) or value["inputDecision"] not in {"proceed", "no-action"})):
            return unknown
        items.append({**{key: value[key] for key in ("operationId", "runId", "nativeRunId", "pauseId")}, "state": "accepted"})
    return {"state": "available", "complete": True, "items": items}


def enter(value):
    return _current.set(value)


def leave(token):
    _current.reset(token)


def install(db):
    """Wrap only this DB instance; other workflows and continuation calls pass through."""
    if getattr(db, "_galaxy_p13_continue_installed", False):
        return True
    original = getattr(db, "continue_job", None)
    if (not callable(original) or getattr(getattr(db, "db_engine", None), "dialect", None) is None
            or db.db_engine.dialect.name != "postgresql" or not hasattr(original, "__func__")):
        return False

    def continue_job(job_id, payload):
        value = _current.get()
        if value is None:
            return original(job_id, payload)
        if job_id != value["nativeRunId"]:
            raise ContinuationConflict()
        table = db._get_table(table_type="jobs")
        if table is None:
            raise RuntimeError("p13_durable_ticket_unavailable")
        with db.db_engine.begin() as connection:
            found = connection.execute(select(table).where(table.c.id == job_id).with_for_update()).first()
            job = dict(found._mapping) if found is not None else None
            if not _ticket_matches(job, value):
                raise ContinuationConflict()
            previous = (job.get("payload") or {}).get(_receipts, {})
            old = previous.get(value["operationId"])
            if old is not None:
                if old != value:
                    raise ContinuationConflict()
                return {"outcome": "attach", "job": job}
            if any(item.get("pauseId") == value["pauseId"] for item in previous.values()):
                raise ContinuationConflict()
            requirements = payload.get("step_requirements")
            if not isinstance(requirements, list) or len(requirements) != 1:
                raise ContinuationConflict()
            requirement = requirements[0]
            expected_pause = str(requirement.get("step_id")) + ":" + str(requirement.get("retry_count", 0))
            accepted = value.get("confirmed", value.get("inputDecision") == "proceed")
            # For the closed input choice, Node has recorded proceed/no-action;
            # native confirms the review to let the original effect gate read it.
            expected_confirmed = True if "inputDecision" in value else accepted
            if expected_pause != value["pauseId"] or requirement.get("confirmed") is not expected_confirmed:
                raise ContinuationConflict()
            # Native code is reused unmodified. A local clone joins the same
            # transaction; another worker cannot see queued without its receipt.
            joined = copy(db)
            joined.Session = sessionmaker(bind=connection, expire_on_commit=False, join_transaction_mode="create_savepoint")
            result = original.__func__(joined, job_id, payload)
            if result.get("outcome") == "queued":
                job = result["job"]
                updated = deepcopy(job["payload"])
                updated[_receipts] = {**previous, value["operationId"]: dict(value)}
                connection.execute(update(table).where(table.c.id == job_id).values(payload=updated))
                job["payload"] = updated
            elif result.get("outcome") == "attach":
                # This request did not win the native CAS. No acceptance receipt
                # may be manufactured for a settling/different continuation.
                raise ContinuationConflict()
            return result

    db.continue_job = continue_job
    db._galaxy_p13_continue_installed = True
    return True
