"""Human-selected scenario aliases for the private native LiteLLM Proxy.

No supplier key/provider selection exists in Agno. An empty mapping creates no
model, even if SDK/provider environment defaults happen to exist.
"""
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse
import json
import re

import httpx
from .gateway import AuthorityDenied
from .model_profiles import load_runtime_profile, native_model

DOMAINS = ("overview", "governance", "messaging", "discovery", "maintenance")
ALIAS = re.compile(r"galaxy-[a-z0-9][a-z0-9_-]{0,62}")
VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")


@dataclass(frozen=True)
class SceneBinding:
    alias: str
    approved: bool
    parameters: dict
    runtime_profile: object = None
    fallbacks: tuple = ()


def load_bindings(path):
    if path is None: return "unconfigured-v1", {domain: None for domain in DOMAINS}
    source = Path(path)
    if not source.is_file() or source.is_symlink() or source.stat().st_size > 65536:
        raise ValueError("agentos_model_settings_invalid")
    try:
        value = json.loads(source.read_text(encoding="utf-8"))
        if (not isinstance(value, dict) or set(value) != {"version", "scenarios"}
                or not isinstance(value["version"], str) or not VERSION.fullmatch(value["version"])
                or not isinstance(value["scenarios"], dict) or set(value["scenarios"]) != set(DOMAINS)):
            raise ValueError()
        result = {}
        for domain, binding in value["scenarios"].items():
            if binding is None:
                result[domain] = None
                continue
            if (not isinstance(binding, dict) or set(binding)-{'fallbacks'} not in ({"alias", "dataPolicyApproved", "parameters"},
                    {"alias", "dataPolicyApproved", "runtimeProfile"})
                    or not isinstance(binding["alias"], str) or not ALIAS.fullmatch(binding["alias"])
                    or type(binding["dataPolicyApproved"]) is not bool):
                raise ValueError()
            if "runtimeProfile" in binding:
                profile = load_runtime_profile(binding["runtimeProfile"])
                if domain == "governance" and not profile.tool_calling:
                    raise ValueError()
                backups=binding.get('fallbacks',[])
                if not isinstance(backups,list) or len(backups)>3:raise ValueError()
                parsed=[]
                for backup in backups:
                    if not isinstance(backup,dict) or set(backup)!={'alias','dataPolicyApproved','runtimeProfile'} or not isinstance(backup['alias'],str) or not ALIAS.fullmatch(backup['alias']) or backup['dataPolicyApproved'] is not True:raise ValueError()
                    parsed.append(SceneBinding(backup['alias'],True,{},load_runtime_profile(backup['runtimeProfile'])))
                if len({item.alias for item in parsed}|{binding['alias']})!=len(parsed)+1:raise ValueError()
                result[domain] = SceneBinding(binding["alias"], binding["dataPolicyApproved"], {}, profile,tuple(parsed))
                continue
            if not isinstance(binding["parameters"], dict):
                raise ValueError()
            if binding.get('fallbacks'):raise ValueError()
            params = binding["parameters"]
            if set(params) - {"temperature", "top_p", "max_tokens", "max_completion_tokens"}:
                raise ValueError()
            for key, parameter in params.items():
                if key in {"max_tokens", "max_completion_tokens"}:
                    if type(parameter) is not int or not 1 <= parameter <= 1000000: raise ValueError()
                elif type(parameter) not in {int, float} or not 0 <= parameter <= (2 if key == "temperature" else 1):
                    raise ValueError()
            result[domain] = SceneBinding(binding["alias"], binding["dataPolicyApproved"], dict(params))
        return value["version"], result
    except (ValueError, TypeError, KeyError, OSError, UnicodeError):
        raise ValueError("agentos_model_settings_invalid") from None


def validate_gateway(url, key):
    if url is None and key is None: return
    if not isinstance(url, str) or not isinstance(key, str) or len(key) < 32:
        raise ValueError("agentos_model_gateway_configuration_invalid")
    address = urlparse(url)
    if (address.scheme != "https" and not (address.scheme == "http" and address.hostname in {"127.0.0.1", "::1", "localhost"})
            or not address.hostname or address.username or address.password or address.query or address.fragment
            or address.path.rstrip("/") not in {"", "/v1"}):
        raise ValueError("agentos_model_gateway_configuration_invalid")


def gateway_base(settings):
    base = settings.model_gateway_url.rstrip("/")
    return base if base.endswith("/v1") else base + "/v1"


def model_settings_view(settings):
    version, scenes = settings.model_bindings
    connected_configuration = bool(settings.model_gateway_url and settings.model_gateway_key)
    return {"version": version, "management": "human-protected-file", "providerSecrets": "gateway-only",
        "gatewayConfiguration": "configured" if connected_configuration else "not-configured",
        "gatewayAvailability": "not-checked", "scenarios": [{"domain": domain,
            "state": "not-configured" if binding is None else "data-policy-unapproved" if not binding.approved
                else "configured" if connected_configuration else "gateway-not-configured",
            "alias": binding.alias if binding else None,
            "parameters": dict(binding.parameters) if binding else {},
            "runtimeProfile": binding.runtime_profile.view() if binding and binding.runtime_profile else None,
            "fallbacks":[{"alias":item.alias,"dataPolicyApproved":item.approved,"runtimeProfile":item.runtime_profile.view()} for item in binding.fallbacks] if binding else []}
            for domain, binding in scenes.items()]}


def configured_domains(settings):
    if not settings.model_gateway_url or not settings.model_gateway_key: return frozenset()
    return frozenset(domain for domain, binding in settings.model_bindings[1].items() if binding and binding.approved)


def require_registered_alias(settings, alias, *, transport=None, expected_version=None):
    """Read native catalog/version before each invocation; never call a model."""
    try:
        with httpx.Client(trust_env=False, transport=transport, timeout=5, follow_redirects=False) as client:
            response = client.get(gateway_base(settings) + "/models", headers={"Authorization": "Bearer " + settings.model_gateway_key})
        if response.status_code != 200 or response.headers.get("x-galaxy-model-config-version") != (expected_version or settings.model_bindings[0]):
            raise ValueError()
        body = response.json()
        if not isinstance(body, dict) or not isinstance(body.get("data"), list) or len(body["data"]) > 100:
            raise ValueError()
        if not any(isinstance(item, dict) and item.get("id") == alias for item in body["data"]):
            raise ValueError()
    except (ValueError, httpx.HTTPError):
        raise AuthorityDenied("agentos_model_gateway_unavailable_or_unassigned") from None


def domain_model(settings, domain, gateway):
    version, scenes = settings.model_bindings
    binding = scenes.get(domain)
    if not settings.model_gateway_url or not settings.model_gateway_key or not binding or not binding.approved:
        raise AuthorityDenied("agentos_model_not_configured")
    from agno.models.openai.like import OpenAILike
    from .model_gate import with_current_authority
    from .provider_retry import with_provider_retry
    from .model_correlation import install_model_correlation
    # Native LiteLLMOpenAI inherits this same protocol adapter, but importing
    # agno.models.litellm first imports its separate SDK-backed implementation.
    # Keep the native OpenAI-compatible adapter without another gateway SDK.
    headers = {"X-Galaxy-Model-Scenario": domain, "X-Galaxy-Model-Config-Version": version}
    if binding.runtime_profile:
        model = native_model(binding.runtime_profile, alias=binding.alias, base_url=gateway_base(settings),
            api_key=settings.model_gateway_key, headers=headers)
    else:
        model = OpenAILike(id=binding.alias, name="LiteLLMProxy", provider="LiteLLM",
            base_url=gateway_base(settings), api_key=settings.model_gateway_key,
            max_retries=0, retries=0, retry_with_guidance=False, store=False,
            default_headers=headers, **binding.parameters)
    def admission(current):
        if current.get("execution", {}).get("domain") != domain:
            raise AuthorityDenied("agentos_model_scenario_denied")
        require_registered_alias(settings, binding.alias, expected_version=version)
    install_model_correlation(model)
    model._galaxy_settings_version = version
    primary=with_provider_retry(with_current_authority(model, gateway, admission=admission))
    if not binding.fallbacks:return primary
    backups=[]
    for backup in binding.fallbacks:
        item=native_model(backup.runtime_profile,alias=backup.alias,base_url=gateway_base(settings),api_key=settings.model_gateway_key,headers=headers)
        install_model_correlation(item)
        item._galaxy_settings_version=version
        item._galaxy_usage_parent=primary
        def backup_admission(current,alias=backup.alias):
            if current.get('execution',{}).get('domain')!=domain:raise AuthorityDenied('agentos_model_scenario_denied')
            require_registered_alias(settings,alias,expected_version=version)
        backups.append(with_provider_retry(with_current_authority(item,gateway,admission=backup_admission)))
    from .model_failover import with_model_failover
    return with_model_failover(primary,backups)
