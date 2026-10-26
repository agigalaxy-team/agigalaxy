"""New workbench failure/metrics contracts; no provider calls or live secrets."""
import json
import time
import unittest
from uuid import uuid4

import httpx
import jwt
from fastapi import FastAPI
from fastapi.testclient import TestClient
from agno.metrics import RunMetrics, ModelMetrics
from agno.run.agent import RunOutput, RunErrorEvent
from agno.run.base import RunStatus
from agno.utils.events import error_type_of

from galaxy_agentos.app import PrivateSurface, run_view
from galaxy_agentos.config import Settings
from galaxy_agentos.gateway import GalaxyGateway, AuthorityUnavailable, AuthorityDenied


class WorkbenchLiveContracts(unittest.TestCase):
    def test_authority_outage_is_not_reported_as_revocation_and_response_never_carries_upstream_prose(self):
        settings = Settings(database_url="postgresql+psycopg://unused.invalid/no-connection",
            authority_url="http://127.0.0.1:1/v1/internal/agentos/",
            service_key="synthetic-only-service-key-no-production",
            verification_key="synthetic-only-signing-key-no-production")
        ident = str(uuid4())
        row = {"id": ident, "domain": "overview", "mode": "conversation", "sessionId": str(uuid4())}
        upstream = {"status": 200, "invalid": False, "offline": False}
        calls = []
        def handler(request):
            calls.append(json.loads(request.content))
            if upstream["offline"]:
                raise httpx.ConnectError("PRIVATE_UPSTREAM_URL_OR_SECRET", request=request)
            if upstream["invalid"]:
                return httpx.Response(200, content="PRIVATE_UPSTREAM_BAD_RESPONSE")
            return httpx.Response(upstream["status"], json={"allowed": True, "execution": row,
                "error": "PRIVATE_UPSTREAM_ERROR_PROSE"})
        gateway = GalaxyGateway(settings, transport=httpx.MockTransport(handler))
        self.addCleanup(gateway.close)
        app = FastAPI()
        @app.get("/galaxy/conversations/{conversation_id}")
        async def existing_history(conversation_id):
            return {"conversationId": conversation_id, "runs": []}
        app.add_middleware(PrivateSurface, settings=settings, runtime={"gateway": gateway})
        now = int(time.time())
        token = jwt.encode({"sub": "conversation:" + ident, "iat": now, "exp": now + 60,
            "aud": settings.audience, "iss": settings.issuer}, settings.verification_key, algorithm="HS256")
        with TestClient(app) as client:
            for status, expected, code in [(200, 200, None), (503, 503, "agentos_authority_unavailable"),
                    (429, 503, "agentos_authority_unavailable"), (403, 403, "agentos_current_authority_denied")]:
                upstream["status"] = status
                response = client.get("/galaxy/conversations/" + ident, headers={"Authorization": "Bearer " + token})
                self.assertEqual(response.status_code, expected)
                if code:
                    self.assertEqual(response.json(), {"error": code})
                self.assertNotIn("PRIVATE_", response.text)
            for field in ("invalid", "offline"):
                upstream["status"] = 200
                upstream[field] = True
                response = client.get("/galaxy/conversations/" + ident, headers={"Authorization": "Bearer " + token})
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json(), {"error": "agentos_authority_unavailable"})
                upstream[field] = False
        self.assertTrue(all(value["conversationId"] == ident and value["operation"] == "read" for value in calls))

    def test_actual_agno_serialized_metrics_and_error_events_have_only_reported_usage_and_closed_error_projection(self):
        metric = RunMetrics(input_tokens=11, output_tokens=7, total_tokens=18, duration=1.25,
            details={"model": [ModelMetrics(id="synthetic-alias", provider="local-test",
                input_tokens=11, output_tokens=7, total_tokens=18)]})
        stored = RunOutput(run_id=str(uuid4()), status=RunStatus.completed,
            content="synthetic reply", metrics=metric,
            metadata={"operationId": str(uuid4()), "domain": "overview"}).to_dict()
        restored = RunOutput.from_dict(stored)
        view = run_view(restored)
        self.assertEqual(view["metrics"], {"inputTokens": 11, "outputTokens": 7,
            "totalTokens": 18, "durationMs": 1250})
        self.assertIsNone(view["errorCode"])
        for empty in [None, RunMetrics(), RunMetrics(details={"model": [ModelMetrics(id="local")]})]:
            restored.metrics = empty
            self.assertEqual(run_view(restored)["metrics"], {"inputTokens": None,
                "outputTokens": None, "totalTokens": None, "durationMs": None})
        for failure, code in [(AuthorityUnavailable(), "operations_authorization_unavailable"),
                (AuthorityDenied(), "operations_agentos_authority_changed"),
                (RuntimeError("PRIVATE_PROVIDER_BODY"), "operations_agentos_run_failed")]:
            restored.status = RunStatus.error
            restored.content = "PRIVATE_PROVIDER_BODY"
            restored.events = [RunErrorEvent(run_id=restored.run_id,
                content="PRIVATE_PROVIDER_BODY", error_type=error_type_of(failure))]
            view = run_view(restored)
            self.assertIsNone(view["content"])
            self.assertEqual(view["errorCode"], code)
            self.assertNotIn("PRIVATE_PROVIDER_BODY", json.dumps(view))


if __name__ == "__main__":
    unittest.main(verbosity=2)
