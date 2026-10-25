"""Private task-only admission to native AgentOS durable runs.

pg-boss schedules business tasks. This surface submits the stable task once to
the existing native run queue; it has no timer, model retry or second scheduler.
"""
import hmac
import json
import re
from urllib.parse import parse_qs
from uuid import UUID

import httpx
import jwt
from fastapi import Request
from fastapi.responses import JSONResponse

from .duties import task_context, BOUNDARY_VERSION
from .duty_storage import MODEL_STATES, duty_report_fields
from .gateway import AuthorityDenied, AuthorityUnavailable, autonomy_id
from .duty_continuation import continuation_tools, pending_tools
from .read_model import metadata as run_metadata


TASK_PATH = re.compile(r"/galaxy/autonomy/tasks/([0-9a-f-]{36})(?:/(runs|cancel|continue))?")


def duty_view(task_id, run=None, *, read_expires_at=None):
    raw = run.to_dict() if hasattr(run, "to_dict") else run or {}
    status = str(getattr(raw.get("status"), "value", raw.get("status")) or "NOT_RECORDED").upper()
    ident = raw.get("run_id")
    metadata = raw.get("metadata") or {}
    facts = run_metadata({"run_id": ident, "run_data": raw, "agent_id": raw.get("agent_id"),
        "user_id": raw.get("user_id"), "session_id": raw.get("session_id"), "status": status,
        "created_at": raw.get("created_at"), "updated_at": raw.get("updated_at")})
    return {"taskId": task_id, "operationId": task_id, "nativeRunId": ident, "runId": ident,
        "status": status, "modelState": MODEL_STATES.get(status, "not-started" if status == "NOT_RECORDED" else "unknown"),
        "awaitingHuman": status == "PAUSED", "continuable": status == "PAUSED" and bool(pending_tools(raw)), "readExpiresAt": read_expires_at,
        "boundaryVersion": BOUNDARY_VERSION,
        "run": {"runId": ident, "createdAt": raw.get("created_at"),
            "promptVersion": metadata.get("promptVersion"), "planVersion": metadata.get("planVersion"),
            "modelSettingsVersion": metadata.get("modelSettingsVersion"), "modelSettingsVersions": metadata.get("modelSettingsVersions"),
            "calls": facts["calls"], "tokens": facts["tokens"], "durationMs": facts["durationMs"]} if ident else None}


class DutySurface:
    def __init__(self, settings, runtime):
        self.settings, self.runtime = settings, runtime

    def matches(self, path):
        return path.startswith("/galaxy/autonomy/") or path.startswith("/agents/galaxy-duty/")

    async def handle(self, scope, receive, send, downstream):
        try:
            path, method = scope["path"], scope["method"]
            if scope.get("query_string"):
                raise AuthorityDenied()
            headers = [(key.lower(), value.decode()) for key, value in scope.get("headers", [])]
            def one(name):
                values = [value for key, value in headers if key == name.encode()]
                if len(values) != 1:
                    raise AuthorityDenied()
                return values[0]
            auth, service = one("authorization"), one("x-galaxy-service-key")
            if not auth.startswith("Bearer ") or not hmac.compare_digest(service, self.settings.service_key):
                raise AuthorityDenied()
            claims = jwt.decode(auth[7:], self.settings.verification_key, algorithms=["HS256"],
                audience=self.settings.audience, issuer=self.settings.issuer,
                options={"require": ["sub", "exp", "iat", "iss", "aud"]})
            user_id = claims["sub"]
            ident = autonomy_id(user_id)
            native = path == "/agents/galaxy-duty/runs"
            found = TASK_PATH.fullmatch(path)
            if (not native and (not found or found[1] != ident or method != ("POST" if found[2] else "GET"))
                    or native and method != "POST"):
                raise AuthorityDenied()
            if native and not hmac.compare_digest(one("x-galaxy-duty-internal"), self.settings.service_key):
                raise AuthorityDenied()
            operation = "run" if native or found and found[2] in {"runs", "continue"} else "read"
            result = task_context(self.runtime["gateway"], user_id, operation=operation)
            task = result["task"]
            if (claims.get("scope") != "task" or claims.get("taskId") != ident
                    or claims.get("planId") != task.get("planId") or claims.get("accountId") != task.get("aiAccountId")
                    or claims.get("delegationVersion") != task.get("delegationVersion")):
                raise AuthorityDenied()
            if method == "POST":
                chunks, size = [], 0
                while True:
                    part = await receive()
                    if part["type"] != "http.request":
                        raise AuthorityDenied()
                    size += len(part.get("body", b""))
                    if size > 4096:
                        return await JSONResponse({"error": "agentos_request_too_large"}, status_code=413)(scope, receive, send)
                    chunks.append(part.get("body", b""))
                    if not part.get("more_body"):
                        break
                body = b"".join(chunks)
                if native:
                    if one("content-type").split(";")[0] != "application/x-www-form-urlencoded":
                        raise AuthorityDenied()
                    values = parse_qs(body.decode(), keep_blank_values=True)
                    expected = {"message": [json.dumps({"taskId": ident})], "session_id": [task["sessionId"]],
                        "factory_input": [json.dumps({"taskId": ident})], "background": ["true"], "stream": ["false"]}
                    if values != expected or one("idempotency-key") != ident:
                        raise AuthorityDenied()
                elif one("content-type").split(";")[0] != "application/json" or json.loads(body or b"{}") != {} or one("idempotency-key") != ident:
                    raise AuthorityDenied()
                delivered = False
                async def replay():
                    nonlocal delivered
                    if not delivered:
                        delivered = True
                        return {"type": "http.request", "body": body, "more_body": False}
                    return await receive()
            else:
                replay = receive
            scope.setdefault("state", {})["galaxy_duty"] = result
            scope["state"]["galaxy_duty_user"] = user_id
            return await downstream(scope, replay, send)
        except AuthorityUnavailable:
            return await JSONResponse({"error": "agentos_authority_unavailable"}, status_code=503)(scope, receive, send)
        except (AuthorityDenied, jwt.PyJWTError, ValueError, KeyError, TypeError, UnicodeError):
            return await JSONResponse({"error": "agentos_current_authority_denied"}, status_code=403)(scope, receive, send)


def install_duty_routes(app, settings, runtime):
    gateway, db = runtime["gateway"], runtime["db"]

    def stored(ctx, user_id):
        rows = db.get_runs(session_id=ctx["task"]["sessionId"], user_id=user_id,
            agent_id="galaxy-duty", limit=2, page=1, sort_by="created_at", sort_order="asc")
        if len(rows) > 1:
            raise AuthorityDenied("agentos_autonomy_operation_conflict")
        return rows[0] if rows else None

    def view(request, run):
        ctx, user_id = request.state.galaxy_duty, request.state.galaxy_duty_user
        if run:
            try:
                gateway.duty_report(user_id, duty_report_fields(run.to_dict() if hasattr(run, "to_dict") else run))
            except (AuthorityDenied, AuthorityUnavailable):
                pass
        current = task_context(gateway, user_id, operation="read")
        return duty_view(ctx["task"]["taskId"], run, read_expires_at=current.get("readExpiresAt"))

    async def observed(ctx, user_id, request):
        run = stored(ctx, user_id)
        if run and str(getattr(run.status, "value", run.status)).upper() == "PAUSED":
            worker = getattr(request.app.state, "queue_worker", None)
            if worker is not None and getattr(worker, "store", None) is not None:
                # After the native continuation CAS, the run row can briefly
                # remain PAUSED until the worker stamps RUNNING. Read that
                # original ticket's facts so a health poll cannot re-pause the
                # Node task and cause its just-accepted factory claim to fail.
                ticket = await worker.store.get_job(run.run_id)
                if (ticket and ticket.get("component_type") == "agent" and ticket.get("component_id") == "galaxy-duty"
                        and ticket.get("session_id") == ctx["task"]["sessionId"] and ticket.get("user_id") == user_id
                        and (ticket.get("payload") or {}).get("continue") and ticket.get("status") in {"queued", "running"}):
                    raw = run.to_dict()
                    raw["status"] = "PENDING" if ticket["status"] == "queued" else "RUNNING"
                    return raw
        return run

    @app.get("/galaxy/autonomy/tasks/{task_id}")
    async def read_duty(task_id: str, request: Request):
        if request.state.galaxy_duty["task"].get("mode") == "code":
            ctx = task_context(gateway, request.state.galaxy_duty_user, operation="read")
            task = ctx["task"]
            status = {"completed": "COMPLETED", "waiting-human": "PAUSED", "paused": "PAUSED",
                "failed": "ERROR", "stopped": "CANCELLED", "running": "RUNNING", "queued": "PENDING"}.get(task.get("state"), "UNKNOWN")
            return {"taskId": task_id, "operationId": task_id, "nativeRunId": None, "runId": None,
                "status": status, "modelState": "not-required", "awaitingHuman": status == "PAUSED", "readExpiresAt": ctx.get("readExpiresAt")}
        return view(request, await observed(request.state.galaxy_duty, request.state.galaxy_duty_user, request))

    @app.post("/galaxy/autonomy/tasks/{task_id}/runs")
    async def start_duty(task_id: str, request: Request):
        ctx, user_id = request.state.galaxy_duty, request.state.galaxy_duty_user
        if ctx["task"].get("mode") == "code":
            # Fixed rules execute on Node's exact task/condition/domain seam.
            # No Agent, model or native queue ticket is created for this branch.
            value = gateway.duty_code(user_id)
            if value.get("taskId") != task_id or value.get("modelState") != "not-required":
                return JSONResponse({"error": "agentos_autonomy_code_result_invalid"}, status_code=503)
            return {key: value.get(key) for key in ("taskId", "operationId", "nativeRunId", "status", "modelState", "awaitingHuman", "readExpiresAt")}
        prior = stored(ctx, user_id)
        if prior:
            return view(request, await observed(ctx, user_id, request))
        if getattr(request.app.state, "queue_worker", None) is None:
            return JSONResponse({"error": "agentos_durable_queue_unavailable"}, status_code=503)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agentos.internal") as client:
            response = await client.post("/agents/galaxy-duty/runs", headers={
                "Authorization": request.headers["authorization"], "Idempotency-Key": task_id,
                "X-Galaxy-Service-Key": settings.service_key, "X-Galaxy-Duty-Internal": settings.service_key},
                data={"message": json.dumps({"taskId": task_id}), "session_id": ctx["task"]["sessionId"],
                    "factory_input": json.dumps({"taskId": task_id}), "background": "true", "stream": "false"})
        if response.status_code not in {200, 202}:
            return JSONResponse({"error": "agentos_autonomy_dispatch_unknown"}, status_code=503)
        data = response.json()
        return JSONResponse(duty_view(task_id, {"run_id": data.get("run_id"), "status": data.get("status")},
            read_expires_at=ctx.get("readExpiresAt")), status_code=response.status_code)

    @app.post("/galaxy/autonomy/tasks/{task_id}/cancel")
    async def cancel_duty(task_id: str, request: Request):
        ctx, user_id = request.state.galaxy_duty, request.state.galaxy_duty_user
        if ctx["task"].get("mode") == "code":
            return await read_duty(task_id, request)
        run = stored(ctx, user_id)
        if run:
            # Native cancellation after Node has fenced this task. A stopped
            # plan cannot pass agents:run again just to stop its old run.
            from agno.agent._run import acancel_run
            worker = getattr(request.app.state, "queue_worker", None)
            if worker is not None:
                await worker.acancel_queued(run.run_id)
            await acancel_run(run.run_id)
        return view(request, stored(ctx, user_id))

    @app.post("/galaxy/autonomy/tasks/{task_id}/continue")
    async def continue_duty(task_id: str, request: Request):
        ctx, user_id = request.state.galaxy_duty, request.state.galaxy_duty_user
        if ctx["task"].get("mode") == "code":
            return JSONResponse({"error": "agentos_autonomy_run_not_continuable"}, status_code=409)
        original = stored(ctx, user_id)
        try:
            tools = continuation_tools(ctx["task"], original)
        except AuthorityDenied:
            return JSONResponse({"error": "agentos_autonomy_human_decision_required"}, status_code=409)
        worker = getattr(request.app.state, "queue_worker", None)
        if worker is None:
            return JSONResponse({"error": "agentos_durable_queue_unavailable"}, status_code=503)
        # This is the native durable continuation CAS, with no detached/inline
        # fallback. Requirements are reconstructed from current Node facts;
        # the HTTP caller never supplies tools, approvals or a replacement ID.
        from agno.os.authz.provider import AuthorizationContext
        from agno.os.job_queue import acontinue_via_queue
        from agno.run.authorization import RunAuthorization, authorization_scope
        from .authorization import GalaxyAuthorization
        authority = RunAuthorization(provider=GalaxyAuthorization(gateway),
            context=AuthorizationContext(principal_id=user_id), enforce_tools=False)
        with authorization_scope(lambda: authority):
            accepted = await acontinue_via_queue(worker, original.run_id,
                {"updated_tools": tools, "input": None, "continue_from": "end", "kwargs": {}},
                stream_requested=False, component_type="agent", component_id="galaxy-duty")
        if not accepted or accepted.get("outcome") not in {"queued", "attach"}:
            return JSONResponse({"error": "agentos_autonomy_continue_not_accepted"}, status_code=409)
        raw = original.to_dict()
        raw["status"] = "PENDING"
        return JSONResponse(duty_view(task_id, raw, read_expires_at=ctx.get("readExpiresAt")), status_code=202)

    return DutySurface(settings, runtime)
