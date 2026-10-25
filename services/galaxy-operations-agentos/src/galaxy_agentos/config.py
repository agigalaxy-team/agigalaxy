from dataclasses import dataclass, field
from os import environ
from urllib.parse import urlparse
import re

from .model_settings import load_bindings, validate_gateway, configured_domains


@dataclass(frozen=True)
class Settings:
    database_url: str = field(repr=False)
    authority_url: str
    service_key: str = field(repr=False)
    verification_key: str = field(repr=False)
    issuer: str = "galaxy-operations"
    audience: str = "galaxy-agentos"
    model_id: str | None = None
    model_base_url: str | None = None
    model_api_key: str | None = field(default=None, repr=False)
    model_data_policy_approved: bool = False
    model_gateway_url: str | None = None
    model_gateway_key: str | None = field(default=None, repr=False)
    model_bindings_file: str | None = None
    host: str = "127.0.0.1"
    port: int = 7791
    allow_internal_http: bool = False
    database_schema: str = "galaxy_agentos"
    work_timeout_seconds: int = 600

    def __post_init__(self):
        if not self.database_url.startswith("postgresql+psycopg:"):
            raise ValueError("agentos_database_configuration_invalid")
        if not re.fullmatch(r"galaxy_agentos[a-z0-9_]{0,50}", self.database_schema):
            raise ValueError("agentos_database_schema_invalid")
        parsed = urlparse(self.authority_url)
        if parsed.scheme != "https" and not (parsed.scheme == "http" and (self.allow_internal_http or parsed.hostname in {"localhost", "127.0.0.1", "::1"})):
            raise ValueError("agentos_authority_configuration_invalid")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("agentos_authority_configuration_invalid")
        if min(len(self.service_key), len(self.verification_key)) < 32:
            raise ValueError("agentos_service_auth_not_configured")
        if type(self.work_timeout_seconds) is not int or not 30 <= self.work_timeout_seconds <= 3600:
            raise ValueError("agentos_work_timeout_invalid")
        if self.model_id or self.model_base_url or self.model_api_key or self.model_data_policy_approved:
            raise ValueError("agentos_direct_provider_configuration_unsupported")
        validate_gateway(self.model_gateway_url, self.model_gateway_key)
        self.model_bindings

    @property
    def model_bindings(self):
        # Human settings are atomically replaced by the existing settings
        # consumer. Each new duty resolves this file, never a startup snapshot.
        return load_bindings(self.model_bindings_file)

    @property
    def model_configured(self) -> bool:
        return bool(configured_domains(self))

    @classmethod
    def from_env(cls):
        # No default model, upstream URL, credential, or production database.
        return cls(
            database_url=environ.get("GALAXY_AGENTOS_DATABASE_URL", ""),
            authority_url=environ.get("GALAXY_AGENTOS_AUTHORITY_URL", ""),
            service_key=environ.get("GALAXY_AGENTOS_SERVICE_KEY", ""),
            verification_key=environ.get("GALAXY_AGENTOS_VERIFICATION_KEY", ""),
            model_id=environ.get("GALAXY_AGENTOS_MODEL_ID") or None,
            model_base_url=environ.get("GALAXY_AGENTOS_MODEL_BASE_URL") or None,
            model_api_key=environ.get("GALAXY_AGENTOS_MODEL_API_KEY") or None,
            model_data_policy_approved=environ.get("GALAXY_AGENTOS_MODEL_DATA_POLICY_APPROVED") == "true",
            model_gateway_url=environ.get("GALAXY_AGENTOS_MODEL_GATEWAY_URL") or None,
            model_gateway_key=environ.get("GALAXY_AGENTOS_MODEL_GATEWAY_KEY") or None,
            model_bindings_file=environ.get("GALAXY_AGENTOS_MODEL_BINDINGS_FILE") or None,
            host=environ.get("GALAXY_AGENTOS_HOST", "127.0.0.1"),
            port=int(environ.get("GALAXY_AGENTOS_PORT", "7791")),
            allow_internal_http=environ.get("GALAXY_AGENTOS_ALLOW_INTERNAL_HTTP") == "true",
            database_schema=environ.get("GALAXY_AGENTOS_DATABASE_SCHEMA", "galaxy_agentos"),
            work_timeout_seconds=int(environ.get("GALAXY_AGENTOS_WORK_TIMEOUT_SECONDS", "600")),
        )
