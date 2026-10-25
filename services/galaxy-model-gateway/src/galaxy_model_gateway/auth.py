def configure(settings, models):
    global _settings, _aliases
    _settings, _aliases = settings, [row["model_name"] for row in models]


async def authorize(request, api_key):
    """Native open-source custom_auth hook, after the private surface gate."""
    from fastapi import HTTPException
    from litellm.proxy._types import UserAPIKeyAuth, LitellmUserRoles
    if not getattr(request.state, "galaxy_model_authorized", False):
        raise HTTPException(status_code=401, detail="model_gateway_authorization_required")
    # This is the Proxy's internal service identity, never a Galaxy admin role.
    return UserAPIKeyAuth(api_key="galaxy-agentos-service", models=list(_aliases),
        user_role=LitellmUserRoles.INTERNAL_USER, metadata={"galaxy_config_version": _settings.config_version})
