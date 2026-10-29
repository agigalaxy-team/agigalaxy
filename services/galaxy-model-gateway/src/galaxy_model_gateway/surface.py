import hmac
import json
import re
from asyncio import to_thread
from uuid import uuid4
from starlette.responses import JSONResponse
from .policy import SCENARIOS, status
from .profiles import admit_profile, estimated_input_tokens
from .usage import unavailable_usage

CALL_FIELDS = frozenset({"model", "messages", "stream", "stream_options", "tools", "tool_choice",
    "temperature", "top_p", "max_tokens", "max_completion_tokens", "response_format", "stop", "seed",
    "frequency_penalty", "presence_penalty", "parallel_tool_calls", "reasoning_effort", "store", "verbosity"})
RESPONSES_FIELDS = frozenset({"model", "input", "instructions", "stream", "tools", "tool_choice",
    "max_output_tokens", "reasoning", "text", "parallel_tool_calls", "store", "include", "truncation", "background"})


class PrivateSurface:
    """A narrow ASGI policy around the native Proxy, not a replacement router."""
    def __init__(self, app, settings, models, profiles=None, usage_store=None, token_counter=estimated_input_tokens):
        self.app, self.settings, self.models = app, settings, models
        self.aliases = frozenset(row["model_name"] for row in models)
        self.models_by_alias = {row["model_name"]: row for row in models}
        self.profiles, self.usage_store, self.token_counter = profiles or {}, usage_store, token_counter

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan": return await self.app(scope, receive, send)
        if scope["type"] != "http": return
        async def fail(code, http=400):
            return await JSONResponse({"error": {"code": code}}, status_code=http)(scope, receive, send)
        headers = scope.get("headers", [])
        values = [value.decode("latin1") for key, value in headers if key.lower() == b"authorization"]
        if len(values) != 1 or not hmac.compare_digest(values[0], "Bearer " + self.settings.service_key):
            return await fail("model_gateway_authorization_required", 401)
        path, method = scope["path"], scope["method"]
        usage_days = {b"days=7": 7, b"days=30": 30}.get(scope.get("query_string", b"")) if path == "/galaxy/usage" else None
        if scope.get("query_string") and usage_days is None:
            return await fail("model_gateway_request_invalid")
        if any(key.lower() in {b"x-litellm-api-key", b"api-key", b"x-api-key", b"x-goog-api-key"} for key, _ in headers):
            return await fail("model_gateway_request_invalid")
        if path == "/galaxy/status" and method == "GET":
            return await JSONResponse(status(self.settings, self.models))(scope, receive, send)
        if path == "/galaxy/usage" and method == "GET" and usage_days is not None:
            try:
                result = await to_thread(self.usage_store.summary, usage_days) if self.usage_store else unavailable_usage(usage_days)
            except Exception:
                result = unavailable_usage(usage_days)
            return await JSONResponse(result)(scope, receive, send)
        is_models = path == "/v1/models" and method == "GET"
        is_responses = path == "/v1/responses" and method == "POST"
        is_call = path in {"/v1/chat/completions", "/v1/responses"} and method == "POST"
        if not (is_models or is_call):
            return await fail("model_gateway_route_denied", 403)
        scope.setdefault("state", {})["galaxy_model_authorized"] = True
        if is_call:
            if not self.aliases:
                # Reject before reading any prompt when no models are assigned.
                return await fail("model_gateway_model_not_configured", 503)
            def header(name):
                entries = [value.decode("latin1") for key, value in headers if key.lower() == name]
                return entries[0] if len(entries) == 1 else None
            scene, version = header(b"x-galaxy-model-scenario"), header(b"x-galaxy-model-config-version")
            if scene not in SCENARIOS or version != self.settings.config_version:
                return await fail("model_gateway_configuration_changed", 409)
            run_headers = [value.decode("latin1") for key, value in headers if key.lower() == b"x-galaxy-native-run-id"]
            if len(run_headers) > 1 or (run_headers and not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", run_headers[0])):
                return await fail("model_gateway_request_invalid")
            native_run_id = run_headers[0] if run_headers else None
            body, size = [], 0
            while True:
                message = await receive()
                if message["type"] != "http.request": return await fail("model_gateway_request_invalid")
                chunk = message.get("body", b""); size += len(chunk)
                if size > 2097152: return await fail("model_gateway_request_too_large", 413)
                body.append(chunk)
                if not message.get("more_body"): break
            try:
                def constant(_): raise ValueError()
                payload = json.loads(b"".join(body), parse_constant=constant)
                if (not isinstance(payload, dict) or set(payload) - (RESPONSES_FIELDS if is_responses else CALL_FIELDS)
                        or payload.get("model") not in self.aliases or payload.get("store", False) is not False
                        or (is_responses and not isinstance(payload.get("input"), (str, list)))
                        or (not is_responses and not isinstance(payload.get("messages"), list))):
                    raise ValueError()
                profile = self.profiles.get(payload["model"])
                if is_responses and profile is None:
                    raise ValueError()
                if profile:
                    if any(key in payload for key in ("temperature", "top_p", "seed", "stop")):
                        raise ValueError()
                    admit_profile(payload, profile, responses=is_responses, scene=scene)
                    # The operator timeout limits the actual upstream request,
                    # not just the AgentOS-to-gateway HTTP connection.
                    payload["timeout"] = profile["timeoutSeconds"]
                    if self.usage_store is None:
                        return await fail("model_gateway_usage_store_unavailable", 503)
                    try:
                        count = await to_thread(self.token_counter, payload,
                            upstream_model=self.models_by_alias[payload["model"]]["litellm_params"]["model"], responses=is_responses)
                    except Exception:
                        return await fail("model_gateway_context_count_unavailable", 503)
                    if type(count) is not int or count < 0:
                        return await fail("model_gateway_context_count_unavailable", 503)
                    if count + profile["maxOutputTokens"] > profile["contextWindow"]:
                        return await fail("model_gateway_context_window_exceeded", 422)
                    if profile["apiFormat"] == "openai-chat" and profile["reasoningEffort"] is not None:
                        # Explicitly declared compatible API support must be
                        # passed through by native LiteLLM, never dropped.
                        payload["allowed_openai_params"] = ["reasoning_effort"]
                    if profile["apiFormat"] in {"anthropic", "gemini"}:
                        # store=false is checked at this gateway. The native
                        # Anthropic/Gemini inference APIs have no OpenAI store
                        # parameter; their retention policy is configured with
                        # the selected supplier, not invented by a false flag.
                        payload.pop("store", None)
                # A caller cannot supply logging metadata, fallback routes,
                # callback overrides, credentials, provider base URLs or roles.
                metadata = {"galaxy_model_alias": payload["model"], "galaxy_scenario": scene,
                    "galaxy_config_version": version, "galaxy_call_id": str(uuid4())}
                payload["litellm_metadata" if is_responses else "metadata"] = metadata
                if self.usage_store:
                    try: await to_thread(self.usage_store.start, metadata)
                    except Exception: return await fail("model_gateway_usage_store_unavailable", 503)
                encoded = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode()
            except (ValueError, UnicodeError, TypeError, RecursionError):
                return await fail("model_gateway_request_invalid")
            scope["headers"] = [(key, value) for key, value in headers if key.lower() not in {b"content-length", b"content-type", b"x-galaxy-native-run-id"}]
            scope["headers"] += [(b"content-type", b"application/json"), (b"content-length", str(len(encoded)).encode())]
            delivered = False
            original_receive = receive
            async def replay():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": encoded, "more_body": False}
                return await original_receive()
            receive = replay
            from .response_guard import ResponseGuard
            from .output import emit
            emit({'event': 'model-request-accepted', 'callId': metadata['galaxy_call_id'], 'nativeRunId': native_run_id})
            async def response_rejected():
                if self.usage_store:
                    try: await to_thread(self.usage_store.reject_response, metadata["galaxy_call_id"])
                    except Exception: pass
            guard = ResponseGuard(send, stream=payload.get("stream") is True,
                responses=is_responses, version=self.settings.config_version, rejected=response_rejected, call_id=metadata["galaxy_call_id"], native_run_id=native_run_id)
            try:
                await self.app(scope, receive, guard.send)
                await guard.complete()
            except Exception:
                await guard.reject(code="model_gateway_request_failed",reason="native-provider-error")
            return
        rejected, started, finished = False, False, False
        async def checked_send(message):
            nonlocal rejected, started, finished
            if message["type"] == "http.response.start":
                if message["status"] >= 400:
                    rejected = True
                    code = message["status"] if message["status"] in {400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504, 529} else 502
                    await JSONResponse({"error": {"code": "model_gateway_request_failed"}}, status_code=code)(scope, receive, send)
                    return
                message["headers"] = [(key, value) for key, value in message.get("headers", []) if key.lower() in {b"content-type", b"content-length", b"cache-control"}]
                message["headers"].append((b"x-galaxy-model-config-version", self.settings.config_version.encode()))
            if not rejected:
                if message["type"] == "http.response.start": started = True
                if message["type"] == "http.response.body" and not message.get("more_body"): finished = True
                await send(message)
        try:
            await self.app(scope, receive, checked_send)
        except Exception:
            if not rejected and not started: await fail("model_gateway_request_failed", 502)
            elif started and not finished:
                # A streaming response cannot change its status after headers.
                # End it without serializing the exception or provider details.
                await send({"type": "http.response.body", "body": b"", "more_body": False})
