"""One native HTTP regression for the exact private model-settings route.

Use the actual AgentOS app/auth middleware plus Galaxy's outer service gate.
No TestClient lifespan is entered: this metadata-only request neither starts
the durable worker nor connects to a database, model, provider or network.
"""
import unittest
from uuid import uuid4

from agno.os.middleware.jwt import AuthMiddleware
from fastapi.testclient import TestClient

from galaxy_agentos.app import create_app
from galaxy_agentos.config import Settings


class ModelSettingsHttpTest(unittest.TestCase):
    def test_native_metadata_route_accepts_only_service_key_without_opening_business_routes(self):
        settings = Settings(database_url="postgresql+psycopg://synthetic-not-connected/unused",
            authority_url="http://127.0.0.1:9/v1/internal/agentos/",
            service_key="synthetic-agentos-service-key-for-metadata-only",
            verification_key="synthetic-agentos-verification-key-for-no-jwt-use",
            model_gateway_url="http://127.0.0.1:3351/v1",
            model_gateway_key="synthetic-gateway-service-key-not-a-provider-key")
        app = create_app(settings, tracing=False)
        self.assertTrue(any(issubclass(item.cls, AuthMiddleware) for item in app.user_middleware))
        self.assertEqual(app.state.galaxy_runtime["agents"], [])
        client = TestClient(app, raise_server_exceptions=False)
        headers = {"Authorization": "Bearer " + settings.service_key}
        try:
            response = client.get("/galaxy/model-settings", headers=headers)
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertEqual(body["version"], "unconfigured-v1")
            self.assertEqual((body["gatewayConfiguration"], body["gatewayAvailability"]), ("configured", "not-checked"))
            self.assertEqual({row["domain"] for row in body["scenarios"]},
                {"overview", "governance", "messaging", "discovery", "maintenance"})
            self.assertEqual(len(body["scenarios"]), 5)
            self.assertTrue(all(row["state"] == "not-configured" and row["alias"] is None and row["parameters"] == {}
                for row in body["scenarios"]))
            for key in (settings.service_key, settings.verification_key, settings.model_gateway_key):
                self.assertNotIn(key, response.text)
            for rejected in [{}, {"Authorization": "Bearer synthetic-wrong-service-key"},
                    {"Authorization": "Bearer " + settings.model_gateway_key}]:
                denied = client.get("/galaxy/model-settings", headers=rejected)
                self.assertEqual(denied.status_code, 403, denied.text)
                self.assertEqual(denied.json(), {"error": "agentos_current_authority_denied"})
            for path in ["/galaxy/model-settings?extra=1", "/galaxy/model-settings/", "/galaxy/model-settings/other",
                    "/sessions", "/galaxy/executions/" + str(uuid4())]:
                self.assertEqual(client.get(path, headers=headers).status_code, 403, path)
            for path in ["/galaxy/model-settings", "/agents/galaxy-governance/runs", "/workflows/galaxy-prepared-review/runs"]:
                self.assertEqual(client.post(path, headers=headers, data={"message": "SYNTHETIC_NO_MODEL_CALL"}).status_code, 403, path)
            self.assertEqual(client.get("/health").json()["model"], "not-configured")
        finally:
            client.close()


if __name__ == "__main__": unittest.main()
