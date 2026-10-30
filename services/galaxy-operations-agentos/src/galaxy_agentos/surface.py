"""Single ASGI authority and request-binding boundary around native AgentOS routes."""
import asyncio
import json
import re
import hmac
from uuid import UUID
from urllib.parse import parse_qs

import jwt
from fastapi.responses import JSONResponse

from .gateway import AuthorityDenied, AuthorityUnavailable, execution_id, conversation_id
from .conversation_references import user_public_references
from .model_settings import model_settings_view, configured_domains
from .p13_strategies import p13_health
from .conversation_transport import operation_read_locator


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
        # Dedicated history capability: no gateway calls or business source
        # checks. A valid scoped token is unusable on every other surface.
        bearer = [v.decode() for k, v in scope.get("headers", []) if k.lower() == b"authorization"]
        if len(bearer) > 1:
            return await JSONResponse({"error":"agentos_current_authority_denied"}, status_code=403)(scope, receive, send)
        if len(bearer) == 1 and bearer[0].startswith("Bearer "):
            try:
                history_claims = jwt.decode(bearer[0][7:], self.settings.verification_key, algorithms=["HS256"],
                    audience=self.settings.audience, issuer=self.settings.issuer,
                    options={"require":["sub", "exp", "iat", "iss", "aud"]})
            except jwt.PyJWTError:
                history_claims = {}
            if history_claims.get("scope") == "history-text":
                try:
                    user_id = history_claims["sub"]
                    ident = conversation_id(user_id)
                    sid, domain = history_claims.get("sid"), history_claims.get("domain")
                    if (method != "GET" or path != "/galaxy/conversations/" + ident + "/history"
                            or not isinstance(sid, str) or str(UUID(sid)) != sid
                            or domain not in {"overview", "governance", "messaging", "discovery", "maintenance"}):
                        raise AuthorityDenied()
                    values = parse_qs(scope.get("query_string", b"").decode("ascii"), keep_blank_values=True)
                    ids = values.get("runId", [])
                    if set(values) != {"runId"} or not 1 <= len(ids) <= 50 or not all(re.fullmatch(r"[A-Za-z0-9_-]{1,128}", item) for item in ids):
                        return await JSONResponse({"error":"agentos_query_invalid"}, status_code=400)(scope, receive, send)
                    scope.setdefault("state", {})["galaxy_execution"] = {"id":ident, "sessionId":sid, "domain":domain, "mode":"conversation"}
                    scope["state"]["galaxy_user_id"] = user_id
                    return await self.app(scope, receive, send)
                except (AuthorityDenied, ValueError, TypeError, KeyError, UnicodeError):
                    return await JSONResponse({"error":"agentos_current_authority_denied"}, status_code=403)(scope, receive, send)
            if history_claims.get("scope") == "conversation-record":
                try:
                    user_id = history_claims["sub"]
                    ident = conversation_id(user_id)
                    sid, domain = history_claims.get("sid"), history_claims.get("domain")
                    operation, locator = history_claims.get("operationId"), history_claims.get("locator")
                    if (method != "GET" or not isinstance(operation, str) or str(UUID(operation)) != operation
                            or path != "/galaxy/conversations/" + ident + "/operations/" + operation
                            or not isinstance(sid, str) or str(UUID(sid)) != sid
                            or domain not in {"overview", "governance", "messaging", "discovery", "maintenance"}
                            or not isinstance(locator, dict) or locator != operation_read_locator(scope.get("query_string", b""))):
                        raise AuthorityDenied()
                    scope.setdefault("state", {})["galaxy_execution"] = {"id":ident, "sessionId":sid, "domain":domain, "mode":"conversation"}
                    scope["state"]["galaxy_user_id"] = user_id
                    scope["state"]["galaxy_trusted_record"] = True
                    scope["state"]["galaxy_record_expires_at"] = history_claims["exp"]
                    return await self.app(scope, receive, send)
                except (AuthorityDenied, ValueError, TypeError, KeyError, UnicodeError):
                    return await JSONResponse({"error":"agentos_current_authority_denied"}, status_code=403)(scope, receive, send)
        if re.fullmatch(r"/galaxy/conversations/[0-9a-f-]{36}/history", path):
            return await JSONResponse({"error":"agentos_current_authority_denied"}, status_code=403)(scope, receive, send)
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
            # The gateway performs blocking HTTP. Preserve its current check
            # and ContextVars without stopping unrelated ASGI reads/streams.
            current = await asyncio.to_thread(self.runtime["gateway"].authorize, user_id,
                operation="read" if method == "GET" or resume_read else "run")
            row = current["execution"]
            scope.setdefault("state", {})["galaxy_execution"] = row
            scope["state"]["galaxy_user_id"] = user_id
            read_path = path == ("/galaxy/conversations/" if conversation else "/galaxy/executions/") + ident
            operation_read_path = conversation and re.fullmatch(r"/galaxy/conversations/" + re.escape(ident) + r"/operations/[0-9a-f-]{36}", path)
            continue_path = not conversation and path == "/galaxy/executions/" + ident + "/continue"
            native = re.fullmatch(r"/(agents|workflows)/([A-Za-z0-9_-]+)/runs(?:/([A-Za-z0-9_-]+)/(continue|cancel|resume))?", path)
            if not (read_path and method == "GET" or operation_read_path and method == "GET" or continue_path and method == "POST" or native and method in {"GET", "POST"}):
                raise AuthorityDenied()
            if operation_read_path:
                try:
                    operation_read_locator(scope.get("query_string", b""))
                except (ValueError, UnicodeError):
                    return await JSONResponse({"error": "agentos_query_invalid"}, status_code=400)(scope, receive, send)
            if native:
                kind, component, _, action = native.groups()
                if conversation and (kind != "agents" or action not in {None, "cancel", "resume", "continue"}):
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
                    allowed = ({"regenerate", "replace_original", "retry_of_operation_id", "stream", "session_id", "background"} if conversation and action == "continue" else {"last_event_index", "session_id"} if conversation and action == "resume" else set() if conversation and action == "cancel" else
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
                    if conversation and action == "continue":
                        operation_id = next((value.decode() for key, value in headers if key == b"idempotency-key"), None)
                        parent_operation = fields.pop("retry_of_operation_id", [None])[0]
                        if fields.get("regenerate") != ["true"] or fields.get("replace_original") != ["true"] or not isinstance(operation_id, str) or not re.fullmatch(r"[0-9a-f-]{36}", operation_id):
                            raise AuthorityDenied()
                        original = await asyncio.to_thread(self.runtime["db"].get_run, run_id=native.groups()[2])
                        original_status = getattr(getattr(original, "status", None), "value", getattr(original, "status", None))
                        if (original is None or str(original_status).upper() != "ERROR"
                                or getattr(original, "user_id", None) != user_id
                                or getattr(original, "session_id", None) != expected
                                or getattr(original, "agent_id", None) != component
                                or (getattr(original, "metadata", None) or {}).get("operationId") != parent_operation):
                            raise AuthorityDenied()
                        # Retry keeps the native regeneration checkpoint on an
                        # independent attempt, without appending the question.
                        fields["metadata"] = [json.dumps({"domain": row["domain"], "operationId": operation_id,
                            "retryOfOperationId": parent_operation, "retryOfRunId": original.run_id,
                            "modelCalls": 0, "modelFallbacks": [], "activeModelFallbackAlias": None,
                            "promptVersion": "galaxy-conversation-v2"})]
                        from urllib.parse import urlencode
                        body = urlencode({key: value[0] for key, value in fields.items()}).encode()
                        scope["headers"] = [(key, str(len(body)).encode() if key.lower() == b"content-length" else value) for key, value in scope["headers"]]
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
