"""Explicit, fail-closed PostgreSQL target for durable Native tests.

This module uses only the standard library until the read-only target probe.
It never loads runtime configuration or prints connection strings.
"""
from dataclasses import dataclass, field
import re
from urllib.parse import unquote, urlsplit


class TestDatabaseConfigurationError(RuntimeError):
    pass


@dataclass(frozen=True)
class TestDatabaseTarget:
    url: str = field(repr=False)
    database: str
    role: str
    schema: str


def test_database_target(environ):
    names = ("GALAXY_AGENTOS_TEST_DATABASE_URL", "GALAXY_AGENTOS_TEST_DATABASE_NAME",
             "GALAXY_AGENTOS_TEST_ROLE", "GALAXY_AGENTOS_TEST_SCHEMA")
    values = [environ.get(name, "") for name in names]
    if not all(values):
        raise TestDatabaseConfigurationError("agentos_test_database_explicit_configuration_required")
    url, database, role, schema = values
    if not all(re.fullmatch(r"galaxy_agentos_test_[a-z0-9_]{1,40}", x) for x in (database, role, schema)):
        raise TestDatabaseConfigurationError("agentos_test_database_names_invalid")
    try:
        parsed = urlsplit(url)
        valid = (parsed.scheme == "postgresql+psycopg" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
                 and parsed.port is not None and unquote(parsed.path.lstrip("/")) == database
                 and unquote(parsed.username or "") == role and not parsed.query and not parsed.fragment)
    except ValueError:
        valid = False
    if not valid:
        raise TestDatabaseConfigurationError("agentos_test_database_target_invalid")
    runtime = environ.get("GALAXY_AGENTOS_DATABASE_URL", "")
    if runtime:
        try:
            live = urlsplit(runtime)
            if (live.hostname, live.port, live.path) == (parsed.hostname, parsed.port, parsed.path):
                raise TestDatabaseConfigurationError("agentos_test_database_runtime_target_forbidden")
        except ValueError:
            pass
    return TestDatabaseTarget(url, database, role, schema)


def verify_test_database_target(target, *, connect=None):
    """Probe actual DB/role privileges before Agno can create a schema/table."""
    if connect is None:
        import psycopg
        connect = psycopg.connect
    try:
        with connect(target.url.replace("postgresql+psycopg:", "postgresql:", 1),
                     autocommit=True, options="-c default_transaction_read_only=on") as db:
            with db.cursor() as cursor:
                cursor.execute("""SELECT current_database(), session_user, current_user,
                    r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls
                    FROM pg_roles r WHERE r.rolname=current_user""")
                row = cursor.fetchone()
                if not row or tuple(row[:3]) != (target.database, target.role, target.role) or any(row[3:]):
                    raise TestDatabaseConfigurationError("agentos_test_database_actual_identity_denied")
                cursor.execute("SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user) LIMIT 1")
                if cursor.fetchone():
                    raise TestDatabaseConfigurationError("agentos_test_database_inherited_role_denied")
                cursor.execute("""SELECT 1 FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user)
                    AND datname<>current_database() LIMIT 1""")
                if cursor.fetchone():
                    raise TestDatabaseConfigurationError("agentos_test_database_other_database_owner_denied")
                cursor.execute("""SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner
                    WHERE n.nspname=%s AND r.rolname<>current_user""", (target.schema,))
                if cursor.fetchone():
                    raise TestDatabaseConfigurationError("agentos_test_database_schema_owner_denied")
    except TestDatabaseConfigurationError:
        raise
    except Exception:
        # Driver errors may contain a DSN or authentication fields.
        raise TestDatabaseConfigurationError("agentos_test_database_readonly_probe_failed") from None
    return target
