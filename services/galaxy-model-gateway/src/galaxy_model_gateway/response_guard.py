"""Validate actual proxy output without retaining prompts or provider bodies."""
import json

MAX_BUFFER = 16 * 1024 * 1024
ERROR = {"error": {"code": "model_gateway_response_invalid",
    "message": "The model service returned an invalid or incomplete response.",
    "type": "api_error"}}


def http_error_status(value):
    """Closed HTTP status metadata; never parse provider message text."""
    if type(value) is int and 400 <= value <= 599:
        return value
    if type(value) is str and len(value) == 3 and value[0] in '45' and all('0' <= c <= '9' for c in value):
        return int(value)
    return None


def gateway_transient_category(status):
    if status in (408, 504):
        return 'timeout'
    if status in (429, 529):
        return 'rate-limit'
    if 500 <= status <= 599:
        return 'service-unavailable'
    return None


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
    def __init__(self, send, *, stream, responses, version, rejected, call_id=None, native_run_id=None):
        self.downstream, self.stream, self.responses = send, stream, responses
        self.version, self.rejected = version, rejected
        self.call_id = call_id
        self.native_run_id = native_run_id
        self.start = None
        self.started = self.ended = self.bad = False
        self.buffer = bytearray()
        self.pending = bytearray()
        self.useful = self.terminal = self.finish_reason = False
        self.stage = 'start'
        self.saw_done = False
        self.empty_done = False
        self.finish_stop_seen = False
        self.finish_stop_only = True
        self.refusal_seen = False
        self.chat_finish = 'none'
        self.responses_terminal = 'none'
        self.frame_count = self.choice_count = self.tool_delta_count = 0
        self.json_state = 'not-seen'
        self.error_present = False
        self.error_shape = 'none'
        self.error_type = self.error_status = self.error_code = 'unknown'

    def inspect_error(self, value):
        if not isinstance(value, dict) or 'error' not in value:
            return
        error = value['error']
        self.error_present = True
        self.error_shape = 'object' if isinstance(error, dict) else 'scalar'
        if not isinstance(error, dict):
            return
        error_type, status, code = error.get('type'), error.get('status'), error.get('code')
        allowed_types = {'api_error', 'invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'rate_limit_error', 'server_error', 'overloaded_error', 'timeout_error'}
        allowed_status = {'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'}
        if isinstance(error_type, str) and error_type in allowed_types:
            self.error_type = error_type
        if isinstance(status, str) and status in allowed_status:
            self.error_status = status
        elif http_error_status(status) is not None:
            self.error_status = http_error_status(status)
        if http_error_status(code) is not None:
            self.error_code = http_error_status(code)

    def diagnostic(self, event, **extra):
        from .output import emit
        emit({'event': event, 'callId': self.call_id, 'nativeRunId': self.native_run_id, 'stage': self.stage,
            'stream': self.stream, 'useful': self.useful, 'sawDone': self.saw_done,
            'chatFinishReason': self.chat_finish, 'responsesTerminalEvent': self.responses_terminal,
            'frameCount': self.frame_count, 'choiceCount': self.choice_count,
            'toolDeltaCount': self.tool_delta_count, 'partialBufferBytes': len(self.buffer),
            'jsonParse': self.json_state, 'errorPresent': self.error_present, 'errorShape': self.error_shape,
            'errorType': self.error_type, 'errorStatus': self.error_status, 'errorCode': self.error_code, **extra})

    async def begin(self):
        if not self.started:
            self.started = True
            await self.downstream(self.start)

    async def reject(self, *, status=502, code=None, reason="invalid-response"):
        if self.ended:
            return
        if reason == 'gateway-empty-completion' and not self.useful and not self.started:
            from .provider_finish import malformed_for
            reason = {"MALFORMED_FUNCTION_CALL":"gateway-malformed-tool-call", "MALFORMED_RESPONSE":"gateway-malformed-response"}.get(malformed_for(self.call_id), reason)
        self.bad = True
        self.diagnostic('model-response-rejected', reason=reason, status=status)
        await self.rejected()
        body = {"error": {"code": code}} if code else ERROR
        if reason == 'gateway-empty-completion':
            body = {'error': {'code': 'model_gateway_empty_completion', 'source': 'model-gateway',
                'status': 502, 'category': 'empty-completion', 'outputStarted': False}}
        if reason == 'gateway-malformed-tool-call':
            body = {'error': {'code':'model_gateway_malformed_tool_call', 'source':'model-gateway',
                'status':502, 'category':'malformed-tool-call', 'outputStarted':False}}
        if reason == 'gateway-malformed-response':
            body = {'error': {'code':'model_gateway_malformed_response', 'source':'model-gateway',
                'status':502, 'category':'malformed-response', 'outputStarted':False}}
        if reason == 'gateway-transient-error':
            body = {'error': {'code': 'model_gateway_transient_failure', 'source': 'model-gateway',
                'status': status, 'category': gateway_transient_category(status), 'outputStarted': False}}
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
            self.stage = 'headers'
            status = message["status"]
            if status >= 400:
                allowed = {400, 401, 402, 403, 404, 408, 409, 413, 422, 429, *range(500, 600)}
                from .metadata import gateway_failure_for, provider_failure_for
                provider = provider_failure_for(self.call_id)
                confirmed = provider.get('httpStatus') == status or provider.get('category') in {'timeout', 'connection'}
                observed = gateway_failure_for(self.call_id)
                known_statuses = [observed.get('httpStatus'), observed.get('reportedStatus')]
                conflict = (observed.get('category') in {'context-limit', 'request-rejected'}
                    or any(type(value) is int and value not in {408, 429, *range(500, 600)} for value in known_statuses))
                if (type(status) is int and gateway_transient_category(status) is not None
                        and not self.started and not self.useful and self.tool_delta_count == 0
                        and not confirmed and not conflict):
                    return await self.reject(status=status, reason='gateway-transient-error')
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
        self.stage = 'body'
        if self.start is None:
            return await self.reject(reason="missing-response-start")
        self.buffer.extend(message.get("body", b""))
        if len(self.buffer) + len(self.pending) > MAX_BUFFER:
            return await self.reject(reason="response-too-large")
        if not self.stream:
            if not message.get("more_body"):
                try:
                    value = json.loads(self.buffer)
                    self.json_state = 'ok'
                    self.inspect_error(value)
                    valid = useful_response(value, self.responses)
                except (ValueError, TypeError, RecursionError):
                    self.json_state = 'invalid'
                    return await self.reject(reason="invalid-json")
                if not valid:
                    reason = "upstream-error-object" if isinstance(value, dict) and value.get("error") else "no-final-answer-or-tool"
                    return await self.reject(reason=reason)
                await self.begin()
                await self.downstream({"type": "http.response.body", "body": bytes(self.buffer), "more_body": False})
                self.buffer.clear()
                self.ended = True
                self.diagnostic('model-response-completed')
            return
        # Keep incomplete frames until their delimiter; network packet boundaries
        # need not coincide with SSE events or UTF-8 characters.
        self.buffer[:] = self.buffer.replace(b"\r\n", b"\n")
        while b"\n\n" in self.buffer and not self.ended:
            frame, _, rest = self.buffer.partition(b"\n\n")
            self.buffer[:] = rest
            await self.frame(bytes(frame) + b"\n\n")
        if not message.get("more_body") and not self.ended:
            if self.empty_done and not self.buffer.strip():
                return await self.reject(status=502, reason="gateway-empty-completion")
            if self.buffer.strip() or not (self.useful and self.terminal):
                return await self.reject(reason="incomplete-stream")
            await self.begin()
            await self.downstream({"type": "http.response.body", "body": b"", "more_body": False})
            self.ended = True
            self.diagnostic('model-response-completed')

    async def frame(self, frame):
        self.stage = 'frame'
        self.frame_count += 1
        data = b"\n".join(line[5:].lstrip(b" ") for line in frame.splitlines() if line.startswith(b"data:"))
        if self.empty_done:
            return await self.reject(reason="invalid-stream-event")
        if data == b"[DONE]":
            self.saw_done = True
            if not (self.useful and (self.terminal if self.responses else self.finish_reason)):
                if (not self.responses and not self.started and not self.useful
                        and self.tool_delta_count == 0 and not self.error_present and not self.refusal_seen
                        and self.choice_count > 0 and self.finish_stop_seen and self.finish_stop_only
                        and self.json_state == 'ok'):
                    self.empty_done = True
                else:
                    return await self.reject(reason="premature-stream-end")
            self.terminal = True
        elif data:
            try:
                value = json.loads(data)
                self.json_state = 'ok'
                self.inspect_error(value)
                if isinstance(value, dict) and (value.get('error') or self.responses and value.get('type') in {'error','response.failed','response.incomplete'}):
                    from .metadata import provider_failure_for, gateway_failure_for
                    observed = gateway_failure_for(self.call_id)
                    statuses = [observed.get('httpStatus'), observed.get('reportedStatus')]
                    failure_consistent = not observed or (observed.get('category') == 'service-unavailable'
                        and all(status is None or status == 503 for status in statuses))
                    frame_status = self.error_code if self.error_code != 'unknown' else self.error_status
                    status_conflict = (type(self.error_code) is int and type(self.error_status) is int
                        and self.error_code != self.error_status)
                    raw_error = value.get('error') if isinstance(value.get('error'), dict) else {}
                    raw_status, raw_type, raw_code = raw_error.get('status'), raw_error.get('type'), raw_error.get('code')
                    compatible_status = raw_status is None or raw_status == 'UNAVAILABLE' or http_error_status(raw_status) == 503
                    compatible_code = raw_code is None or http_error_status(raw_code) == 503
                    compatible_type = raw_type is None or (isinstance(raw_type, str)
                        and raw_type in {'api_error', 'server_error', 'overloaded_error'})
                    if (isinstance(value.get('error'), dict) and frame_status == 503 and not status_conflict
                            and compatible_status and compatible_code and compatible_type and failure_consistent
                            and not self.started and not self.useful and self.tool_delta_count == 0):
                        return await self.reject(status=503, reason='gateway-transient-error')
                    origin=provider_failure_for(self.call_id)
                    reported=origin.get('httpStatus') or origin.get('reportedStatus')
                    if type(reported) is int and 400<=reported<=599:
                        return await self.reject(status=reported,code='model_gateway_request_failed',reason='native-provider-error')
                if not isinstance(value, dict) or value.get("error"):
                    return await self.reject(reason="invalid-stream-event")
                if self.responses:
                    kind = value.get("type", "")
                    if kind in {'response.function_call_arguments.delta', 'response.function_call_arguments.done'} or (kind == 'response.output_item.added' and isinstance(value.get('item'), dict) and value['item'].get('type') == 'function_call'):
                        self.tool_delta_count += 1
                    if kind in {'response.completed', 'response.failed', 'response.incomplete', 'error'}:
                        self.responses_terminal = kind
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
                        self.choice_count += 1
                        delta = choice.get("delta") or {}
                        if isinstance(delta, dict) and delta.get("refusal") is not None:
                            self.refusal_seen = True
                        calls = delta.get('tool_calls')
                        if isinstance(calls, list):
                            self.tool_delta_count += len(calls)
                        finish = choice.get('finish_reason')
                        if finish is not None:
                            if finish != '':
                                self.finish_stop_seen = self.finish_stop_seen or finish == 'stop'
                                self.finish_stop_only = self.finish_stop_only and finish == 'stop'
                            self.chat_finish = finish if isinstance(finish, str) and finish in {'stop', 'length', 'tool_calls', 'content_filter', 'function_call'} else 'unknown'
                        self.useful = self.useful or useful_message(delta) or bool(delta.get("tool_calls"))
                        self.finish_reason = self.finish_reason or choice.get("finish_reason") is not None
            except (ValueError, TypeError, AttributeError, RecursionError):
                self.json_state = 'invalid'
                return await self.reject(reason="invalid-stream-json")
        self.pending.extend(frame)
        if self.useful:
            await self.begin()
            await self.downstream({"type": "http.response.body", "body": bytes(self.pending), "more_body": True})
            self.pending.clear()

    async def complete(self):
        if not self.ended:
            self.stage = 'complete'
            await self.reject(reason="response-not-completed")
