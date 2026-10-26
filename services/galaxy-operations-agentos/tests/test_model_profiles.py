"""New P20 native serialization only. No provider or model is contacted."""
import json
from pathlib import Path
import tempfile
import unittest

from agno.models.message import Message
from agno.models.openai.like import OpenAILike
from agno.models.openai.responses import OpenAIResponses
from galaxy_agentos.model_profiles import load_runtime_profile, native_model
from galaxy_agentos.model_settings import DOMAINS, load_bindings


class ModelProfilesTest(unittest.TestCase):
    def test_native_adapters_serialize_human_limits_and_reasoning_without_sampling_or_fallback(self):
        for api_format in ("openai-chat", "openai-responses", "anthropic", "gemini"):
            raw = {"apiFormat": api_format, "contextWindow": 8192, "maxOutputTokens": 256,
                "reasoningEffort": "medium", "timeoutSeconds": 45, "toolCalling": True, "structuredOutput": True}
            profile = load_runtime_profile(raw)
            model = native_model(profile, alias="galaxy-m00000000000040008000000000000001", base_url="http://127.0.0.1:9/v1",
                api_key="SYNTHETIC_PRIVATE_SERVICE_KEY_NOT_CONNECTED", headers={"X-Galaxy-Model-Config-Version": "fixture-v2"})
            self.assertIsInstance(model, OpenAIResponses if api_format == "openai-responses" else OpenAILike)
            self.assertEqual((model.max_retries, model.retries, model.retry_with_guidance, model.store), (0, 0, False, False))
            params = (model.get_request_params(messages=[Message(role="user", content="fixture")])
                if api_format == "openai-responses" else model.get_request_params())
            self.assertNotIn("temperature", params)
            self.assertNotIn("top_p", params)
            if api_format == "openai-responses":
                self.assertEqual(params["max_output_tokens"], 256)
                self.assertEqual(params["reasoning"], {"effort": "medium"})
                self.assertFalse(model.use_previous_response_id)
                self.assertEqual(params["truncation"], "disabled")
                self.assertIn("reasoning.encrypted_content", params["include"])
            else:
                self.assertEqual(params["max_tokens"], 256)
                self.assertEqual(params["reasoning_effort"], "medium")
            self.assertEqual(model.timeout, 45)
            scenes = {domain: None for domain in DOMAINS}
            scenes["governance"] = {"alias": model.id, "dataPolicyApproved": True, "runtimeProfile": raw}
            with tempfile.TemporaryDirectory() as directory:
                file = Path(directory) / "binding.json"
                file.write_text(json.dumps({"version": "fixture-v2", "scenarios": scenes}))
                version, bindings = load_bindings(file)
                self.assertEqual(version, "fixture-v2")
                self.assertEqual(bindings["governance"].runtime_profile.view(), raw)
        for changed in ({"apiFormat": "gemini", "reasoningEffort": "max"},
                {"contextWindow": 256}, {"apiFormat": "openai-responses", "maxOutputTokens": 8}):
            with self.assertRaises(ValueError): load_runtime_profile({**raw, **changed})


if __name__ == "__main__": unittest.main()
