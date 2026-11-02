"""Normalize only the trusted Go authorization's source projection."""
from .gateway import AuthorityUnavailable


def source_qualification(authority):
    if "sourceQualification" not in authority:
        # Older trusted Go validates the entire conversation before granting.
        return {"affectedTurns": [], "legacyUnknown": False, "legacySafeTurns": []}
    value = authority.get("sourceQualification")
    if (not isinstance(value, dict) or not isinstance(value.get("affectedTurns"), list)
            or type(value.get("legacyUnknown")) is not bool
            or not isinstance(value.get("legacySafeTurns", []), list)
            or not all(isinstance(x, str) for x in value["affectedTurns"])
            or not all(isinstance(x, str) for x in value.get("legacySafeTurns", []))):
        raise AuthorityUnavailable("agentos_source_qualification_unavailable")
    return {"affectedTurns": value["affectedTurns"], "legacyUnknown": value["legacyUnknown"],
        "legacySafeTurns": value.get("legacySafeTurns", [])}
