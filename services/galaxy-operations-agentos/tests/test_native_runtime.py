import json
import tempfile
import time
import unittest
from os import environ
from dataclasses import dataclass, field
from pathlib import Path
from uuid import uuid4

import jwt
from fastapi.testclient import TestClient
from agno.models.base import Model
from agno.models.response import ModelResponse

from galaxy_agentos.app import create_app
from galaxy_agentos.config import Settings
from galaxy_agentos.gateway import AuthorityDenied
from galaxy_agentos.read_model import run_detail


class SyntheticAuthority:
    """Explicit synthetic transport/authority; real PG is tested in Node."""
    def __init__(self):
        self.rows, self.revoked, self.effects, self.reads = {}, set(), {}, []

    def add(self, domain="governance", prepared=False):
        ident = str(uuid4())
        self.rows[ident] = {"id": ident, "domain": domain, "sessionId": str(uuid4()),
            "resourceIds": [str(uuid4())], "actions": ["content.read"], "hasPreparedCommand": prepared}
        return self.rows[ident]

    def authorize(self, user_id, **kwargs):
        ident = user_id.removeprefix("execution:") if isinstance(user_id, str) else ""
        if ident not in self.rows or ident in self.revoked:
            raise AuthorityDenied("synthetic_authority_revoked")
        row = self.rows[ident]
        component = kwargs.get("resource_id")
        if component and component not in {"galaxy-" + row["domain"], "galaxy-prepared-review"}:
            raise AuthorityDenied("synthetic_domain_denied")
        return {"allowed": True, "execution": row,
            "resourceIds": ["galaxy-" + row["domain"], "galaxy-prepared-review"]}

    def tool(self, user_id, tool, arguments, *, run_id, call_id):
        row = self.authorize(user_id)["execution"]
        if tool == "read-selected-content":
            if arguments["id"] not in row["resourceIds"]:
                raise AuthorityDenied()
            self.reads.append((row["id"], run_id))
            return {"id": arguments["id"], "body": "SYNTHETIC_PUBLIC_SOURCE_TEXT"}
        if tool != "execute-prepared-command" or arguments:
            raise AuthorityDenied()
        self.effects.setdefault((row["id"], run_id, call_id), {"applied": True})
        return self.effects[(row["id"], run_id, call_id)]


@dataclass
class ScriptedModel(Model):
    id: str = "explicit-synthetic-model"
    name: str = "SyntheticNativeModel"
    provider: str = "SyntheticLocalOnly"
    target: str = ""
    calls: int = 0

    def invoke(self, *args, **kwargs):
        self.calls += 1
        if self.calls == 1:
            return ModelResponse(role="assistant", tool_calls=[{"id": "synthetic-read", "type": "function",
                "function": {"name": "read_selected_content", "arguments": json.dumps({"target_kind": "post", "target_id": self.target})}}])
        return ModelResponse(role="assistant", content="SYNTHETIC_ASSISTANT_RESULT")

    async def ainvoke(self, *args, **kwargs):
        return self.invoke(*args, **kwargs)

    def invoke_stream(self, *args, **kwargs):
        yield self.invoke(*args, **kwargs)

    async def ainvoke_stream(self, *args, **kwargs):
        yield self.invoke(*args, **kwargs)

    def _parse_provider_response(self, response, **kwargs):
        return response

    def _parse_provider_response_delta(self, response):
        return response


class NativeRuntimeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        dsn = environ.get("GALAXY_AGENTOS_TEST_DATABASE_URL") or environ.get("GALAXY_AGENTOS_DATABASE_URL")
        if not dsn:
            raise RuntimeError("Native durable checks require the explicitly injected PostgreSQL DSN")
        cls.settings = Settings(database_url=dsn, database_schema=environ.get("GALAXY_AGENTOS_TEST_SCHEMA", "galaxy_agentos_native_check"),
            authority_url="http://127.0.0.1:1/v1/internal/agentos/",
            service_key="synthetic-service-key-not-a-production-secret",
            verification_key="synthetic-signing-key-not-a-production-secret")
        cls.gateway = SyntheticAuthority()
        cls.tracing = True

    def app(self, **kwargs):
        result = create_app(self.settings, gateway=self.gateway, tracing=type(self).tracing, **kwargs)
        type(self).tracing = False
        return result

    def headers(self, row):
        now = int(time.time())
        token = jwt.encode({"sub": "execution:" + row["id"], "iat": now, "exp": now + 60,
            "iss": self.settings.issuer, "aud": self.settings.audience,
            "scopes": ["agent_os:admin"]}, self.settings.verification_key, algorithm="HS256")
        return {"Authorization": "Bearer " + token}

    def wait_run(self, client, row, run_id, expected):
        deadline = time.monotonic() + 8
        last = None
        while time.monotonic() < deadline:
            response = client.get("/galaxy/executions/" + row["id"], headers=self.headers(row))
            self.assertEqual(response.status_code, 200, response.text)
            last = next((r for r in response.json()["runs"] if r["runId"] == run_id), None)
            if last and last["status"] in expected:
                return last
            time.sleep(0.05)
        self.fail("native run did not reach expected status: " + repr(last))

    def test_01_model_empty_and_native_auth_boundary(self):
        row = self.gateway.add()
        app = self.app()
        self.assertEqual(app.state.galaxy_runtime["agents"], [])
        with TestClient(app) as client:
            state = client.get("/health").json()
            self.assertEqual(state["model"], "not-configured")
            self.assertEqual(state["queue"], "native-durable")
            response = client.post("/agents/galaxy-governance/runs", data={"message": "no model call"}, headers=self.headers(row))
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json()["error"], "agentos_model_not_configured")
            self.assertEqual(client.get("/config", headers=self.headers(row)).status_code, 403)
            self.assertEqual(client.post("/workflows/galaxy-prepared-review/runs", data={"message": "x", "client_tools": "[]"}, headers=self.headers(row)).status_code, 403)
            self.assertEqual(client.post("/workflows/galaxy-prepared-review/runs", data={"message": "x", "session_id": str(uuid4())}, headers=self.headers(row)).status_code, 403)
            self.gateway.revoked.add(row["id"])
            self.assertEqual(client.get("/galaxy/executions/" + row["id"], headers=self.headers(row)).status_code, 403)
            self.assertEqual(self.gateway.effects, {})

    def test_02_native_durable_pause_restart_continue_and_revoke(self):
        row = self.gateway.add(prepared=True)
        operation_id = str(uuid4())
        with TestClient(self.app()) as client:
            response = client.post("/workflows/galaxy-prepared-review/runs", data={"message": "synthetic prepared task", "stream": "false",
                "background": "true", "session_id": row["sessionId"] + ":review"}, headers={**self.headers(row), "Idempotency-Key": operation_id})
            self.assertIn(response.status_code, {200, 202}, response.text)
            run_id = response.json()["run_id"]
            self.wait_run(client, row, run_id, {"PAUSED"})
        # A fresh AgentOS instance reads the same native store and queue ticket.
        with TestClient(self.app()) as client:
            self.assertTrue(self.wait_run(client, row, run_id, {"PAUSED"})["awaitingHuman"])
            self.gateway.revoked.add(row["id"])
            response = client.post("/galaxy/executions/" + row["id"] + "/continue", data={"run_id": run_id, "confirmed": "true"}, headers=self.headers(row))
            self.assertEqual(response.status_code, 403)
            self.assertEqual(len(self.gateway.effects), 0)
            self.gateway.revoked.remove(row["id"])
            response = client.post("/galaxy/executions/" + row["id"] + "/continue", data={"run_id": run_id, "confirmed": "true"}, headers=self.headers(row))
            self.assertIn(response.status_code, {200, 202}, response.text)
            self.wait_run(client, row, run_id, {"COMPLETED"})
            response = client.post("/galaxy/executions/" + row["id"] + "/continue", data={"run_id": run_id, "confirmed": "true"}, headers=self.headers(row))
            self.assertEqual(response.status_code, 409)
            self.assertEqual(len(self.gateway.effects), 1)

    def test_03_native_agent_tools_events_trace_and_global_metadata(self):
        row = self.gateway.add()
        operation_id = str(uuid4())
        with TestClient(self.app(model_factory=lambda: ScriptedModel(target=row["resourceIds"][0]))) as client:
            response = client.post("/agents/galaxy-governance/runs", data={"message": "SYNTHETIC_PRIVATE_WORKBENCH_PROMPT", "stream": "false",
                "background": "true", "session_id": row["sessionId"]}, headers={**self.headers(row), "Idempotency-Key": operation_id})
            self.assertIn(response.status_code, {200, 202}, response.text)
            run_id = response.json()["run_id"]
            result = self.wait_run(client, row, run_id, {"COMPLETED", "ERROR"})
            self.assertEqual(result["status"], "COMPLETED")
            self.assertEqual(result["content"], "SYNTHETIC_ASSISTANT_RESULT")
            self.assertIn((row["id"], run_id), self.gateway.reads)
            private_headers = {"Authorization": "Bearer " + self.settings.service_key}
            global_page = client.get("/galaxy/runs?domain=governance&limit=100&page=1", headers=private_headers)
            self.assertEqual(global_page.status_code, 200, global_page.text)
            self.assertGreaterEqual(global_page.json()["total"], 2)
            response = client.get("/galaxy/runs/" + run_id, headers=private_headers)
            self.assertEqual(response.status_code, 200, response.text)
            detail = response.json()
            self.assertEqual(detail["run"]["promptVersion"], "galaxy-operations-v1")
            self.assertGreater(len(detail["spans"]), 0)
            text = json.dumps(detail)
            for forbidden in ["SYNTHETIC_PRIVATE_WORKBENCH_PROMPT", "SYNTHETIC_ASSISTANT_RESULT", "SYNTHETIC_PUBLIC_SOURCE_TEXT", self.settings.service_key]:
                self.assertNotIn(forbidden, text)
            self.assertTrue(all(span["input"]["state"] == "not-recorded" and span["output"]["state"] == "not-recorded" for span in detail["spans"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
