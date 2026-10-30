"""Closed Gemini finish-reason diagnostics before LiteLLM's stream mapping."""
from functools import wraps

from .output import emit

_FINISH_REASONS = frozenset({"FINISH_REASON_UNSPECIFIED", "STOP", "MAX_TOKENS", "CONTINUATION",
    "SAFETY", "RECITATION", "LANGUAGE", "OTHER", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII",
    "MALFORMED_FUNCTION_CALL", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "TOO_MANY_TOOL_CALLS",
    "MALFORMED_RESPONSE", "NO_IMAGE", "IMAGE_RECITATION", "IMAGE_OTHER", "ESCALATION",
    "UNEXPECTED_TOOL_CALL", "MISSING_THOUGHT_SIGNATURE"})


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
                        emit({"event":"provider-native-finish", "callId":row["callId"], "finishReason":reason})
        except Exception:
            pass  # Diagnostics must not alter provider processing.
        return parser(self, chunk)
    wrapped._galaxy_finish_diagnostics = True
    iterator_class.chunk_parser = wrapped
