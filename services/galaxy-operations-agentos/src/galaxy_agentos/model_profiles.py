"""Human-selected runtime parameters for native Agno protocol adapters.

These are configuration, never model output or tool arguments. The gateway
enforces the same window/output limits on the serialized native request.
"""
from dataclasses import dataclass


FORMATS = frozenset({"openai-chat", "openai-responses", "anthropic", "gemini"})
EFFORTS = frozenset({"none", "minimal", "low", "medium", "high", "xhigh", "max"})


@dataclass(frozen=True)
class RuntimeProfile:
    api_format: str
    context_window: int
    max_output_tokens: int
    reasoning_effort: str | None
    timeout_seconds: int
    tool_calling: bool
    structured_output: bool
    image_understanding: bool | None = None
    parallel_tool_calls: bool | None = None
    verbosity: str | None = None
    context_compression: dict | None = None

    def view(self):
        value = {"apiFormat": self.api_format, "contextWindow": self.context_window,
            "maxOutputTokens": self.max_output_tokens, "reasoningEffort": self.reasoning_effort,
            "timeoutSeconds": self.timeout_seconds, "toolCalling": self.tool_calling,
            "structuredOutput": self.structured_output}
        if self.image_understanding is not None:value["imageUnderstanding"]=self.image_understanding
        if self.parallel_tool_calls is not None:value["parallelToolCalls"]=self.parallel_tool_calls
        if self.verbosity is not None:value["verbosity"]=self.verbosity
        if self.context_compression is not None: value["contextCompression"] = dict(self.context_compression)
        return value


def load_runtime_profile(value):
    required={"apiFormat", "contextWindow", "maxOutputTokens", "reasoningEffort", "timeoutSeconds", "toolCalling", "structuredOutput"}
    optional={"imageUnderstanding","parallelToolCalls","verbosity","contextCompression"}
    if not isinstance(value, dict) or not required.issubset(value) or set(value)-required-optional:
        raise ValueError("agentos_model_profile_invalid")
    if value["apiFormat"] not in FORMATS:
        raise ValueError("agentos_model_profile_invalid")
    window, output = value["contextWindow"], value["maxOutputTokens"]
    if type(window) is not int or not 1 <= window <= 100000000 or type(output) is not int or not 1 <= output < window:
        raise ValueError("agentos_model_profile_invalid")
    if value["apiFormat"] == "openai-responses" and output < 16:
        # The fixed native OpenAI transform raises smaller values to sixteen.
        # Refuse that silent widening of the operator's configured ceiling.
        raise ValueError("agentos_model_profile_invalid")
    effort = value["reasoningEffort"]
    if effort is not None and (not isinstance(effort, str) or effort not in EFFORTS):
        raise ValueError("agentos_model_profile_invalid")
    if value["apiFormat"] == "gemini" and effort in {"xhigh", "max"}:
        raise ValueError("agentos_model_profile_invalid")
    if type(value["timeoutSeconds"]) is not int or not 1 <= value["timeoutSeconds"] <= 1800:
        raise ValueError("agentos_model_profile_invalid")
    if any(type(value[name]) is not bool for name in ("toolCalling", "structuredOutput")):
        raise ValueError("agentos_model_profile_invalid")
    if "imageUnderstanding" in value and type(value["imageUnderstanding"]) is not bool:raise ValueError("agentos_model_profile_invalid")
    if value.get("parallelToolCalls") is not None and (type(value["parallelToolCalls"]) is not bool or not value["toolCalling"]):raise ValueError("agentos_model_profile_invalid")
    if value.get("verbosity") is not None and (value["verbosity"] not in {"low","medium","high"} or value["apiFormat"] not in {"openai-chat","openai-responses"}):raise ValueError("agentos_model_profile_invalid")
    compression = value.get("contextCompression")
    if "contextCompression" in value:
        if (not isinstance(compression, dict) or set(compression) != {"enabled", "triggerPercent", "recentTokens", "summaryTokens"}
                or type(compression["enabled"]) is not bool
                or type(compression["triggerPercent"]) is not int or not 50 <= compression["triggerPercent"] <= 95
                or type(compression["recentTokens"]) is not int or not 256 <= compression["recentTokens"] <= 100000000
                or type(compression["summaryTokens"]) is not int or not 128 <= compression["summaryTokens"] <= 100000000):
            raise ValueError("agentos_model_profile_invalid")
    return RuntimeProfile(value["apiFormat"], window, output, effort,
        value["timeoutSeconds"], value["toolCalling"], value["structuredOutput"],value.get("imageUnderstanding"),value.get("parallelToolCalls"),value.get("verbosity"), compression)


def native_model(profile, *, alias, base_url, api_key, headers):
    """Use upstream adapters; no provider SDK/router reimplementation here."""
    common = {"id": alias, "name": "LiteLLMProxy", "provider": "LiteLLM", "base_url": base_url,
        "api_key": api_key, "max_retries": 0, "retries": 0, "retry_with_guidance": False,
        "store": False, "default_headers": headers, "timeout": profile.timeout_seconds + 10,
        "reasoning_effort": profile.reasoning_effort,
        "supports_native_structured_outputs": profile.structured_output}
    if profile.verbosity is not None:common["verbosity"]=profile.verbosity
    if profile.api_format == "openai-responses":
        from agno.models.openai.responses import OpenAIResponses
        return OpenAIResponses(**common, **({"parallel_tool_calls":profile.parallel_tool_calls} if profile.parallel_tool_calls is not None else {}), max_output_tokens=profile.max_output_tokens,
            use_previous_response_id=False, truncation="disabled", include=["reasoning.encrypted_content"])
    from agno.models.openai.like import OpenAILike
    class GatewayOpenAILike(OpenAILike):
        def _format_all_messages(self, messages, compress_tool_results=False):
            # This endpoint is the selected LiteLLM protocol adapter, whose
            # opaque IDs can include Gemini thought signatures. Agno's OpenAI
            # provider max-40 history remapping would discard those signatures.
            # Preserve both original pairing values; reuse the native message
            # formatter and backwards-compatible combined-tool expansion.
            from agno.utils.message import normalize_tool_messages
            return [self._format_message(message, compress_tool_results)
                for message in normalize_tool_messages(messages)]
    # LiteLLM performs the selected upstream Anthropic/Gemini conversion. The
    # adapter and gateway stay on a single explicit Chat Completions surface.
    return GatewayOpenAILike(**common, max_tokens=profile.max_output_tokens,
        **({"request_params":{"parallel_tool_calls":profile.parallel_tool_calls}} if profile.parallel_tool_calls is not None else {}))
