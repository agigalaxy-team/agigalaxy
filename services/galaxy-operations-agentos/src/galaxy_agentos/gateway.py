from uuid import UUID
from urllib.parse import urlparse
import json
import logging
import re

import httpx
from .tool_call_ids import (PROVIDER_TOOL_CALL_ID_MAX_LENGTH, conversation_call_reference,
    rejected_tool_call_shape, valid_provider_tool_call_id)


_LOGGER = logging.getLogger("galaxy_agentos.gateway")
_DIAGNOSTIC_CODE = re.compile(r"^(?:agentos|operations|business_admin|invalid_operations|p13|search_quality|feedback|messaging|content|file|forum)_[a-z0-9_]{1,100}$")


def is_internal_diagnostic(value):
    return isinstance(value, str) and _DIAGNOSTIC_CODE.fullmatch(value) is not None


def closed_failure_fact(*, state=None, status=None, code=None):
    """Map observed failures to closed facts, never infer a missing cause."""
    code = code if isinstance(code, str) else None
    state = state if isinstance(state, str) else None
    status = status if type(status) is int else None
    if status in {408, 504} or code in {"agentos_authority_timeout", "operations_agentos_tool_request_timeout"}:
        return {"state": "unavailable", "failureCategory": "timeout", "causeKnown": False, "message": "本次读取超时，具体原因尚未查明。"}
    if status == 429 or isinstance(status, int) and status >= 500:
        return {"state": "unavailable", "failureCategory": "source-unavailable", "causeKnown": False, "message": "本次读取暂不可用，具体原因尚未查明。"}
    if status in {400, 422}:
        return {"state": "invalid-request", "failureCategory": "invalid-request", "causeKnown": True, "message": "本次请求参数不符。"}
    if status in {404, 410} or status is None and code == "agentos_object_unavailable":
        return {"state": "unavailable", "failureCategory": "object-unavailable", "causeKnown": False, "message": "本次对象暂不可读取。"}
    if status == 409 or status is None and code in {"agentos_tool_state_changed", "agentos_public_reference_version_changed"}:
        return {"state": "changed", "failureCategory": "source-changed", "causeKnown": False, "message": "该项状态已变化。"}
    if status is None and code in {"agentos_tool_arguments_invalid", "agentos_tool_call_id_invalid", "agentos_native_tool_call_id_invalid", "agentos_native_tool_call_required", "agentos_conversation_context_required", "agentos_injected_arguments_forbidden"}:
        return {"state": "invalid-request", "failureCategory": "invalid-request", "causeKnown": True, "message": "工具调用参数不符。"}
    if status in {401, 403} or code in {"business_admin_denied", "operations_permission_denied", "operations_ai_work_permission_denied", "operations_agentos_authority_changed"} or state == "denied":
        return {"state": "denied", "failureCategory": "authorization-check-rejected", "causeKnown": False,
            "message": "本次认证或授权校验未通过，具体原因尚未查明。"}
    if state == "invalid-request":
        return {"state": "invalid-request", "failureCategory": "invalid-request", "causeKnown": True, "message": "本次请求参数不符。"}
    if state == "changed":
        return {"state": "changed", "failureCategory": "source-changed", "causeKnown": False, "message": "该项状态已变化。"}
    return {"state": "unavailable", "failureCategory": "source-unavailable", "causeKnown": False, "message": "本次读取暂不可用，具体原因尚未查明。"}


class AuthorityDenied(PermissionError):
    pass


class AuthorityUnavailable(RuntimeError):
    """The current authority could not be checked; this is not a revocation."""
    pass


def failure_diagnostic(error):
    """Only closed codes/status belong in diagnostics, never upstream prose."""
    value = getattr(error, "diagnostic_code", None) or str(error)
    result = {"code": value} if isinstance(value, str) and _DIAGNOSTIC_CODE.fullmatch(value) else {}
    status = getattr(error, "status_code", None)
    if isinstance(status, int) and 100 <= status <= 599:
        result["status"] = status
    return result


def _rejected_response(response, error_type, code):
    error = error_type(code)
    error.status_code = response.status_code
    try:
        value = response.json()
    except ValueError:
        value = None
    diagnostic = value.get("error") if isinstance(value, dict) else None
    if isinstance(diagnostic, str) and _DIAGNOSTIC_CODE.fullmatch(diagnostic):
        error.diagnostic_code = diagnostic
    _LOGGER.warning("agentos_gateway_rejected %s", json.dumps(failure_diagnostic(error),
        ensure_ascii=True, sort_keys=True, separators=(",", ":")))
    return error


def execution_id(user_id: str | None) -> str:
    if not user_id or not user_id.startswith("execution:"):
        raise AuthorityDenied("agentos_execution_identity_required")
    try:
        return str(UUID(user_id[10:]))
    except ValueError:
        raise AuthorityDenied("agentos_execution_identity_required") from None


def conversation_id(user_id: str | None) -> str:
    if not user_id or not user_id.startswith("conversation:"):
        raise AuthorityDenied("agentos_conversation_identity_required")
    try:
        return str(UUID(user_id[13:]))
    except ValueError:
        raise AuthorityDenied("agentos_conversation_identity_required") from None


def autonomy_id(user_id: str | None) -> str:
    if not isinstance(user_id, str) or not user_id.startswith("autonomy:"):
        raise AuthorityDenied("agentos_autonomy_identity_required")
    try:
        value = str(UUID(user_id[9:]))
        if value != user_id[9:]:
            raise ValueError()
        return value
    except (ValueError, TypeError, AttributeError):
        raise AuthorityDenied("agentos_autonomy_identity_required") from None


class GalaxyGateway:
    """Only the private, authenticated Galaxy endpoint can confer tool authority.

    The JWT and run metadata contain an execution reference, never a trusted
    role/grant snapshot. Every call resolves the current PG binding again.
    """

    def __init__(self, settings, *, transport=None):
        headers = {"Authorization": "Bearer " + settings.service_key}
        # Galaxy's same-host API listener trusts its explicit proxy address and
        # requires the forwarded chain even for this local service connection.
        if urlparse(settings.authority_url).hostname in {"localhost", "127.0.0.1", "::1"}:
            headers["X-Forwarded-For"] = "127.0.0.1"
        self.client = httpx.Client(
            base_url=settings.authority_url.rstrip("/") + "/",
            headers=headers,
            timeout=15.0, follow_redirects=False, transport=transport, trust_env=False,
        )

    def request(self, path: str, data: dict, *, tool_feedback: bool = False) -> dict:
        try:
            response = self.client.post(path, json=data)
            # A rejected tool parameter, missing object or changed source is
            # not evidence that the current manager lost permission. Return
            # closed feedback without forwarding upstream bodies or URLs.
            if tool_feedback and response.status_code in {400, 404, 409, 410, 422}:
                if response.status_code == 409 and isinstance(data.get("publicReference"), dict) and data["publicReference"].get("versionId"):
                    try:
                        source = response.json()
                    except ValueError:
                        source = None
                    if isinstance(source, dict) and source.get("error") == "operations_agentos_source_changed":
                        return {"state": "changed", "reason": "agentos_public_reference_version_changed",
                            "nextStep": "select-current-version", "effectState": "not-confirmed"}
                state, reason, next_step = {
                    400: ("invalid-request", "agentos_tool_arguments_invalid", "correct-arguments"),
                    422: ("invalid-request", "agentos_tool_arguments_invalid", "correct-arguments"),
                    404: ("unavailable", "agentos_object_unavailable", "select-current-object"),
                    410: ("unavailable", "agentos_object_unavailable", "select-current-object"),
                    409: ("changed", "agentos_tool_state_changed", "read-current-state"),
                }[response.status_code]
                return {"state": state, "reason": reason, "nextStep": next_step,
                    "effectState": "not-confirmed"}
            if response.status_code >= 500 or response.status_code == 429:
                raise _rejected_response(response, AuthorityUnavailable, "agentos_authority_unavailable")
            if response.status_code not in {200, 400, 401, 403, 404, 409, 410, 422}:
                raise _rejected_response(response, AuthorityUnavailable, "agentos_authority_unavailable")
            if response.status_code != 200:
                raise _rejected_response(response, AuthorityDenied, "agentos_current_authority_denied")
            result = response.json()
            if not isinstance(result, dict):
                raise AuthorityUnavailable("agentos_authority_unavailable")
            return result
        except httpx.TimeoutException:
            # The original call may already be running. Do not immediately
            # repeat an entire slow read with the same provider call identity.
            error = AuthorityUnavailable("agentos_authority_timeout")
            error.retry_read = False
            raise error from None
        except (httpx.HTTPError, ValueError):
            # Neither network URLs nor upstream body/error prose reaches Agno.
            raise AuthorityUnavailable("agentos_authority_unavailable") from None

    def authorize(self, user_id, *, operation="read", resource_type=None, resource_id=None):
        if isinstance(user_id, str) and user_id.startswith("autonomy:"):
            if resource_type not in {None, "agents"} or resource_id not in {None, "galaxy-duty"}:
                raise AuthorityDenied("agentos_autonomy_resource_denied")
            result = self.duty_authorize(user_id, operation=operation)
            task = result.get("task")
            if result.get("allowed") is not True or not isinstance(task, dict):
                raise AuthorityDenied("agentos_current_authority_denied")
            return {**result, "execution": {**task, "id": task["taskId"]},
                "resourceIds": ["galaxy-duty"]}
        if isinstance(user_id, str) and user_id.startswith("conversation:"):
            return self.request("authorize", {"conversationId": conversation_id(user_id), "operation": operation,
                "resourceType": resource_type, "resourceId": resource_id})
        return self.request("authorize", {"executionId": execution_id(user_id), "operation": operation,
            "resourceType": resource_type, "resourceId": resource_id})

    def duty_authorize(self, user_id, *, operation="read"):
        if operation not in {"read", "run", "tool"}:
            raise AuthorityDenied("agentos_autonomy_operation_invalid")
        return self.request("autonomy/authorize", {"taskId": autonomy_id(user_id), "operation": operation})

    def duty_tool(self, user_id, tool, arguments, *, call_id, run_id, validation_failure=None):
        payload = {"taskId": autonomy_id(user_id), "callId": str(UUID(call_id)),
            "nativeRunId": run_id, "tool": tool, "arguments": arguments}
        if validation_failure is not None:
            payload["validationFailure"] = validation_failure
        return self.request("autonomy/tools/execute", payload, tool_feedback=True)

    def duty_report(self, user_id, data):
        return self.request("autonomy/report", {"taskId": autonomy_id(user_id), **data})

    def duty_code(self, user_id):
        return self.request("autonomy/code", {"taskId": autonomy_id(user_id)})

    def conversation_summary(self, user_id, *, run_id, call_id, session_id, turn_id):
        return self.conversation_tool(user_id, "workbench-summary", {}, run_id=run_id,
            call_id=call_id, session_id=session_id, turn_id=turn_id)

    def conversation_tool(self, user_id, tool: str, arguments: dict, *, run_id: str,
            call_id: str, session_id: str, turn_id: str, public_reference: dict | None = None):
        if (tool not in {"workbench-summary", "query-operations", "read-operation-object", "list-authorized-work",
                "run-authorized-work", "prepare-operation", "read-ai-delegation", "read-task-operation"}
                or not isinstance(arguments, dict)
                or not isinstance(run_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", run_id)):
            raise AuthorityDenied("agentos_tool_arguments_invalid")
        if not valid_provider_tool_call_id(call_id):
            # run_id and tool have passed the fixed native context checks
            # above. Never include call_id, arguments, body or exception text.
            diagnostic = {"code": "agentos_tool_call_id_invalid", "runId": run_id,
                "tool": tool, **rejected_tool_call_shape(call_id, max_length=PROVIDER_TOOL_CALL_ID_MAX_LENGTH)}
            _LOGGER.warning("agentos_tool_call_id_invalid %s", json.dumps(diagnostic,
                ensure_ascii=True, sort_keys=True, separators=(",", ":")))
            raise AuthorityDenied("agentos_tool_call_id_invalid")
        try:
            if str(UUID(session_id)) != session_id or str(UUID(turn_id)) != turn_id:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise AuthorityDenied("agentos_conversation_context_required") from None
        data = {"conversationId": conversation_id(user_id), "sessionId": session_id,
            "turnId": turn_id, "tool": tool, "arguments": arguments,
            "runId": run_id, "callId": conversation_call_reference(run_id, call_id)}
        if public_reference is not None:
            # The caller is this process's typed tool wrapper, not model input.
            if tool not in {"read-operation-object", "prepare-operation"}:
                raise AuthorityDenied("agentos_tool_arguments_invalid")
            data["publicReference"] = public_reference
        return self.request("tools/execute", data, tool_feedback=True)

    def tool(self, user_id, tool: str, arguments: dict, *, run_id: str, call_id: str):
        return self.request("tools/execute", {"executionId": execution_id(user_id), "tool": tool,
            "arguments": arguments, "runId": run_id, "callId": call_id})

    def close(self):
        self.client.close()
