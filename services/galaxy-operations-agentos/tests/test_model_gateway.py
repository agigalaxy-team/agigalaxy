import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

import httpx
from galaxy_agentos.config import Settings
from galaxy_agentos.gateway import AuthorityDenied
from galaxy_agentos.model_settings import DOMAINS, configured_domains, domain_model, model_settings_view, require_registered_alias


class ModelGatewayTest(unittest.TestCase):
    def test_human_scene_binding_empty_has_no_fallback_and_configured_alias_is_explicit(self):
        base = {"database_url": "postgresql+psycopg://synthetic-not-connected/unused", "authority_url": "http://127.0.0.1:9",
            "service_key": "synthetic-agentos-service-key-0000000000", "verification_key": "synthetic-agentos-verification-0000000000"}
        with patch.dict("os.environ", {"GALAXY_AGENTOS_DATABASE_URL": base["database_url"], "GALAXY_AGENTOS_AUTHORITY_URL": base["authority_url"],
                "GALAXY_AGENTOS_SERVICE_KEY": base["service_key"], "GALAXY_AGENTOS_VERIFICATION_KEY": base["verification_key"],
                "OPENAI_API_KEY": "SYNTHETIC_AMBIENT_KEY_NOT_USED", "LITELLM_API_KEY": "SYNTHETIC_AMBIENT_KEY_NOT_USED"}, clear=True):
            empty = Settings.from_env()
            self.assertFalse(empty.model_configured)
            self.assertEqual(configured_domains(empty), frozenset())
            self.assertTrue(all(row["state"] == "not-configured" and row["alias"] is None for row in model_settings_view(empty)["scenarios"]))
            for domain in DOMAINS:
                with self.assertRaisesRegex(AuthorityDenied, "model_not_configured"):
                    domain_model(empty, domain, object())
        with self.assertRaisesRegex(ValueError, "direct_provider_configuration_unsupported"):
            Settings(**base, model_id="implicit-provider-model")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bindings.json"
            scenes = {domain: None for domain in DOMAINS}
            scenes["governance"] = {"alias": "galaxy-manual-test", "dataPolicyApproved": True, "parameters": {"temperature": 0.2}}
            path.write_text(json.dumps({"version": "test-v3", "scenarios": scenes}))
            configured = Settings(**base, model_gateway_url="http://127.0.0.1:3351", model_gateway_key="synthetic-gateway-key-000000000000000000", model_bindings_file=str(path))
            self.assertEqual(configured_domains(configured), {"governance"})
            current = SimpleNamespace(context=SimpleNamespace(principal_id="execution:synthetic-local-only"))
            gateway = SimpleNamespace(authorize=lambda *args, **kwargs: {"execution": {"domain": "maintenance"}})
            model = domain_model(configured, "governance", gateway)
            from agno.models.openai.like import OpenAILike
            self.assertIsInstance(model, OpenAILike)
            self.assertEqual(model.provider, "LiteLLM")
            self.assertEqual((model.id, model.base_url, model.api_key, model.max_retries, model.store),
                ("galaxy-manual-test", "http://127.0.0.1:3351/v1", configured.model_gateway_key, 0, False))
            self.assertEqual(model.default_headers["X-Galaxy-Model-Scenario"], "governance")
            with patch("galaxy_agentos.model_gate.current_authorization", return_value=current):
                # Domain mismatch fails before catalog or a model request.
                with self.assertRaisesRegex(AuthorityDenied, "scenario_denied"): model.invoke()
            requested = []
            def catalog(request):
                requested.append(request)
                self.assertEqual((request.method, request.url.path), ("GET", "/v1/models"))
                self.assertEqual(request.headers["Authorization"], "Bearer " + configured.model_gateway_key)
                return httpx.Response(200, headers={"X-Galaxy-Model-Config-Version": "test-v3"}, json={"object": "list", "data": [{"id": "galaxy-manual-test"}]})
            require_registered_alias(configured, model.id, transport=httpx.MockTransport(catalog))
            for result in [httpx.Response(200, headers={"X-Galaxy-Model-Config-Version": "old-v2"}, json={"data": [{"id": model.id}]}),
                    httpx.Response(200, headers={"X-Galaxy-Model-Config-Version": "test-v3"}, json={"data": []}), httpx.Response(401)]:
                with self.assertRaisesRegex(AuthorityDenied, "unavailable_or_unassigned"):
                    require_registered_alias(configured, model.id, transport=httpx.MockTransport(lambda request: result))
            self.assertEqual(len(requested), 1)
            self.assertNotIn(configured.model_gateway_key, json.dumps(model_settings_view(configured)))
            # An unapproved scene still cannot construct any provider model.
            scenes["governance"]["dataPolicyApproved"] = False
            path.write_text(json.dumps({"version": "test-v4", "scenarios": scenes}))
            unapproved = Settings(**base, model_gateway_url=configured.model_gateway_url, model_gateway_key=configured.model_gateway_key, model_bindings_file=str(path))
            self.assertFalse(unapproved.model_configured)
            with self.assertRaisesRegex(AuthorityDenied, "model_not_configured"): domain_model(unapproved, "governance", gateway)


if __name__ == "__main__": unittest.main()
