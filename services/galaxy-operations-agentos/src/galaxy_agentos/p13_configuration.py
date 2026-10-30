"""Model-facing shape generated from the shared P13 strategy contract.

The owning Go service validates all custom refinements and authorization.
"""
import json
from pathlib import Path
from typing import Annotated
from pydantic import WithJsonSchema

_SCHEMA = json.loads(Path(__file__).with_name("p13_configuration_schema.json").read_text(encoding="utf-8"))
P13Configuration = Annotated[dict, WithJsonSchema(_SCHEMA)]


def validate_configuration(value):
    """Bounded schema diagnostics; Go remains authoritative for refinements."""
    from jsonschema import Draft202012Validator, FormatChecker
    errors = sorted(Draft202012Validator(_SCHEMA, format_checker=FormatChecker()).iter_errors(value),
        key=lambda e: (list(map(str, e.absolute_path)), e.validator or ""))
    if not errors:
        return None
    details = []
    for error in errors[:8]:
        path = [str(part)[:80] if isinstance(part, str) else part for part in list(error.absolute_path)[:8]]
        details.append({"path": path, "constraint": str(error.validator)[:40],
            "expected": list(error.validator_value)[:20] if error.validator == "required" and isinstance(error.validator_value, list) else str(error.validator_value)[:160] if error.validator in {"type", "enum", "const"} else None})
    return {"state": "invalid-request", "reason": "strategy_configuration_schema_invalid",
        "errors": details, "cardPrepared": False, "effectExecuted": False,
        "retryable": True, "nextStep": "correct-arguments"}
