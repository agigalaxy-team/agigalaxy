"""Private metadata lookup for the original native durable conversation run."""
from uuid import UUID

from fastapi import Request
from fastapi.responses import JSONResponse
from sqlalchemy import select

from .gateway import AuthorityDenied, AuthorityUnavailable


def install_conversation_transport_read(app, runtime, run_view):
    @app.get("/galaxy/conversations/{ident}/operations/{operation_id}")
    async def original_conversation_run(ident: str, operation_id: str, request: Request):
        row, user_id = request.state.galaxy_execution, request.state.galaxy_user_id
        if row.get("mode") != "conversation" or row["id"] != ident:
            raise AuthorityDenied()
        try:
            if str(UUID(operation_id)) != operation_id:
                raise ValueError()
        except (ValueError, TypeError):
            return JSONResponse({"error": "agentos_query_invalid"}, status_code=400)
        before = runtime["gateway"].authorize(user_id, operation="read")
        if before.get("execution", {}).get("sessionId") != row["sessionId"]:
            raise AuthorityDenied()
        db = runtime["db"]
        table = db._get_table(table_type="jobs", create_table_if_not_found=False)
        required = {"id", "idempotency_key", "user_id", "session_id", "component_type", "component_id", "status"}
        if table is None or not required.issubset(table.c.keys()):
            raise AuthorityUnavailable("agentos_queue_lookup_unavailable")
        # Use the native queue's unique idempotency key and exact user/session/
        # component binding. No input, tool payload or other queue rows leave.
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
        native = None
        if found:
            item = found[0]._mapping
            stored = db.get_run(run_id=item["id"], deserialize=False)
            if stored is not None:
                if (stored.get("user_id") != user_id or stored.get("session_id") != row["sessionId"]
                        or stored.get("agent_id") != "galaxy-conversation-" + row["domain"]):
                    raise AuthorityDenied()
                from agno.run.agent import RunOutput
                original = RunOutput.from_dict(stored.get("run_data") or {})
                if (original.run_id != item["id"]
                        or (original.metadata or {}).get("operationId") not in {None, operation_id}):
                    raise AuthorityDenied()
                native = run_view(original)
                native["operationId"] = operation_id
        current = runtime["gateway"].authorize(user_id, operation="read")
        if current.get("execution", {}).get("sessionId") != row["sessionId"]:
            raise AuthorityDenied()
        if not found:
            return {"operationId": operation_id, "runId": None, "state": "not-recorded", "native": None,
                "readExpiresAt": current.get("readExpiresAt")}
        from agno.os.job_queue import ticket_status_to_api
        item = found[0]._mapping
        state = ticket_status_to_api(item["status"])
        if state not in {"PENDING", "RUNNING", "COMPLETED", "CANCELLED", "ERROR"}:
            state = "unknown"
        return {"operationId": operation_id, "runId": item["id"], "state": state, "native": native,
            "readExpiresAt": current.get("readExpiresAt")}

