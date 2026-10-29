from agno.os.authz.provider import AuthorizationContext, AuthorizationProvider

from .gateway import AuthorityDenied


class GalaxyAuthorization(AuthorizationProvider):
    """One authority plane. Token scopes never create a second OR bypass."""

    enforces_token_scopes = False

    def __init__(self, gateway):
        self.gateway = gateway

    def _gateway(self, ctx):
        if isinstance(ctx.principal_id, str) and ctx.principal_id.startswith("autonomy:"):
            from .duty_attempt import AttemptGateway
            claims = ctx.claims or {}
            return AttemptGateway(self.gateway, claims.get("nativeAttemptId"))
        return self.gateway

    def check(self, ctx: AuthorizationContext) -> bool:
        if ctx.resource_type not in {"agents", "workflows"} or ctx.action not in {"read", "run"}:
            return False
        try:
            result = self._gateway(ctx).authorize(ctx.principal_id, operation=ctx.action,
                resource_type=ctx.resource_type, resource_id=ctx.resource_id)
            return result.get("allowed") is True
        except AuthorityDenied:
            return False

    def accessible_resource_ids(self, ctx: AuthorizationContext) -> set[str]:
        try:
            result = self._gateway(ctx).authorize(ctx.principal_id, operation="read", resource_type=ctx.resource_type)
            return set(result.get("resourceIds", [])) if result.get("allowed") is True else set()
        except AuthorityDenied:
            return set()

    def authorize_route(self, ctx, required_scopes):
        # Native ownership gates additionally bind sessions/runs/traces to the
        # verified sub. No memory, config, database migration, authz or MCP API.
        allowed = {"agents:read", "agents:run", "workflows:read", "workflows:run",
            "sessions:read", "runs:read", "runs:cancel", "traces:read"}
        if not required_scopes or any(scope not in allowed for scope in required_scopes):
            return False
        try:
            result = self._gateway(ctx).authorize(ctx.principal_id,
                operation="run" if any(scope.endswith((":run", ":cancel")) for scope in required_scopes) else "read",
                resource_type=ctx.resource_type, resource_id=ctx.resource_id)
            return result.get("allowed") is True
        except AuthorityDenied:
            return False
