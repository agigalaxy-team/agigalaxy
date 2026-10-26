"""Validate actual proxy output without retaining prompts or provider bodies."""
import json

MAX_BUFFER = 16 * 1024 * 1024
ERROR = {"error": {"code": "model_gateway_response_invalid",
    "message": "The model service returned an invalid or incomplete response.",
    "type": "api_error"}}


def useful_message(value):
    if not isinstance(value, dict):
        return False
    content = value.get("content")
    if isinstance(content, str) and content.strip():
        return True
    if isinstance(content, list) and any(isinstance(x, dict) and isinstance(x.get("text"), str)
            and x["text"].strip() for x in content):
        return True
    if isinstance(value.get("refusal"), str) and value["refusal"].strip():
        return True
    return any(isinstance(x, dict) and isinstance(x.get("function"), dict)
        and x["function"].get("name") for x in value.get("tool_calls", []) or [])


def useful_response(value, responses=False):
    if not isinstance(value, dict) or value.get("error"):
        return False
    if responses:
        return value.get("status") == "completed" and any(
            isinstance(x, dict) and ((x.get("type") == "message" and useful_message(x))
            or (x.get("type") == "function_call" and x.get("name")))
            for x in value.get("output", []) or [])
    return any(isinstance(x, dict) and x.get("finish_reason") is not None
        and useful_message(x.get("message")) for x in value.get("choices", []) or [])


class ResponseGuard:
    def __init__(self, send, *, stream, responses, version, rejected, call_id=None):
        self.downstream, self.stream, self.responses = send, stream, responses
        self.version, self.rejected = version, rejected
        self.call_id = call_id
        self.start = None
        self.started = self.ended = self.bad = False
        self.buffer = bytearray()
        self.pending = bytearray()
        self.useful = self.terminal = self.finish_reason = False

    async def begin(self):
        if not self.started:
            self.started = True
            await self.downstream(self.start)

    async def reject(self, *, status=502, code=None, reason="invalid-response"):
        if self.ended:
            return
        self.bad = True
        from .output import emit
        emit({"event": "model-response-rejected", "callId": self.call_id,
            "reason": reason, "status": status, "stream": self.stream})
        await self.rejected()
        body = {"error": {"code": code}} if code else ERROR
        if reason in {'upstream-http-error','native-provider-error'}:
            from .metadata import provider_failure_for
            origin=provider_failure_for(self.call_id)
            confirmed=origin.get('httpStatus')==status or origin.get('category') in {'timeout','connection'}
            body={'error':{**body['error'],'source':'provider' if confirmed else 'model-gateway',
                **({'status':origin.get('httpStatus') or origin.get('reportedStatus') or status} if confirmed else {}),
                **({'category':origin['category']} if confirmed and origin.get('category') else {})}}
        data = json.dumps(body, separators=(",", ":")).encode()
        if self.started:
            await self.downstream({"type": "http.response.body",
                "body": b"data: " + data + b"\n\n" if self.stream else b"", "more_body": False})
        else:
            await self.downstream({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"),
                    (b"x-galaxy-model-config-version", self.version.encode())]})
            await self.downstream({"type": "http.response.body", "body": data, "more_body": False})
        self.ended = True
        self.buffer.clear()
        self.pending.clear()

    async def send(self, message):
        if self.ended:
            return
        if message["type"] == "http.response.start":
            status = message["status"]
            if status >= 400:
                allowed = {400, 401, 402, 403, 404, 408, 409, 413, 422, 429, *range(500, 600)}
                return await self.reject(status=status if status in allowed else 502,
                    code="model_gateway_request_failed", reason="upstream-http-error")
            headers = [(k, v) for k, v in message.get("headers", [])
                if k.lower() in {b"content-type", b"cache-control"}]
            content_type = next((v.decode("latin1").lower().split(";")[0].strip()
                for k, v in headers if k.lower() == b"content-type"), "")
            if content_type != ("text/event-stream" if self.stream else "application/json"):
                return await self.reject(reason="unexpected-content-type")
            self.start = {**message, "headers": headers +
                [(b"x-galaxy-model-config-version", self.version.encode())]}
            return
        if message["type"] != "http.response.body":
            return
        if self.start is None:
            return await self.reject(reason="missing-response-start")
        self.buffer.extend(message.get("body", b""))
        if len(self.buffer) + len(self.pending) > MAX_BUFFER:
            return await self.reject(reason="response-too-large")
        if not self.stream:
            if not message.get("more_body"):
                try:
                    value = json.loads(self.buffer)
                    valid = useful_response(value, self.responses)
                except (ValueError, TypeError, RecursionError):
                    return await self.reject(reason="invalid-json")
                if not valid:
                    reason = "upstream-error-object" if isinstance(value, dict) and value.get("error") else "no-final-answer-or-tool"
                    return await self.reject(reason=reason)
                await self.begin()
                await self.downstream({"type": "http.response.body", "body": bytes(self.buffer), "more_body": False})
                self.buffer.clear()
                self.ended = True
            return
        # Keep incomplete frames until their delimiter; network packet boundaries
        # need not coincide with SSE events or UTF-8 characters.
        self.buffer[:] = self.buffer.replace(b"\r\n", b"\n")
        while b"\n\n" in self.buffer and not self.ended:
            frame, _, rest = self.buffer.partition(b"\n\n")
            self.buffer[:] = rest
            await self.frame(bytes(frame) + b"\n\n")
        if not message.get("more_body") and not self.ended:
            if self.buffer.strip() or not (self.useful and self.terminal):
                return await self.reject(reason="incomplete-stream")
            await self.begin()
            await self.downstream({"type": "http.response.body", "body": b"", "more_body": False})
            self.ended = True

    async def frame(self, frame):
        data = b"\n".join(line[5:].lstrip(b" ") for line in frame.splitlines() if line.startswith(b"data:"))
        if data == b"[DONE]":
            if not (self.useful and (self.terminal if self.responses else self.finish_reason)):
                return await self.reject(reason="premature-stream-end")
            self.terminal = True
        elif data:
            try:
                value = json.loads(data)
                if isinstance(value, dict) and (value.get('error') or self.responses and value.get('type') in {'error','response.failed','response.incomplete'}):
                    from .metadata import provider_failure_for
                    origin=provider_failure_for(self.call_id)
                    reported=origin.get('httpStatus') or origin.get('reportedStatus')
                    if type(reported) is int and 400<=reported<=599:
                        return await self.reject(status=reported,code='model_gateway_request_failed',reason='native-provider-error')
                if not isinstance(value, dict) or value.get("error"):
                    return await self.reject(reason="invalid-stream-event")
                if self.responses:
                    kind = value.get("type", "")
                    if kind in {"error", "response.failed", "response.incomplete"}:
                        return await self.reject(reason="upstream-stream-failed")
                    if kind == "response.completed":
                        if not useful_response(value.get("response"), True):
                            return await self.reject(reason="no-final-answer-or-tool")
                        self.terminal = self.useful = True
                    if kind in {"response.output_text.delta", "response.refusal.delta",
                            "response.function_call_arguments.delta"} and value.get("delta"):
                        self.useful = True
                else:
                    for choice in value.get("choices", []) or []:
                        delta = choice.get("delta") or {}
                        self.useful = self.useful or useful_message(delta) or bool(delta.get("tool_calls"))
                        self.finish_reason = self.finish_reason or choice.get("finish_reason") is not None
            except (ValueError, TypeError, AttributeError, RecursionError):
                return await self.reject(reason="invalid-stream-json")
        self.pending.extend(frame)
        if self.useful:
            await self.begin()
            await self.downstream({"type": "http.response.body", "body": bytes(self.pending), "more_body": True})
            self.pending.clear()

    async def complete(self):
        if not self.ended:
            await self.reject(reason="response-not-completed")
