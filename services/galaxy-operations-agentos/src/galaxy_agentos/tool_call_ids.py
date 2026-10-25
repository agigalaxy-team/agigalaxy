"""Provider tool-call IDs are opaque pairing values, never authority/path IDs."""
import re
import unicodedata
from uuid import NAMESPACE_URL, uuid5


TOOL_CALL_ID_MAX_LENGTH = 200
PROVIDER_TOOL_CALL_ID_MAX_LENGTH = 16 * 1024
_TOOL_CALL_ID = re.compile(r"[\x21-\x7e]{1,200}")
_PROVIDER_TOOL_CALL_ID = re.compile(r"[\x21-\x7e]{1,16384}")
_RUN_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
_REFERENCE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")


def valid_tool_call_id(value):
    """Keep the exact bounded ASCII value: no trim, rewriting or normalization."""
    return isinstance(value, str) and _TOOL_CALL_ID.fullmatch(value) is not None


def projected_tool_call_id(value):
    # The default storage caller is duty-private history, whose PAUSED
    # coordinate must retain the complete bounded provider pairing value.
    # Conversation database writes explicitly use conversation_call_reference.
    return value if valid_provider_tool_call_id(value) else None


def valid_provider_tool_call_id(value):
    """Bound the opaque in-memory SDK ID, including adapter thought signatures."""
    return isinstance(value, str) and _PROVIDER_TOOL_CALL_ID.fullmatch(value) is not None


def valid_run_context_id(value):
    return isinstance(value, str) and _RUN_ID.fullmatch(value) is not None


def conversation_call_reference(run_id, provider_call_id):
    """A tracking reference, never a replacement for the SDK's pairing ID.

    The namespace is separate from duty's existing task/run UUID5 mapping.
    The complete provider value participates, even when it resembles a UUID.
    """
    if not valid_run_context_id(run_id) or not valid_provider_tool_call_id(provider_call_id):
        return None
    return str(uuid5(NAMESPACE_URL, "galaxy-conversation-tool:v1:" + run_id + ":" + provider_call_id))


def valid_conversation_reference(value):
    # This shape alone never proves a provider ID is an internal reference.
    return isinstance(value, str) and _REFERENCE.fullmatch(value) is not None


def rejected_tool_call_shape(value, *, max_length=TOOL_CALL_ID_MAX_LENGTH):
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
        "exceedsMaxLength": is_string and length > max_length}
