from dataclasses import dataclass, field
from os import environ
from pathlib import Path
from urllib.parse import urlparse
import re

import yaml

SOURCE_COMMIT = "230f653523fa55aa446e1a5b6469f0871cf7278d"
VERSION = "1.108.0"
SCENARIOS = frozenset({"overview", "governance", "messaging", "discovery", "maintenance"})
ALIAS = re.compile(r"galaxy-[a-z0-9][a-z0-9_-]{0,62}")
CONFIG_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")


@dataclass(frozen=True)
class Settings:
    service_key: str = field(repr=False)
    models_file: str = "/app/config/models.empty.yaml"
    config_version: str = "unconfigured-v1"
    host: str = "127.0.0.1"
    port: int = 3351
    usage_file: str | None = None

    def __post_init__(self):
        if not isinstance(self.service_key, str) or len(self.service_key) < 32:
            raise ValueError("model_gateway_service_auth_not_configured")
        if not CONFIG_VERSION.fullmatch(self.config_version):
            raise ValueError("model_gateway_configuration_invalid")
        if self.host not in {"127.0.0.1", "::1"} or not 1024 <= self.port <= 65535:
            raise ValueError("model_gateway_listener_invalid")

    @classmethod
    def from_env(cls):
        # Read only this service's new namespace; never discover existing model
        # provider keys, user keys, DATABASE_URL or an unselected provider URL.
        return cls(service_key=environ.get("GALAXY_MODEL_GATEWAY_SERVICE_KEY", ""),
            models_file=environ.get("GALAXY_MODEL_GATEWAY_MODELS_FILE", "/app/config/models.empty.yaml"),
            config_version=environ.get("GALAXY_MODEL_GATEWAY_CONFIG_VERSION", "unconfigured-v1"),
            usage_file=environ.get("GALAXY_MODEL_GATEWAY_USAGE_FILE") or None,
            host=environ.get("GALAXY_MODEL_GATEWAY_HOST", "127.0.0.1"),
            port=int(environ.get("GALAXY_MODEL_GATEWAY_PORT", "3351")))


def load_models(path):
    """Accept the native model_list format, from an operator-mounted file only.

    Provider credentials are new protected environment references. They are
    never read by this loader, returned by status, or accepted in HTTP bodies.
    One alias has one explicitly configured route; no implicit/fallback route.
    """
    source = Path(path)
    if not source.is_file() or source.is_symlink() or source.stat().st_size > 262144:
        raise ValueError("model_gateway_configuration_invalid")
    try:
        payload = yaml.safe_load(source.read_text(encoding="utf-8"))
        if not isinstance(payload, dict) or set(payload) not in ({"model_list"}, {"model_list", "galaxy_profiles"}):
            raise ValueError()
        rows = payload["model_list"]
        if not isinstance(rows, list) or len(rows) > 100:
            raise ValueError()
        aliases = set()
        for row in rows:
            if not isinstance(row, dict) or set(row) not in ({"model_name", "litellm_params"}, {"model_name", "litellm_params", "model_info"}):
                raise ValueError()
            alias, params = row["model_name"], row["litellm_params"]
            if not isinstance(alias, str) or not ALIAS.fullmatch(alias) or alias in aliases:
                raise ValueError()
            aliases.add(alias)
            if not isinstance(params, dict) or set(params) != {"model", "api_base", "api_key"}:
                raise ValueError()
            # No bare provider model (e.g. gpt-*) can trigger implicit OpenAI
            # selection. Every upstream route and base URL is explicitly human.
            if not isinstance(params["model"], str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,39}/[^\s]{1,200}", params["model"]):
                raise ValueError()
            if not isinstance(params["api_base"], str): raise ValueError()
            address = urlparse(params["api_base"])
            if (address.scheme != "https" and not (address.scheme == "http" and address.hostname in {"127.0.0.1", "::1", "localhost"})
                    or not address.hostname or address.username or address.password or address.query or address.fragment):
                raise ValueError()
            if not isinstance(params["api_key"], str) or not re.fullmatch(r"os\.environ/GALAXY_MODEL_PROVIDER_[A-Z0-9_]{1,64}_KEY", params["api_key"]):
                raise ValueError()
            if "model_info" in row:
                info = row["model_info"]
                if (not isinstance(info, dict) or set(info) != {"mode", "max_input_tokens", "max_output_tokens", "supported_endpoints"}
                        or info["mode"] not in {"chat", "responses"}
                        or any(type(info[k]) is not int or not 1 <= info[k] <= 100000000 for k in ("max_input_tokens", "max_output_tokens"))
                        or info["supported_endpoints"] != ["/v1/responses" if info["mode"] == "responses" else "/v1/chat/completions"]):
                    raise ValueError()
        return rows
    except (OSError, UnicodeError, yaml.YAMLError, ValueError, TypeError, KeyError):
        raise ValueError("model_gateway_configuration_invalid") from None


def native_config(models):
    # These are native Proxy settings; only model_list is human-supplied here.
    # No database, virtual keys, budget ledger, UI, pass-through or remote sink.
    return {"model_list": models,
        "general_settings": {"master_key": "os.environ/GALAXY_MODEL_GATEWAY_SERVICE_KEY",
            "custom_auth": "galaxy_model_gateway.auth.authorize", "disable_spend_logs": True,
            "background_health_checks": False, "store_model_in_db": False},
        "router_settings": {"num_retries": 0, "max_fallbacks": 0, "fallbacks": [], "enable_pre_call_checks": True,
            "context_window_fallbacks": [], "content_policy_fallbacks": [], "default_fallbacks": [], "cache_responses": False},
        "litellm_settings": {"set_verbose": False, "suppress_debug_info": True,
            "turn_off_message_logging": True, "drop_params": False, "cache": False,
            "callbacks": ["galaxy_model_gateway.metadata.logger"]}}


def status(settings, models):
    return {"state": "running", "engine": "litellm-proxy", "version": VERSION,
        "sourceCommit": SOURCE_COMMIT, "configVersion": settings.config_version,
        "modelState": "configured" if models else "not-configured", "modelCount": len(models),
        "registeredAliases": [row["model_name"] for row in models],
        "configurationManagement": "human-protected-file", "budgetManagement": "upstream-api",
        "logging": "call-token-metadata-only"}
