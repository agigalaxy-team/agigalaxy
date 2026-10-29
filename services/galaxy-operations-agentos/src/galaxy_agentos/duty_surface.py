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
from .duty_attempt import AttemptGateway, attempt_id
from .duty_storage import MODEL_STATES, duty_report_fields, manual_pause_marker, manual_resume_consumed
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
        "sessionId": raw.get("session_id"), "nativeAttemptId": attempt_id(metadata.get("nativeAttemptId")),
        "status": status, "modelState": MODEL_STATES.get(status, "not-started" if status == "NOT_RECORDED" else "unknown"),
        "awaitingHuman": status == "PAUSED", "continuable": status == "PAUSED" and bool(pending_tools(raw)), "readExpiresAt": read_expires_at,
        **({"manualPause": marker} if status == "PAUSED" and (marker := manual_pause_marker(metadata.get("manualPause"))) else {}),
        **({"manualResumeConsumed": consumed} if status == "RUNNING" and (consumed := manual_resume_consumed(metadata.get("manualResumeConsumed"))) else {}),
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
            bound_gateway = AttemptGateway(self.runtime["gateway"], claims.get("nativeAttemptId"))
            result = task_context(bound_gateway, user_id, operation=operation)
            task = result["task"]
            if (claims.get("scope") != "task" or claims.get("taskId") != ident
                    or claims.get("planId") != task.get("planId") or claims.get("accountId") != task.get("aiAccountId")
                    or claims.get("delegationVersion") != task.get("delegationVersion")
                    or attempt_id(task.get("nativeAttemptId")) != bound_gateway.attempt):
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
                    if values != expected or one("idempotency-key") != (bound_gateway.attempt or ident):
                        raise AuthorityDenied()
                elif one("content-type").split(";")[0] != "application/json" or json.loads(body or b"{}") != {} or one("idempotency-key") != (bound_gateway.attempt or ident):
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
            scope["state"]["galaxy_duty_gateway"] = bound_gateway
            return await downstream(scope, replay, send)
        except AuthorityUnavailable:
            return await JSONResponse({"error": "agentos_authority_unavailable"}, status_code=503)(scope, receive, send)
        except (AuthorityDenied, jwt.PyJWTError, ValueError, KeyError, TypeError, UnicodeError):
            return await JSONResponse({"error": "agentos_current_authority_denied"}, status_code=403)(scope, receive, send)


def install_duty_routes(app, settings, runtime):
    gateway, db = runtime["gateway"], runtime["db"]

    def ticket_attempt(ticket, ctx, user_id):
        task = ctx["task"]
        attempt = attempt_id(task.get("nativeAttemptId"))
        scope = ((ticket or {}).get("payload") or {}).get("scope") or {}
        source, signed = scope.get("context") or {}, (scope.get("context") or {}).get("claims") or {}
        if (not ticket or ticket.get("component_type") != "agent" or ticket.get("component_id") != "galaxy-duty"
                or ticket.get("user_id") != user_id or ticket.get("session_id") != task["sessionId"]
                or ticket.get("idempotency_key") != (attempt or task["taskId"]) or scope.get("source") != "factory"
                or source.get("user_id") != user_id or source.get("session_id") != task["sessionId"]
                or source.get("input") != {"taskId": task["taskId"]}
                or signed.get("sub") != user_id or signed.get("taskId") != task["taskId"]
                or attempt_id(signed.get("nativeAttemptId")) != attempt):
            raise AuthorityDenied("agentos_autonomy_operation_conflict")
        return attempt_id(signed.get("nativeAttemptId"))

    async def stored(ctx, user_id, request):
        rows = db.get_runs(session_id=ctx["task"]["sessionId"], user_id=user_id,
            agent_id="galaxy-duty", limit=2, page=1, sort_by="created_at", sort_order="asc")
        if len(rows) > 1:
            raise AuthorityDenied("agentos_autonomy_operation_conflict")
        worker = getattr(request.app.state, "queue_worker", None)
        store = getattr(worker, "store", None)
        if rows:
            raw = rows[0].to_dict() if hasattr(rows[0], "to_dict") else rows[0]
            metadata = raw.get("metadata") or {}
            current_attempt = attempt_id(ctx["task"].get("nativeAttemptId"))
            if raw.get("session_id") != ctx["task"]["sessionId"]:
                raise AuthorityDenied("agentos_autonomy_operation_conflict")
            if attempt_id(metadata.get("nativeAttemptId")) != current_attempt:
                # Before factory execution only this run's original ticket can
                # establish its signed attempt; do not borrow current task data.
                ticket = await store.get_job(raw.get("run_id")) if store and raw.get("run_id") else None
                if metadata.get("nativeAttemptId") is not None or not current_attempt or not ticket or ticket.get("id") != raw.get("run_id"):
                    raise AuthorityDenied("agentos_autonomy_operation_conflict")
                raw["metadata"] = {**metadata, "nativeAttemptId": ticket_attempt(ticket, ctx, user_id)}
                return raw
            return rows[0]
        # A committed ticket can precede creation of its native run row.
        # Look up only this task's fixed session and user; ambiguity is not a
        # license to choose a different accepted job.
        if store and hasattr(store, "list_jobs"):
            jobs, count = await store.list_jobs(session_id=ctx["task"]["sessionId"], user_id=user_id,
                limit=2, page=1, raise_on_error=True)
            if count > 1:
                raise AuthorityDenied("agentos_autonomy_operation_conflict")
            if jobs:
                ticket = jobs[0]
                attempt = ticket_attempt(ticket, ctx, user_id)
                if ticket.get("status") not in {"queued", "running"} or not ticket.get("id"):
                    raise AuthorityUnavailable("agentos_autonomy_original_run_unavailable")
                return {"run_id": ticket["id"], "session_id": ticket["session_id"],
                    "status": "PENDING" if ticket["status"] == "queued" else "RUNNING",
                    "metadata": {"nativeAttemptId": attempt}}
        return None

    def view(request, run, *, report=True):
        ctx, user_id = request.state.galaxy_duty, request.state.galaxy_duty_user
        if run and report:
            try:
                gateway.duty_report(user_id, duty_report_fields(run.to_dict() if hasattr(run, "to_dict") else run))
            except (AuthorityDenied, AuthorityUnavailable):
                pass
        current = task_context(request.state.galaxy_duty_gateway, user_id, operation="read")
        return duty_view(ctx["task"]["taskId"], run, read_expires_at=current.get("readExpiresAt"))

    async def observed(ctx, user_id, request):
        run = await stored(ctx, user_id, request)
        raw = run.to_dict() if hasattr(run, "to_dict") else run or {}
        status = raw.get("status")
        if run and str(getattr(status, "value", status)).upper() == "PAUSED":
            worker = getattr(request.app.state, "queue_worker", None)
            if worker is not None and getattr(worker, "store", None) is not None:
                # After the native continuation CAS, the run row can briefly
                # remain PAUSED until the worker stamps RUNNING. Read that
                # original ticket's facts so a health poll cannot re-pause the
                # Node task and cause its just-accepted factory claim to fail.
                ticket = await worker.store.get_job(raw.get("run_id"))
                if (ticket and ticket.get("component_type") == "agent" and ticket.get("component_id") == "galaxy-duty"
                        and ticket.get("session_id") == ctx["task"]["sessionId"] and ticket.get("user_id") == user_id
                        and (ticket.get("payload") or {}).get("continue") and ticket.get("status") in {"queued", "running"}):
                    raw["status"] = "PENDING" if ticket["status"] == "queued" else "RUNNING"
                    return raw
        return run

    @app.get("/galaxy/autonomy/tasks/{task_id}")
    async def read_duty(task_id: str, request: Request):
        if request.state.galaxy_duty["task"].get("mode") == "code":
            ctx = task_context(request.state.galaxy_duty_gateway, request.state.galaxy_duty_user, operation="read")
            task = ctx["task"]
            status = {"completed": "COMPLETED", "waiting-human": "PAUSED", "paused": "PAUSED",
                "failed": "ERROR", "stopped": "CANCELLED", "running": "RUNNING", "queued": "PENDING"}.get(task.get("state"), "UNKNOWN")
            return {"taskId": task_id, "operationId": task_id, "nativeRunId": None, "runId": None,
                "status": status, "modelState": "not-required", "awaitingHuman": status == "PAUSED", "readExpiresAt": ctx.get("readExpiresAt")}
        return view(request, await observed(request.state.galaxy_duty, request.state.galaxy_duty_user, request), report=False)

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
        prior = await stored(ctx, user_id, request)
        if prior:
            return view(request, await observed(ctx, user_id, request))
        if getattr(request.app.state, "queue_worker", None) is None:
            return JSONResponse({"error": "agentos_durable_queue_unavailable"}, status_code=503)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agentos.internal") as client:
            response = await client.post("/agents/galaxy-duty/runs", headers={
                "Authorization": request.headers["authorization"], "Idempotency-Key": attempt_id(ctx["task"].get("nativeAttemptId")) or task_id,
                "X-Galaxy-Service-Key": settings.service_key, "X-Galaxy-Duty-Internal": settings.service_key},
                data={"message": json.dumps({"taskId": task_id}), "session_id": ctx["task"]["sessionId"],
                    "factory_input": json.dumps({"taskId": task_id}), "background": "true", "stream": "false"})
        if response.status_code not in {200, 202}:
            return JSONResponse({"error": "agentos_autonomy_dispatch_unknown"}, status_code=503)
        data = response.json()
        return JSONResponse(duty_view(task_id, {"run_id": data.get("run_id"), "status": data.get("status"), "session_id": ctx["task"]["sessionId"],
            "metadata": {"nativeAttemptId": ctx["task"].get("nativeAttemptId")}},
            read_expires_at=ctx.get("readExpiresAt")), status_code=response.status_code)

    @app.post("/galaxy/autonomy/tasks/{task_id}/cancel")
    async def cancel_duty(task_id: str, request: Request):
        ctx, user_id = request.state.galaxy_duty, request.state.galaxy_duty_user
        if ctx["task"].get("mode") == "code":
            return await read_duty(task_id, request)
        run = await stored(ctx, user_id, request)
        if run:
            # Native cancellation after Node has fenced this task. A stopped
            # plan cannot pass agents:run again just to stop its old run.
            from agno.agent._run import acancel_run
            worker = getattr(request.app.state, "queue_worker", None)
            raw = run.to_dict() if hasattr(run, "to_dict") else run
            run_id = raw.get("run_id")
            if worker is not None:
                await worker.acancel_queued(run_id)
            await acancel_run(run_id)
        return view(request, await stored(ctx, user_id, request))

    @app.post("/galaxy/autonomy/tasks/{task_id}/continue")
    async def continue_duty(task_id: str, request: Request):
        ctx, user_id = request.state.galaxy_duty, request.state.galaxy_duty_user
        if ctx["task"].get("mode") == "code":
            return JSONResponse({"error": "agentos_autonomy_run_not_continuable"}, status_code=409)
        original = await stored(ctx, user_id, request)
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
            context=AuthorizationContext(principal_id=user_id, claims={"nativeAttemptId": request.state.galaxy_duty_gateway.attempt}), enforce_tools=False)
        with authorization_scope(lambda: authority):
            accepted = await acontinue_via_queue(worker, original.run_id,
                {"updated_tools": tools, "input": None, "continue_from": "end", "kwargs": {}},
                stream_requested=False, component_type="agent", component_id="galaxy-duty")
        if not accepted or accepted.get("outcome") not in {"queued", "attach"}:
            return JSONResponse({"error": "agentos_autonomy_continue_not_accepted"}, status_code=409)
        raw = original.to_dict()
        raw["status"] = "PENDING"
        return JSONResponse(view(request, raw), status_code=202)

    return DutySurface(settings, runtime)
