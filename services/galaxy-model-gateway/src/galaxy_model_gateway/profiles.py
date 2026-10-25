"""Admission for operator-selected profiles, independent of prompt content."""
from pathlib import Path

import yaml

from .policy import ALIAS, SCENARIOS

FORMATS = frozenset({"openai-chat", "openai-responses", "anthropic", "gemini"})
EFFORTS = frozenset({"none", "minimal", "low", "medium", "high", "xhigh", "max"})
PROFILE_FIELDS = frozenset({"apiFormat", "contextWindow", "maxOutputTokens", "reasoningEffort",
    "timeoutSeconds", "toolCalling", "structuredOutput", "scenarios"})


def load_profiles(path, models):
    # load_models has already checked the exact protected file and model routes.
    payload = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    raw = payload.get("galaxy_profiles")
    if raw is None:
        return {}
    if not isinstance(raw, dict) or set(raw) != {row["model_name"] for row in models}:
        raise ValueError("model_gateway_profile_invalid")
    result = {}
    routes = {row["model_name"]: row for row in models}
    for alias, value in raw.items():
        if not ALIAS.fullmatch(alias) or not isinstance(value, dict) or set(value) != PROFILE_FIELDS:
            raise ValueError("model_gateway_profile_invalid")
        if value["apiFormat"] not in FORMATS:
            raise ValueError("model_gateway_profile_invalid")
        window, output = value["contextWindow"], value["maxOutputTokens"]
        if type(window) is not int or not 1 <= window <= 100000000 or type(output) is not int or not 1 <= output < window:
            raise ValueError("model_gateway_profile_invalid")
        if value["apiFormat"] == "openai-responses" and output < 16:
            raise ValueError("model_gateway_profile_invalid")
        effort = value["reasoningEffort"]
        if effort is not None and (not isinstance(effort, str) or effort not in EFFORTS):
            raise ValueError("model_gateway_profile_invalid")
        if value["apiFormat"] == "gemini" and effort in {"xhigh", "max"}:
            raise ValueError("model_gateway_profile_invalid")
        if type(value["timeoutSeconds"]) is not int or not 1 <= value["timeoutSeconds"] <= 1800:
            raise ValueError("model_gateway_profile_invalid")
        if any(type(value[name]) is not bool for name in ("toolCalling", "structuredOutput")):
            raise ValueError("model_gateway_profile_invalid")
        domains = value["scenarios"]
        if not isinstance(domains, list) or len(set(domains)) != len(domains) or any(x not in SCENARIOS for x in domains):
            raise ValueError("model_gateway_profile_invalid")
        row = routes[alias]
        mode = "responses" if value["apiFormat"] == "openai-responses" else "chat"
        expected_info = {"mode": mode, "max_input_tokens": window - output, "max_output_tokens": output,
            "supported_endpoints": ["/v1/responses" if mode == "responses" else "/v1/chat/completions"]}
        prefix = {"openai-chat": "custom_openai/", "openai-responses": "custom_openai/",
            "anthropic": "anthropic/", "gemini": "gemini/"}[value["apiFormat"]]
        if row.get("model_info") != expected_info or not row["litellm_params"]["model"].startswith(prefix):
            raise ValueError("model_gateway_profile_invalid")
        result[alias] = dict(value)
    return result


def admit_profile(payload, profile, *, responses, scene):
    if scene not in profile["scenarios"] or responses != (profile["apiFormat"] == "openai-responses"):
        raise ValueError("model_gateway_model_scenario_denied")
    if payload.get("tools") and not profile["toolCalling"]:
        raise ValueError("model_gateway_capability_unavailable")
    if (payload.get("response_format") or payload.get("text")) and not profile["structuredOutput"]:
        raise ValueError("model_gateway_capability_unavailable")
    ceiling = "max_output_tokens" if responses else "max_tokens"
    present = [key for key in ("max_tokens", "max_completion_tokens", "max_output_tokens") if key in payload]
    if len(present) != 1 or type(payload[present[0]]) is not int or payload[present[0]] != profile["maxOutputTokens"]:
        raise ValueError("model_gateway_configuration_changed")
    payload[ceiling] = payload.pop(present[0])
    expected = profile["reasoningEffort"]
    actual = payload.get("reasoning", {}).get("effort") if responses and isinstance(payload.get("reasoning", {}), dict) else payload.get("reasoning_effort")
    if actual != expected:
        raise ValueError("model_gateway_configuration_changed")
    if responses and (payload.get("truncation", "disabled") != "disabled" or payload.get("background", False) is not False):
        raise ValueError("model_gateway_request_invalid")
    if responses:
        payload["truncation"] = "disabled"
    return payload


def estimated_input_tokens(payload, *, upstream_model, responses):
    """Reuse native conversion/counting; never contact an inference provider.

    This is a local estimate, not a supplier usage receipt. A failed count is
    reported explicitly instead of disabling the configured window silently.
    """
    import litellm
    messages = payload.get("messages")
    if responses:
        from litellm.responses.litellm_completion_transformation.transformation import LiteLLMCompletionResponsesConfig
        messages = LiteLLMCompletionResponsesConfig.transform_responses_api_input_to_messages(
            input=payload["input"], responses_api_request={"instructions": payload["instructions"]} if payload.get("instructions") else {})
    count = litellm.token_counter(model=upstream_model, messages=messages, tools=payload.get("tools"))
    if type(count) is not int or count < 0:
        raise ValueError("model_gateway_context_count_unavailable")
    return count
