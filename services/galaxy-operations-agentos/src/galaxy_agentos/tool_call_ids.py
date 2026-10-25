"""Provider tool-call IDs are opaque pairing values, never authority/path IDs."""
import re


TOOL_CALL_ID_MAX_LENGTH = 200
_TOOL_CALL_ID = re.compile(r"[\x21-\x7e]{1,200}")


def valid_tool_call_id(value):
    """Keep the exact bounded ASCII value: no trim, rewriting or normalization."""
    return isinstance(value, str) and _TOOL_CALL_ID.fullmatch(value) is not None


def projected_tool_call_id(value):
    return value if valid_tool_call_id(value) else None
