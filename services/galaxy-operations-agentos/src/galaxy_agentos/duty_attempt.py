"""Bind one native attempt to its signed factory and original run."""
from uuid import UUID

from .gateway import AuthorityDenied


def attempt_id(value):
    if value is None:
        return None
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise AuthorityDenied("agentos_autonomy_attempt_invalid") from None
    return value


class AttemptGateway:
    def __init__(self, gateway, attempt):
        self.gateway = gateway
        self.attempt = attempt_id(attempt)

    def __getattr__(self, name):
        return getattr(self.gateway, name)

    def duty_authorize(self, user_id, *, operation="read"):
        return self.gateway.duty_authorize(user_id, operation=operation, **({"native_attempt_id": self.attempt} if self.attempt else {}))

    def duty_tool(self, user_id, tool, arguments, **kwargs):
        return self.gateway.duty_tool(user_id, tool, arguments, **({"native_attempt_id": self.attempt} if self.attempt else {}), **kwargs)

    def duty_report(self, user_id, data):
        if attempt_id(data.get("nativeAttemptId")) not in (None, self.attempt):
            raise AuthorityDenied("agentos_autonomy_attempt_invalid")
        return self.gateway.duty_report(user_id, {**data, **({"nativeAttemptId": self.attempt} if self.attempt else {})})

    def authorize(self, user_id, *, operation="read", resource_type=None, resource_id=None):
        if resource_type not in (None, "agents") or resource_id not in (None, "galaxy-duty"):
            raise AuthorityDenied("agentos_autonomy_resource_denied")
        result = self.duty_authorize(user_id, operation=operation)
        task = result.get("task")
        if result.get("allowed") is not True or not isinstance(task, dict):
            raise AuthorityDenied("agentos_current_authority_denied")
        return {**result, "execution": {**task, "id": task["taskId"]}, "resourceIds": ["galaxy-duty"]}
