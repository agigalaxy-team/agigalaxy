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

    def view(self):
        return {"apiFormat": self.api_format, "contextWindow": self.context_window,
            "maxOutputTokens": self.max_output_tokens, "reasoningEffort": self.reasoning_effort,
            "timeoutSeconds": self.timeout_seconds, "toolCalling": self.tool_calling,
            "structuredOutput": self.structured_output}


def load_runtime_profile(value):
    if not isinstance(value, dict) or set(value) != {"apiFormat", "contextWindow", "maxOutputTokens",
            "reasoningEffort", "timeoutSeconds", "toolCalling", "structuredOutput"}:
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
    return RuntimeProfile(value["apiFormat"], window, output, effort,
        value["timeoutSeconds"], value["toolCalling"], value["structuredOutput"])


def native_model(profile, *, alias, base_url, api_key, headers):
    """Use upstream adapters; no provider SDK/router reimplementation here."""
    common = {"id": alias, "name": "LiteLLMProxy", "provider": "LiteLLM", "base_url": base_url,
        "api_key": api_key, "max_retries": 0, "retries": 0, "retry_with_guidance": False,
        "store": False, "default_headers": headers, "timeout": profile.timeout_seconds,
        "reasoning_effort": profile.reasoning_effort,
        "supports_native_structured_outputs": profile.structured_output}
    if profile.api_format == "openai-responses":
        from agno.models.openai.responses import OpenAIResponses
        return OpenAIResponses(**common, max_output_tokens=profile.max_output_tokens,
            use_previous_response_id=False, truncation="disabled", include=["reasoning.encrypted_content"])
    from agno.models.openai.like import OpenAILike
    # LiteLLM performs the selected upstream Anthropic/Gemini conversion. The
    # adapter and gateway stay on a single explicit Chat Completions surface.
    return OpenAILike(**common, max_tokens=profile.max_output_tokens)
