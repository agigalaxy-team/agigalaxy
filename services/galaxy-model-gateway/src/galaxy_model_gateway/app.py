import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
import tempfile
import yaml

from .policy import Settings, load_models, native_config, SOURCE_COMMIT
from .output import restrict_library_output, emit


def create_app(settings, *, quiet=True):
    models = load_models(settings.models_file)
    from .profiles import load_profiles
    profiles = load_profiles(settings.models_file, models)
    from .endpoints import normalize_routes
    normalize_routes(models, profiles)
    from .usage import UsageStore
    usage_store = UsageStore(settings.usage_file) if settings.usage_file else None
    if profiles and usage_store is None:
        raise ValueError("model_gateway_usage_store_not_configured")
    for row in models:
        reference = row["litellm_params"]["api_key"].removeprefix("os.environ/")
        if not os.environ.get(reference):
            raise ValueError("model_gateway_provider_credentials_not_configured")
    if quiet: restrict_library_output()
    # Force safe process-local behavior before importing the native SDK/Proxy.
    # No provider key is discovered or copied. Do not inherit a DB, remote
    # callback, CLI model, automatic health request or telemetry configuration.
    for key in ("DATABASE_URL", "DIRECT_URL", "REDIS_URL", "WORKER_CONFIG", "LITELLM_CONFIG_BUCKET_NAME",
            "LITELLM_LOG", "LITELLM_MODEL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY",
            "LITELLM_LICENSE", "LITELLM_LICENSE_KEY", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"):
        os.environ.pop(key, None)
    os.environ.update({"LITELLM_LOCAL_MODEL_COST_MAP": "True", "LITELLM_TELEMETRY": "False",
        "LITELLM_TELEMETRY_DISABLED": "true", "DO_NOT_TRACK": "1",
        "LITELLM_DONT_SHOW_FEEDBACK_BOX": "True", "DISABLE_ADMIN_UI": "True",
        "LITELLM_MASTER_KEY": settings.service_key,
        "GALAXY_MODEL_GATEWAY_SERVICE_KEY": settings.service_key})
    descriptor, name = tempfile.mkstemp(prefix="galaxy-litellm-", suffix=".yaml")
    with os.fdopen(descriptor, "w") as output: yaml.safe_dump(native_config(models), output, sort_keys=False)
    os.environ["CONFIG_FILE_PATH"] = name
    from .auth import configure
    configure(settings, models)
    from .metadata import configure_usage
    configure_usage(usage_store)
    from litellm.proxy.proxy_server import app
    from .surface import PrivateSurface
    original = app.router.lifespan_context
    @asynccontextmanager
    async def native_lifespan(instance):
        try:
            async with original(instance) as state:
                emit({"event": "model-gateway-started", "sourceCommit": SOURCE_COMMIT,
                    "modelState": "configured" if models else "not-configured", "modelCount": len(models)})
                yield state
        except Exception:
            emit({"event": "model-gateway-error", "code": "model_gateway_native_runtime_failed"})
            raise
        finally: Path(name).unlink(missing_ok=True)
    app.router.lifespan_context = native_lifespan
    app.add_middleware(PrivateSurface, settings=settings, models=models, profiles=profiles, usage_store=usage_store)
    return app


def main():
    try:
        settings = Settings.from_env()
        app = create_app(settings)
        import uvicorn
        uvicorn.run(app, host=settings.host, port=settings.port, access_log=False, log_config=None)
    except Exception:
        emit({"event": "model-gateway-error", "code": "model_gateway_configuration_or_startup_failed"})
        raise SystemExit(1) from None


if __name__ == "__main__": main()
