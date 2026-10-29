"""Exact owned lookup for queued and detached native conversation runs."""
import asyncio
import re
from urllib.parse import parse_qs
from uuid import UUID

from fastapi import Request
from fastapi.responses import JSONResponse
from sqlalchemy import select

from .gateway import AuthorityDenied, AuthorityUnavailable


def operation_read_locator(query):
    """A locator is never authority: the stored run must prove the full binding."""
    values = parse_qs(query.decode(), keep_blank_values=True)
    if (set(values) - {"runId", "retryOfOperationId", "retryOfRunId"}
            or any(len(items) != 1 for items in values.values())):
        raise ValueError("agentos_query_invalid")
    fields = {key: items[0] for key, items in values.items()}
    if not fields:
        return fields
    if "runId" in fields and not re.fullmatch(r"[-A-Za-z0-9_]{1,128}", fields["runId"]):
        raise ValueError("agentos_query_invalid")
    if ("retryOfOperationId" in fields) != ("retryOfRunId" in fields):
        raise ValueError("agentos_query_invalid")
    if "retryOfOperationId" in fields:
        if (str(UUID(fields["retryOfOperationId"])) != fields["retryOfOperationId"]
                or not re.fullmatch(r"[-A-Za-z0-9_]{1,128}", fields["retryOfRunId"])):
            raise ValueError("agentos_query_invalid")
    return fields


def install_conversation_transport_read(app, runtime, run_view):
    @app.get("/galaxy/conversations/{ident}/operations/{operation_id}")
    async def original_conversation_run(ident: str, operation_id: str, request: Request):
        # HTTP authority and SQLAlchemy are synchronous. Keep the whole owned
        # lookup, including both current checks, off the shared ASGI loop.
        return await asyncio.to_thread(read_original, ident, operation_id,
            dict(request.state.galaxy_execution), request.state.galaxy_user_id,
            request.scope.get("query_string", b""))

    def read_original(ident, operation_id, row, user_id, query):
        if row.get("mode") != "conversation" or row["id"] != ident:
            raise AuthorityDenied()
        try:
            if str(UUID(operation_id)) != operation_id:
                raise ValueError()
            locator = operation_read_locator(query)
        except (ValueError, TypeError):
            return JSONResponse({"error": "agentos_query_invalid"}, status_code=400)
        before = runtime["gateway"].authorize(user_id, operation="read")
        if before.get("execution", {}).get("sessionId") != row["sessionId"]:
            raise AuthorityDenied()
        db = runtime["db"]
        run_id, state, ticket = locator.get("runId"), "unknown", None
        strict_binding = bool(locator)
        discovered = False
        if run_id is None:
            table = db._get_table(table_type="jobs", create_table_if_not_found=False)
            required = {"id", "idempotency_key", "user_id", "session_id", "component_type", "component_id", "status"}
            if table is None or not required.issubset(table.c.keys()):
                raise AuthorityUnavailable("agentos_queue_lookup_unavailable")
            # Prefer the exact original queue ticket. A detached regenerate
            # has no ticket, and its SSE acknowledgement may also be lost.
            with db.Session() as session:
                found = session.execute(select(table.c.id, table.c.status).where(
                    table.c.idempotency_key == operation_id,
                    table.c.user_id == user_id,
                    table.c.session_id == row["sessionId"],
                    table.c.component_type == "agent",
                    table.c.component_id == "galaxy-conversation-" + row["domain"],
                ).limit(2)).fetchall()
            if len(found) > 1:
                raise AuthorityUnavailable("agentos_queue_lookup_unavailable")
            if found:
                ticket = found[0]._mapping
                run_id = ticket["id"]
                from agno.os.job_queue import ticket_status_to_api
                state = ticket_status_to_api(ticket["status"])
                if state not in {"PENDING", "RUNNING", "COMPLETED", "CANCELLED", "ERROR"}:
                    state = "unknown"
            else:
                runs = db._get_table(table_type="runs", create_table_if_not_found=False)
                required = {"run_id", "user_id", "session_id", "agent_id", "run_data"}
                if runs is None or not required.issubset(runs.c.keys()):
                    raise AuthorityUnavailable("agentos_operation_lookup_unavailable")
                # Fetch at most two primary keys for this one owned operation,
                # never session history or bodies. A lost acknowledgement does
                # not authorize choosing among duplicate attempts or resending.
                with db.Session() as session:
                    candidates = session.execute(select(runs.c.run_id).where(
                        runs.c.user_id == user_id,
                        runs.c.session_id == row["sessionId"],
                        runs.c.agent_id == "galaxy-conversation-" + row["domain"],
                        runs.c.run_data["metadata"]["operationId"].as_string() == operation_id,
                    ).limit(2)).fetchall()
                if len(candidates) > 1:
                    raise AuthorityUnavailable("agentos_operation_lookup_ambiguous")
                if candidates:
                    run_id = candidates[0]._mapping["run_id"]
                    strict_binding = True
                    discovered = True
        native = None
        if run_id is not None:
            stored = db.get_run(run_id=run_id, deserialize=False)
            if stored is not None:
                if (stored.get("user_id") != user_id or stored.get("session_id") != row["sessionId"]
                        or stored.get("agent_id") != "galaxy-conversation-" + row["domain"]):
                    raise AuthorityDenied()
                from agno.run.agent import RunOutput
                original = RunOutput.from_dict(stored.get("run_data") or {})
                metadata = original.metadata or {}
                operation = metadata.get("operationId")
                if (original.run_id != run_id
                        or strict_binding and operation != operation_id
                        or not strict_binding and operation not in {None, operation_id}):
                    raise AuthorityDenied()
                if strict_binding:
                    if (original.user_id != user_id or original.session_id != row["sessionId"]
                            or original.agent_id != "galaxy-conversation-" + row["domain"]):
                        raise AuthorityDenied()
                    parent_run, parent_operation = locator.get("retryOfRunId"), locator.get("retryOfOperationId")
                    if parent_run is not None:
                        if (metadata.get("retryOfRunId") != parent_run
                                or metadata.get("retryOfOperationId") != parent_operation
                                or original.regenerated_from != parent_run
                                or original.forked_from_run_id != parent_run):
                            raise AuthorityDenied()
                    elif (metadata.get("retryOfRunId") or metadata.get("retryOfOperationId")
                            or original.regenerated_from or original.forked_from_run_id):
                        raise AuthorityDenied()
                native = run_view(original)
                native["operationId"] = operation_id
                observed = str(getattr(original.status, "value", original.status)).upper()
                state = observed if observed in {"PENDING", "RUNNING", "COMPLETED", "CANCELLED", "ERROR"} else "unknown"
            elif discovered:
                # A candidate that disappeared before its PK/lineage check is
                # not a verified new locator. Keep the caller's ACK unresolved.
                run_id = None
        current = runtime["gateway"].authorize(user_id, operation="read")
        if current.get("execution", {}).get("sessionId") != row["sessionId"]:
            raise AuthorityDenied()
        return {"conversationId": ident, "sessionId": row["sessionId"], "operationId": operation_id, "runId": run_id, "state": state, "native": native,
            "readExpiresAt": current.get("readExpiresAt")}

