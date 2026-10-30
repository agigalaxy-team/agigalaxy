"""Closed Gemini finish-reason diagnostics before LiteLLM's stream mapping."""
from functools import wraps
from collections import OrderedDict
from threading import Lock

from .output import emit

_FINISH_REASONS = frozenset({"FINISH_REASON_UNSPECIFIED", "STOP", "MAX_TOKENS", "CONTINUATION",
    "SAFETY", "RECITATION", "LANGUAGE", "OTHER", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII",
    "MALFORMED_FUNCTION_CALL", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "TOO_MANY_TOOL_CALLS",
    "MALFORMED_RESPONSE", "NO_IMAGE", "IMAGE_RECITATION", "IMAGE_OTHER", "ESCALATION",
    "UNEXPECTED_TOOL_CALL", "MISSING_THOUGHT_SIGNATURE"})
_malformed = OrderedDict()
_lock = Lock()


def malformed_for(call_id):
    with _lock:
        return call_id in _malformed


def _record_malformed(call_id):
    with _lock:
        _malformed[call_id] = True
        _malformed.move_to_end(call_id)
        while len(_malformed) > 512: _malformed.popitem(last=False)


def install(iterator_class=None):
    if iterator_class is None:
        from litellm.llms.vertex_ai.gemini.vertex_and_google_ai_studio_gemini import ModelResponseIterator
        iterator_class = ModelResponseIterator
    parser = iterator_class.chunk_parser
    if getattr(parser, "_galaxy_finish_diagnostics", False): return

    @wraps(parser)
    def wrapped(self, chunk):
        try:
            from .metadata import safe_record
            details = getattr(getattr(self, "logging_obj", None), "model_call_details", None)
            row = safe_record(details, None, None, None) if isinstance(details, dict) else None
            candidates = chunk.get("candidates") if isinstance(chunk, dict) else None
            if row and isinstance(candidates, list):
                for candidate in candidates:
                    if isinstance(candidate, dict) and "finishReason" in candidate:
                        value = candidate["finishReason"]
                        reason = value if isinstance(value, str) and value in _FINISH_REASONS else "unknown"
                        if reason == "MALFORMED_FUNCTION_CALL": _record_malformed(row["callId"])
                        emit({"event":"provider-native-finish", "callId":row["callId"], "finishReason":reason})
        except Exception:
            pass  # Diagnostics must not alter provider processing.
        return parser(self, chunk)
    wrapped._galaxy_finish_diagnostics = True
    iterator_class.chunk_parser = wrapped
