"""Narrow HTTP seam to the native, durable Workflow routes.

Installed by the AgentOS application only in a release that also registers the
P13 workflow. It does not accept policies, source text, tools or approval JSON.
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
from agno.run.workflow import WorkflowRunOutput

from .gateway import AuthorityDenied, execution_id
from .p13_strategies import WORKFLOW_ID, WORKFLOW_VERSION
from . import p13_continuation


def native_view(run):
    status = getattr(run.status, "value", run.status)
    steps = []
    def project(values):
        for step in values or []:
            if isinstance(step, list):
                project(step)
                continue
            steps.append({"name": step.step_name, "success": step.success is True,
                "type": getattr(step.step_type, "value", step.step_type)})
            project(step.steps)
    project(run.step_results)
    active = run.active_step_requirements
    needs_input = any(r.requires_user_input or r.requires_output_review and isinstance(getattr(r.step_output, "content", None), dict)
        and r.step_output.content.get("requiresInput") is True for r in active)
    return {"runId": run.run_id, "status": status, "awaitingHuman": status == "PAUSED", "steps": steps,
        "currentStep": active[-1].step_name if active else None,
        "pauseKind": ("input" if needs_input else "confirmation") if status == "PAUSED" else None,
        "pauseId": p13_continuation.pause_id(run) if status == "PAUSED" else None,
        "workflowId": WORKFLOW_ID, "workflowVersion": WORKFLOW_VERSION}


class P13StrategySurface:
    def __init__(self, settings, runtime):
        self.settings, self.runtime = settings, runtime

    def matches(self, path):
        return path.startswith("/galaxy/p13-strategies/") or path.startswith("/workflows/" + WORKFLOW_ID + "/")

    def context(self, ident, user_id, operation, continuation_operation_id=None):
        return self.runtime["gateway"].request("p13/context", {
            "runId": str(UUID(ident)), "executionId": execution_id(user_id), "operation": operation,
            **({"continuationOperationId": continuation_operation_id} if continuation_operation_id else {})})

    async def handle(self, scope, receive, send, downstream):
        try:
            if scope.get("query_string"):
                raise AuthorityDenied()
            headers = [(k.lower(), v) for k, v in scope.get("headers", [])]
            auth = [v.decode() for k, v in headers if k == b"authorization"]
            if len(auth) != 1 or not auth[0].startswith("Bearer "):
                raise AuthorityDenied()
            claims = jwt.decode(auth[0][7:], self.settings.verification_key, algorithms=["HS256"],
                audience=self.settings.audience, issuer=self.settings.issuer,
                options={"require": ["sub", "exp", "iat", "iss", "aud"]})
            user_id = claims["sub"]
            execution_id(user_id)
            path, method = scope["path"], scope["method"]
            native = path.startswith("/workflows/")
            continuation_operation_id = None
            if native:
                internal = [v.decode() for k, v in headers if k == b"x-galaxy-p13-internal"]
                refs = [v.decode() for k, v in headers if k == b"x-galaxy-p13-matter"]
                if len(internal) != 1 or not hmac.compare_digest(internal[0], self.settings.service_key) or len(refs) != 1:
                    raise AuthorityDenied()
                ident = str(UUID(refs[0]))
                if not re.fullmatch(r"/workflows/" + WORKFLOW_ID + r"/runs(?:/[A-Za-z0-9_-]{1,128}/continue)?", path) or method != "POST":
                    raise AuthorityDenied()
            else:
                found = re.fullmatch(r"/galaxy/p13-strategies/([a-f0-9-]{36})(?:/(start|continue)|/continuations/([a-f0-9-]{36}))?", path)
                if not found or method != ("POST" if found[2] else "GET"):
                    raise AuthorityDenied()
                ident = str(UUID(found[1]))
                if found[3]:
                    continuation_operation_id = str(UUID(found[3]))
            if path.endswith("/continue"):
                keys = [v.decode() for k, v in headers if k == b"idempotency-key"]
                if len(keys) != 1:
                    raise AuthorityDenied()
                continuation_operation_id = str(UUID(keys[0]))
            current = self.context(ident, user_id, "read" if method == "GET" else "run", continuation_operation_id)
            scope.setdefault("state", {})["p13_context"] = current
            scope["state"]["p13_user_id"] = user_id
            if method == "POST":
                chunks, length = [], 0
                while True:
                    item = await receive()
                    if item["type"] != "http.request":
                        raise AuthorityDenied()
                    length += len(item.get("body", b""))
                    if length > 16384:
                        raise AuthorityDenied()
                    chunks.append(item.get("body", b""))
                    if not item.get("more_body"):
                        break
                body = b"".join(chunks)
                content_type = [v.decode().split(";")[0] for k, v in headers if k == b"content-type"]
                if content_type != ["application/x-www-form-urlencoded"]:
                    raise AuthorityDenied()
                fields = parse_qs(body.decode(), keep_blank_values=True)
                allowed = {"session_id", "message", "background", "stream", "step_requirements"} if native else ({"session_id", "confirmed", "input_decision"} if path.endswith("/continue") else {"session_id"})
                if set(fields) - allowed or any(len(values) != 1 for values in fields.values()) or fields.get("session_id") != [current["sessionId"]]:
                    raise AuthorityDenied()
                if native and (fields.get("background") != ["true"] or fields.get("stream") != ["false"]):
                    raise AuthorityDenied()
                if native and path.endswith("/runs") and json.loads(fields.get("message", ["null"])[0]) != {"runId": ident}:
                    raise AuthorityDenied()
                sent = False
                async def replay():
                    nonlocal sent
                    if not sent:
                        sent = True
                        return {"type": "http.request", "body": body, "more_body": False}
                    return await receive()
                return await downstream(scope, replay, send)
            return await downstream(scope, receive, send)
        except (AuthorityDenied, jwt.PyJWTError, ValueError, KeyError):
            return await JSONResponse({"error": "p13_current_authority_denied"}, status_code=403)(scope, receive, send)


def install_p13_routes(app, settings, runtime):
    surface = P13StrategySurface(settings, runtime)
    durable_continuations = p13_continuation.install(runtime["db"])

    def stored(ctx, user_id):
        rows = runtime["db"].get_runs(session_id=ctx["sessionId"], user_id=user_id,
            workflow_id=WORKFLOW_ID, limit=1, page=1, sort_by="created_at", sort_order="desc")
        return rows[0] if rows else None

    async def native_request(request, ctx, path, fields):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agentos.internal") as client:
            result = await client.post(path, headers={"Authorization": request.headers["authorization"],
                "Idempotency-Key": request.headers.get("idempotency-key", ctx["runId"]), "X-Galaxy-P13-Matter": ctx["runId"],
                "X-Galaxy-P13-Internal": settings.service_key}, data=fields)
        if result.status_code not in {200, 202}:
            return JSONResponse({"error": "p13_native_transition_failed"}, status_code=503)
        data = result.json()
        return JSONResponse({"runId": data.get("run_id"), "status": data.get("status"),
            "workflowId": WORKFLOW_ID, "workflowVersion": WORKFLOW_VERSION}, status_code=result.status_code)

    @app.get("/galaxy/p13-strategies/{ident}")
    async def read_strategy_run(ident: str, request: Request):
        ctx, user_id = request.state.p13_context, request.state.p13_user_id
        run = stored(ctx, user_id)
        # The gateway rechecks current authority again after native reads.
        surface.context(ident, user_id, "read")
        return native_view(run) if run else {"runId": None, "status": "NOT_RECORDED", "awaitingHuman": False,
            "workflowId": WORKFLOW_ID, "workflowVersion": WORKFLOW_VERSION}

    @app.post("/galaxy/p13-strategies/{ident}/start")
    async def start_strategy_run(ident: str, request: Request):
        ctx, user_id = request.state.p13_context, request.state.p13_user_id
        existing = stored(ctx, user_id)
        if existing:
            return native_view(existing)
        # There is no implicit model and no queue acceptance for a semantic
        # branch while its domain model is absent. Code/human routes work empty.
        if ctx["route"] == "ai" and not runtime["strategyModelConfigured"]:
            return JSONResponse({"error": "agentos_model_not_configured"}, status_code=503)
        return await native_request(request, ctx, "/workflows/" + WORKFLOW_ID + "/runs",
            {"message": json.dumps({"runId": ident}), "session_id": ctx["sessionId"], "stream": "false", "background": "true"})

    @app.post("/galaxy/p13-strategies/{ident}/continue")
    async def continue_strategy_run(ident: str, request: Request):
        ctx, user_id = request.state.p13_context, request.state.p13_user_id
        if not durable_continuations:
            return JSONResponse({"error": "p13_durable_continuation_unavailable"}, status_code=503)
        try:
            value = p13_continuation.binding(ctx, user_id)
            original = p13_continuation.receipt(runtime["db"], value)
        except p13_continuation.ContinuationConflict:
            return JSONResponse({"error": "p13_continuation_conflict"}, status_code=409)
        form = await request.form()
        if (form.get("confirmed") in {"true", "false"}) == (form.get("input_decision") in {"proceed", "no-action"}):
            return JSONResponse({"error": "p13_confirmation_invalid"}, status_code=400)
        expected = {"input_decision": value["inputDecision"]} if "inputDecision" in value else {"confirmed": str(value["confirmed"]).lower()}
        if any(form.get(key) != expected.get(key) for key in ("confirmed", "input_decision")):
            return JSONResponse({"error": "p13_continuation_conflict"}, status_code=409)
        # Original receipt precedes PAUSED checks: a lost 202 response must not
        # reject the same decision once the native worker has already advanced.
        if original["state"] != "not-recorded":
            return JSONResponse(original, status_code=200 if original["state"] == "accepted" else 503)
        run = stored(ctx, user_id)
        if (not run or run.run_id != value["nativeRunId"] or getattr(run.status, "value", run.status) != "PAUSED"
                or p13_continuation.pause_id(run) != value["pauseId"]):
            return JSONResponse({"error": "p13_run_not_paused"}, status_code=409)
        requirements = run.active_step_requirements
        if len(requirements) != 1:
            return JSONResponse({"error": "p13_pause_requirement_invalid"}, status_code=409)
        input_pause = native_view(run)["pauseKind"] == "input"
        if input_pause:
            if form.get("input_decision") not in {"proceed", "no-action"}:
                return JSONResponse({"error": "p13_confirmation_invalid"}, status_code=400)
            # The closed business choice is recorded by Node before this
            # native acknowledgement. No edited output/approval JSON is trusted.
            requirements[0].confirm()
        else:
            if form.get("confirmed") not in {"true", "false"}:
                return JSONResponse({"error": "p13_confirmation_invalid"}, status_code=400)
            requirements[0].confirm() if form["confirmed"] == "true" else requirements[0].reject()
        token = p13_continuation.enter(value)
        try:
            result = await native_request(request, ctx, "/workflows/" + WORKFLOW_ID + "/runs/" + run.run_id + "/continue",
                {"session_id": ctx["sessionId"], "stream": "false", "background": "true",
                    "step_requirements": json.dumps([r.to_dict() for r in requirements])})
        finally:
            p13_continuation.leave(token)
        # The immutable receipt wins over a failed/lost HTTP response after the
        # original queue CAS committed. Never run another continuation here.
        current = p13_continuation.receipt(runtime["db"], value)
        return JSONResponse(current, status_code=202) if current["state"] == "accepted" else result

    @app.get("/galaxy/p13-strategies/{ident}/continuations/{operation_id}")
    async def read_continuation(ident: str, operation_id: str, request: Request):
        if not durable_continuations:
            return JSONResponse({"error": "p13_durable_continuation_unavailable"}, status_code=503)
        ctx, user_id = request.state.p13_context, request.state.p13_user_id
        try:
            value = p13_continuation.binding(ctx, user_id)
            result = p13_continuation.receipt(runtime["db"], value)
        except p13_continuation.ContinuationConflict:
            return JSONResponse({"error": "p13_continuation_conflict"}, status_code=409)
        surface.context(ident, user_id, "read", str(UUID(operation_id)))
        return result

    return surface
