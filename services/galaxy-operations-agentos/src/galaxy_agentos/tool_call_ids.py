"""Provider tool-call IDs are opaque pairing values, never authority/path IDs."""
import re
import unicodedata


TOOL_CALL_ID_MAX_LENGTH = 200
_TOOL_CALL_ID = re.compile(r"[\x21-\x7e]{1,200}")


def valid_tool_call_id(value):
    """Keep the exact bounded ASCII value: no trim, rewriting or normalization."""
    return isinstance(value, str) and _TOOL_CALL_ID.fullmatch(value) is not None


def projected_tool_call_id(value):
    return value if valid_tool_call_id(value) else None


def rejected_tool_call_shape(value):
    """Closed diagnostics only: never stringify or retain the supplied value."""
    if isinstance(value, str):
        value_type = "string"
    elif value is None:
        value_type = "null"
    elif type(value) is bool:
        value_type = "boolean"
    elif type(value) is int:
        value_type = "integer"
    elif type(value) is float:
        value_type = "number"
    elif isinstance(value, list):
        value_type = "array"
    elif isinstance(value, dict):
        value_type = "object"
    else:
        value_type = "other"
    is_string = isinstance(value, str)
    length = len(value) if is_string else None
    return {"valueType": value_type, "stringLength": length,
        "hasWhitespace": is_string and any(char.isspace() for char in value),
        "hasControl": is_string and any(unicodedata.category(char) == "Cc" for char in value),
        "hasNonAscii": is_string and any(ord(char) > 127 for char in value),
        "isEmpty": is_string and length == 0,
        "exceedsMaxLength": is_string and length > TOOL_CALL_ID_MAX_LENGTH}
