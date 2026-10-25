import json
import re
import hmac
import math
from urllib.parse import parse_qs

import jwt
import httpx
from fastapi import Request, Query
from fastapi.responses import JSONResponse
from agno.run.workflow import WorkflowRunOutput

from .config import Settings
from .gateway import AuthorityDenied, AuthorityUnavailable, execution_id, conversation_id
from .conversations import install_conversation_read
from .conversation_failures import failure_view
from .conversation_transport import install_conversation_transport_read
from .conversation_references import user_public_references
from .runtime import create_runtime
from .p13_strategy_surface import install_p13_routes
from .p13_strategies import p13_health
from .duty_surface import install_duty_routes
from .model_settings import model_settings_view, configured_domains


def _completed_conversation_content(run, status, fallback):
    if str(status).upper() != "COMPLETED" or getattr(run, "agent_id", None) not in {
            "galaxy-conversation-overview", "galaxy-conversation-governance",
            "galaxy-conversation-messaging", "galaxy-conversation-discovery",
            "galaxy-conversation-maintenance"}:
        return fallback
    messages = getattr(run, "messages", None)
    if not isinstance(messages, (list, tuple)):
        return fallback
    for message in reversed(messages):
        role = message.get("role") if isinstance(message, dict) else getattr(message, "role", None)
        calls = message.get("tool_calls") if isinstance(message, dict) else getattr(message, "tool_calls", None)
        if role == "assistant" and not calls:
            content = message.get("content") if isinstance(message, dict) else getattr(message, "content", None)
            return content if isinstance(content, str) else fallback
    return fallback


def run_view(run):
    status = getattr(run.status, "value", run.status)
    content = run.content if isinstance(run.content, str) and str(status).upper() != "ERROR" else None
    content = _completed_conversation_content(run, status, content)
    events = []
    error_code = "operations_agentos_run_failed" if str(status).upper() == "ERROR" else None
    failure = failure_view(run.content) if error_code and getattr(run, "agent_id", None) in {
        "galaxy-conversation-overview", "galaxy-conversation-governance",
        "galaxy-conversation-messaging", "galaxy-conversation-discovery",
        "galaxy-conversation-maintenance"} else None
    if failure:
        error_code = "operations_agentos_model_request_failed"
    for event in getattr(run, "events", None) or []:
        event_name = getattr(event, "event", None)
        error_type = getattr(event, "error_type", None)
        if error_code and error_type == "AuthorityUnavailable":
            error_code = "operations_authorization_unavailable"
        elif error_code and error_type == "AuthorityDenied":
            error_code = "operations_agentos_authority_changed"
        if event_name and "Reasoning" not in event_name:
            events.append({"event": event_name, "eventIndex": getattr(event, "event_index", None),
                "createdAt": getattr(event, "created_at", None)})
    if error_code != "operations_agentos_model_request_failed":
        failure = None
    raw_metrics = getattr(run, "metrics", None)
    def metric(key):
        return raw_metrics.get(key) if isinstance(raw_metrics, dict) else getattr(raw_metrics, key, None)
    def tokens(key):
        value = metric(key)
        return value if type(value) is int and value >= 0 else None
    # Native counts start at zero even with no reported usage. Only expose
    # token fields when per-model metrics and a positive count were recorded.
    reported = bool(metric("details")) and any((tokens(key) or 0) > 0
        for key in ("input_tokens", "output_tokens", "total_tokens"))
    duration = metric("duration")
    duration_ms = duration * 1000 if type(duration) in {int, float} and math.isfinite(duration) and duration >= 0 else None
    calls = (getattr(run, "metadata", None) or {}).get("modelCalls")
    if type(calls) is not int or calls < 0:
        calls = None
    return {"runId": run.run_id, "status": status, "content": content,
        "operationId": (getattr(run, "metadata", None) or {}).get("operationId"),
        "userInput": getattr(getattr(run, "input", None), "input_content", None) if isinstance(getattr(getattr(run, "input", None), "input_content", None), str) else None,
        "createdAt": getattr(run, "created_at", None), "events": events,
        "metrics": {"inputTokens": tokens("input_tokens") if reported else None,
            "outputTokens": tokens("output_tokens") if reported else None,
            "totalTokens": tokens("total_tokens") if reported else None, "durationMs": duration_ms},
        "usage": {"calls": calls,
            "inputTokens": tokens("input_tokens") if reported else None,
            "outputTokens": tokens("output_tokens") if reported else None,
            "totalTokens": tokens("total_tokens") if reported else None, "durationMs": duration_ms},
        "errorCode": error_code, "failure": failure,
        "awaitingHuman": status == "PAUSED" or str(status).lower() == "paused"}


class PrivateSurface:
    """Restrict the native API to server-bound executions and fixed form fields.

    Native session isolation is retained. No browser token/role, client tools,
    injected dependencies, arbitrary metadata, uploads, or factory inputs enter.
    """
    def __init__(self, app, settings, runtime):
        self.app, self.settings, self.runtime = app, settings, runtime

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            if scope["type"] == "lifespan":
                return await self.app(scope, receive, send)
            return
        path, method = scope["path"], scope["method"]
        if self.runtime.get("dutySurface") and self.runtime["dutySurface"].matches(path):
            return await self.runtime["dutySurface"].handle(scope, receive, send, self.app)
        if self.runtime.get("p13Surface") and self.runtime["p13Surface"].matches(path):
            return await self.runtime["p13Surface"].handle(scope, receive, send, self.app)
        if path == "/health" and method == "GET":
            return await JSONResponse({"state": "running", "framework": "agno", "version": "3.1.7",
                "model": "configured" if configured_domains(self.settings) else "not-configured",
                "persistence": "native-database", "queue": "native-durable", "traces": "metadata-only",
                "modelSettings": model_settings_view(self.settings), "strategies": p13_health(self.runtime),
                "autonomy": {"version": 1, "componentId": "galaxy-duty", "scheduler": "pg-boss",
                    "taskIdentity": "stable-ai-service", "maxConcurrency": 2,
                    "workTimeoutSeconds": self.settings.work_timeout_seconds, "automaticReplay": False},
                "conversations": {"version": 2, "transport": {"events": 1, "cancel": 1, "originalRunLookup": 1}, "agentIds": [agent.id for agent in self.runtime["os"].agents or []
                    if isinstance(agent.id, str) and agent.id.startswith("galaxy-conversation-")]}})(scope, receive, send)
        try:
            headers = [(k.lower(), v) for k, v in scope.get("headers", [])]
            auth = [v.decode() for k, v in headers if k == b"authorization"]
            if len(auth) != 1 or not auth[0].startswith("Bearer "):
                raise AuthorityDenied()
            if method == "GET" and (path == "/galaxy/model-settings" or re.fullmatch(r"/galaxy/runs(?:/[A-Za-z0-9_-]{1,128})?", path)):
                if not hmac.compare_digest(auth[0][7:], self.settings.service_key):
                    raise AuthorityDenied()
                if path == "/galaxy/model-settings" and scope.get("query_string"):
                    raise AuthorityDenied()
                return await self.app(scope, receive, send)
            claims = jwt.decode(auth[0][7:], self.settings.verification_key, algorithms=["HS256"],
                audience=self.settings.audience, issuer=self.settings.issuer,
                options={"require": ["sub", "exp", "iat", "iss", "aud"]})
            user_id = claims["sub"]
            conversation = isinstance(user_id, str) and user_id.startswith("conversation:")
            ident = conversation_id(user_id) if conversation else execution_id(user_id)
            resume_read = conversation and method == "POST" and re.fullmatch(r"/agents/galaxy-conversation-(?:overview|governance|messaging|discovery|maintenance)/runs/[A-Za-z0-9_-]{1,128}/resume", path)
            current = self.runtime["gateway"].authorize(user_id, operation="read" if method == "GET" or resume_read else "run")
            row = current["execution"]
            scope.setdefault("state", {})["galaxy_execution"] = row
            scope["state"]["galaxy_user_id"] = user_id
            read_path = path == ("/galaxy/conversations/" if conversation else "/galaxy/executions/") + ident
            operation_read_path = conversation and re.fullmatch(r"/galaxy/conversations/" + re.escape(ident) + r"/operations/[0-9a-f-]{36}", path)
            continue_path = not conversation and path == "/galaxy/executions/" + ident + "/continue"
            native = re.fullmatch(r"/(agents|workflows)/([A-Za-z0-9_-]+)/runs(?:/([A-Za-z0-9_-]+)/(continue|cancel|resume))?", path)
            if not (read_path and method == "GET" or operation_read_path and method == "GET" or continue_path and method == "POST" or native and method in {"GET", "POST"}):
                raise AuthorityDenied()
            if operation_read_path and scope.get("query_string"):
                raise AuthorityDenied()
            if native:
                kind, component, _, action = native.groups()
                if conversation and (kind != "agents" or action not in {None, "cancel", "resume"}):
                    raise AuthorityDenied()
                expected_component = ("galaxy-conversation-" + row["domain"] if conversation
                    else "galaxy-prepared-review" if kind == "workflows" else "galaxy-" + row["domain"])
                if component != expected_component:
                    raise AuthorityDenied()
                if conversation and action and method != "POST":
                    raise AuthorityDenied()
                if conversation and action == "cancel":
                    query = parse_qs(scope.get("query_string", b"").decode(), keep_blank_values=True)
                    if query != {"session_id": [row["sessionId"]]}:
                        raise AuthorityDenied()
                elif conversation and scope.get("query_string"):
                    raise AuthorityDenied()
                if kind == "agents" and not action and row["domain"] not in self.runtime["configuredDomains"]:
                    return await JSONResponse({"error": "agentos_model_not_configured"}, status_code=503)(scope, receive, send)
                if method == "GET" and action != "resume":
                    raise AuthorityDenied()
            if method == "POST":
                    chunks, length = [], 0
                    while True:
                        message = await receive()
                        if message["type"] != "http.request":
                            raise AuthorityDenied()
                        length += len(message.get("body", b""))
                        if length > 65536:
                            return await JSONResponse({"error": "agentos_request_too_large"}, status_code=413)(scope, receive, send)
                        chunks.append(message.get("body", b""))
                        if not message.get("more_body"):
                            break
                    body = b"".join(chunks)
                    ctype = next((v.decode().split(";")[0] for k, v in headers if k == b"content-type"), "")
                    fields = parse_qs(body.decode(), keep_blank_values=True) if ctype == "application/x-www-form-urlencoded" else {}
                    allowed = ({"last_event_index", "session_id"} if conversation and action == "resume" else set() if conversation and action == "cancel" else
                        {"run_id", "confirmed"} if continue_path else ({"message", "stream", "session_id", "background"} if not action else {"stream", "session_id", "background", "step_requirements", "requirements"}))
                    if (body and ctype != "application/x-www-form-urlencoded" or set(fields) - allowed
                            or any(len(values) != 1 for values in fields.values())):
                        raise AuthorityDenied()
                    expected = row["sessionId"] + (":review" if native and kind == "workflows" else "")
                    if fields.get("session_id", [expected])[0] != expected:
                        raise AuthorityDenied()
                    if conversation and action == "resume" and (fields.get("session_id") != [expected]
                            or "last_event_index" in fields and not re.fullmatch(r"(?:0|[1-9][0-9]{0,9})", fields["last_event_index"][0])):
                        raise AuthorityDenied()
                    if native and not action:
                        fields["session_id"] = [expected]
                        metadata = {"domain": row["domain"],
                            "operationId": next((value.decode() for key, value in headers if key == b"idempotency-key"), None),
                            "promptVersion": "galaxy-conversation-v2" if conversation else "galaxy-prepared-review-v1" if kind == "workflows" else "galaxy-operations-v1"}
                        if conversation:
                            metadata["userPublicReferences"] = user_public_references(fields.get("message", [""])[0])
                        fields["metadata"] = [json.dumps(metadata)]
                        from urllib.parse import urlencode
                        body = urlencode({key: value[0] for key, value in fields.items()}).encode()
                        scope["headers"] = [(key, str(len(body)).encode() if key.lower() == b"content-length" else value) for key, value in scope["headers"]]
                    delivered = False
                    async def replay():
                        nonlocal delivered
                        if not delivered:
                            delivered = True
                            return {"type": "http.request", "body": body, "more_body": False}
                        return await receive()
                    return await self.app(scope, replay, send)
            return await self.app(scope, receive, send)
        except AuthorityUnavailable:
            return await JSONResponse({"error": "agentos_authority_unavailable"}, status_code=503)(scope, receive, send)
        except (AuthorityDenied, jwt.PyJWTError, ValueError, KeyError):
            return await JSONResponse({"error": "agentos_current_authority_denied"}, status_code=403)(scope, receive, send)


def create_app(settings, **runtime_options):
    runtime = create_runtime(settings, **runtime_options)
    app = runtime["os"].get_app()
    runtime["p13Surface"] = install_p13_routes(app, settings, runtime)
    runtime["dutySurface"] = install_duty_routes(app, settings, runtime)
    install_conversation_read(app, runtime, run_view)
    install_conversation_transport_read(app, runtime, run_view)

    @app.get("/galaxy/model-settings")
    async def read_model_settings():
        return model_settings_view(settings)

    @app.get("/galaxy/runs")
    async def global_runs(page: int = Query(1, ge=1, le=100000), limit: int = Query(30, ge=1, le=100), domain: str | None = None, state: str | None = None):
        from .read_model import list_runs, DOMAINS, STATUSES
        if domain is not None and domain not in DOMAINS or state is not None and state not in STATUSES:
            return JSONResponse({"error": "agentos_query_invalid"}, status_code=400)
        return list_runs(runtime["db"], page=page, limit=limit, domain=domain, state=state)

    @app.get("/galaxy/runs/{run_id}")
    async def global_run_detail(run_id: str):
        from .read_model import run_detail
        value = run_detail(runtime["db"], run_id)
        return value if value else JSONResponse({"error": "agentos_run_not_found"}, status_code=404)

    @app.get("/galaxy/executions/{ident}")
    async def read_execution(ident: str, request: Request):
        row = request.state.galaxy_execution
        if row["id"] != ident:
            return JSONResponse({"error": "agentos_current_authority_denied"}, status_code=403)
        user_id = request.state.galaxy_user_id
        runs = []
        # get_session(runs_limit=...) is the native *model context* window and
        # intentionally drops PAUSED/error/cancelled runs. The workbench needs
        # the native run ledger, including the pause requiring human input.
        for sid, component in [(row["sessionId"], {"agent_id": "galaxy-" + row["domain"]}),
                (row["sessionId"] + ":review", {"workflow_id": "galaxy-prepared-review"})]:
            stored = runtime["db"].get_runs(session_id=sid, user_id=user_id, limit=50,
                page=1, sort_by="created_at", sort_order="desc", **component)
            runs.extend(run_view(run) for run in stored)
        traces, count = runtime["db"].get_traces(user_id=user_id, limit=50)
        # Recheck after all database work before releasing controlled history.
        current = runtime["gateway"].authorize(user_id, operation="read")
        return {"executionId": ident, "runs": sorted(runs, key=lambda run: run["createdAt"] or 0),
            "traces": [{"traceId": t.trace_id, "status": t.status, "durationMs": t.duration_ms, "runId": t.run_id} for t in traces],
            "traceCount": count, "modelState": "configured" if runtime["modelConfigured"] else "not-configured",
            "readExpiresAt": current.get("readExpiresAt")}

    @app.post("/galaxy/executions/{ident}/continue")
    async def continue_execution(ident: str, request: Request):
        row = request.state.galaxy_execution
        if row["id"] != ident:
            return JSONResponse({"error": "agentos_current_authority_denied"}, status_code=403)
        form = await request.form()
        run_id, confirmed = str(form.get("run_id", "")), str(form.get("confirmed", ""))
        if confirmed not in {"true", "false"}:
            return JSONResponse({"error": "agentos_confirmation_invalid"}, status_code=400)
        sid = row["sessionId"] + ":review"
        stored = runtime["db"].get_run(run_id=run_id, deserialize=False)
        if (not stored or stored.get("session_id") != sid
                or stored.get("user_id") != request.state.galaxy_user_id
                or stored.get("workflow_id") != "galaxy-prepared-review"
                or stored.get("run_type") != "workflow" or stored.get("status") != "PAUSED"):
            return JSONResponse({"error": "agentos_run_not_paused"}, status_code=409)
        run = WorkflowRunOutput.from_dict(stored["run_data"])
        requirements = run.step_requirements or []
        for requirement in requirements[-1:]:
            requirement.confirm() if confirmed == "true" else requirement.reject()
        runtime["gateway"].authorize(request.state.galaxy_user_id, operation="run")
        # Delegate the transition and durable-ticket CAS to the native route.
        # Only requirement IDs/statuses read from the owned native run are sent.
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agentos.internal") as client:
            response = await client.post("/workflows/galaxy-prepared-review/runs/" + run_id + "/continue",
                headers={"Authorization": request.headers["authorization"]},
                data={"session_id": sid, "stream": "false", "background": "true",
                    "step_requirements": json.dumps([r.to_dict() for r in requirements])})
        if response.status_code not in {200, 202}:
            return JSONResponse({"error": "agentos_continue_failed"}, status_code=response.status_code)
        return response.json()

    app.add_middleware(PrivateSurface, settings=settings, runtime=runtime)
    app.state.galaxy_runtime = runtime
    return app


def main():
    import uvicorn
    settings = Settings.from_env()
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, access_log=False)


if __name__ == "__main__":
    main()
