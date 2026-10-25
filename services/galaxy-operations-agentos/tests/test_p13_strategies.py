"""Real Agno Workflow/queue/PostgreSQL; explicit Galaxy HTTP authority/effect double.

No provider call. The Node/PGlite group covers the actual Galaxy domain effects.
"""
import tempfile
import time
import unittest
import os
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import jwt
from fastapi.testclient import TestClient
from agno.db.sqlite import SqliteDb
from agno.db.postgres import PostgresDb
from sqlalchemy import create_engine, text

from galaxy_agentos.app import create_app
from galaxy_agentos.config import Settings
from galaxy_agentos.gateway import AuthorityDenied
from galaxy_agentos.p13_strategies import WORKFLOW_ID, publish_fixed_p13_definition


class LocalGalaxyContract:
    def __init__(self):
        self.rows, self.effects, self.revoked = {}, {}, set()

    def add(self, route="code", mode="code-automatic"):
        ident, execution = str(uuid4()), str(uuid4())
        self.rows[ident] = {"runId": ident, "executionId": execution, "sessionId": str(uuid4()),
            "nativeRunId": None, "workflow": {"id": WORKFLOW_ID, "version": 1}, "route": route,
            "mode": mode, "judgment": "semantic" if route == "ai" else "prepared-command",
            "state": "prepared", "decision": None, "approved": False,
            "sourceRef": {"kind": "post", "id": str(uuid4()), "version": 1},
            "instructions": "判断已选合成公开材料，普通缺输入时请求补充"}
        return self.rows[ident]

    def authorize(self, user_id, **kwargs):
        execution = user_id.removeprefix("execution:")
        if execution in self.revoked or not any(row["executionId"] == execution for row in self.rows.values()):
            raise AuthorityDenied()
        return {"allowed": True, "resourceIds": [WORKFLOW_ID], "execution": {
            "id": execution, "domain": "governance", "sessionId": "unused-by-p13",
            "resourceIds": [], "actions": ["content.read", "content.hide"]}}

    def request(self, path, data):
        row = self.rows.get(data.get("runId"))
        if not row or row["executionId"] != data.get("executionId"):
            raise AuthorityDenied()
        self.authorize("execution:" + row["executionId"])
        if path == "p13/context":
            return dict(row)
        if path != "p13/step":
            raise AuthorityDenied()
        native_id = data["nativeRunId"]
        if row["nativeRunId"] not in {None, native_id}:
            raise AuthorityDenied()
        row["nativeRunId"] = native_id
        phase = data["phase"]
        if phase == "prepare":
            return {**row, "requiresHuman": row["route"] == "human" or row["decision"] == "human-required",
                "requiresInput": row["decision"] == "needs-input"}
        if phase == "decision":
            row["decision"] = data["decision"]
            return {"decision": row["decision"], "requiresInput": row["decision"] == "needs-input",
                "requiresHuman": row["decision"] == "human-required"}
        if phase == "finished":
            return {"state": "no-action"}
        if phase != "effect" or (row["route"] == "human" or row["decision"] == "needs-input") and not row["approved"]:
            raise AuthorityDenied()
        self.effects.setdefault(row["runId"], {"state": "completed", "operationId": row["runId"]})
        return self.effects[row["runId"]]

    def tool(self, user_id, tool, arguments, **kwargs):
        self.authorize(user_id)
        if tool != "read-selected-content":
            raise AuthorityDenied()
        return {"kind": arguments["kind"], "id": arguments["id"], "version": 1,
            "sourceState": "available", "body": "SYNTHETIC_CURRENT_PUBLIC_ONLY"}


class P13NativeTest(unittest.TestCase):
    def setUp(self):
        self.dsn = os.environ.get("GALAXY_AGENTOS_TEST_DATABASE_URL")
        self.schema = os.environ.get("GALAXY_P13_CHECK_SCHEMA")
        if self.dsn:
            if self.schema != "galaxy_p13_check_20261023":
                raise RuntimeError("p13_check_schema_not_authorized")
            engine = create_engine(self.dsn)
            def reset_schema():
                with engine.begin() as connection:
                    connection.execute(text('DROP SCHEMA IF EXISTS "galaxy_p13_check_20261023" CASCADE'))
            reset_schema()
            self.addCleanup(engine.dispose)
            self.addCleanup(reset_schema)
        self.directory = tempfile.TemporaryDirectory(prefix="galaxy-p13-native-")
        self.addCleanup(self.directory.cleanup)
        self.filename = str(Path(self.directory.name) / "agno.db")
        self.gateway = LocalGalaxyContract()
        self.settings = Settings(database_url="postgresql+psycopg://unused-local-contract", authority_url="http://127.0.0.1:1/v1/internal/agentos/",
            service_key="synthetic-p13-service-not-a-real-secret", verification_key="synthetic-p13-signing-not-a-real-secret")

    def app(self, **kwargs):
        db = PostgresDb(db_url=self.dsn, db_schema=self.schema) if self.dsn else SqliteDb(db_file=self.filename)
        self.addCleanup(db.db_engine.dispose)
        return create_app(self.settings, gateway=self.gateway, db=db, tracing=False, **kwargs)

    def headers(self, row):
        now = int(time.time())
        token = jwt.encode({"sub": "execution:" + row["executionId"], "iat": now, "exp": now + 60,
            "iss": self.settings.issuer, "aud": self.settings.audience}, self.settings.verification_key, algorithm="HS256")
        return {"Authorization": "Bearer " + token}

    def wait(self, client, row, status):
        deadline, last = time.monotonic() + 10, None
        while time.monotonic() < deadline:
            response = client.get("/galaxy/p13-strategies/" + row["runId"], headers=self.headers(row))
            self.assertEqual(response.status_code, 200, response.text)
            last = response.json()
            if last.get("status") == status:
                return last
            if last.get("status") == "ERROR":
                stored = client.app.state.galaxy_runtime["db"].get_run(run_id=last["runId"], deserialize=False)
                self.fail("native run error: " + repr(stored.get("run_data", {}).get("content")))
            time.sleep(0.03)
        self.fail("native status deadline: " + repr(last))

    def start(self, client, row):
        response = client.post("/galaxy/p13-strategies/" + row["runId"] + "/start", data={"session_id": row["sessionId"]}, headers=self.headers(row))
        self.assertIn(response.status_code, {200, 202}, response.text)
        return response

    def test_code_queue_and_native_human_pause_survive_restart_without_new_authority(self):
        row = self.gateway.add()
        with TestClient(self.app()) as client:
            self.assertEqual(client.get("/health").json()["model"], "not-configured")
            self.start(client, row)
            result = self.wait(client, row, "COMPLETED")
            self.assertEqual(len(self.gateway.effects), 1)
            self.assertTrue(result["steps"])
            self.start(client, row)
            self.assertEqual(len(self.gateway.effects), 1)
            db = client.app.state.galaxy_runtime["db"]
            worker = client.app.state.queue_worker
            self.assertIsNotNone(client.portal.call(worker.store.get_job, result["runId"]), "native durable ticket exists")
            publish_fixed_p13_definition(db, client.app.state.galaxy_runtime["strategyWorkflow"])
        human = self.gateway.add("human", "human-led")
        with TestClient(self.app()) as client:
            self.start(client, human)
            paused = self.wait(client, human, "PAUSED")
            self.assertEqual(paused["pauseKind"], "confirmation")
            self.assertNotIn(human["runId"], self.gateway.effects)
        with TestClient(self.app()) as client:
            self.assertEqual(self.wait(client, human, "PAUSED")["runId"], paused["runId"])
            self.gateway.revoked.add(human["executionId"])
            response = client.post("/galaxy/p13-strategies/" + human["runId"] + "/continue", data={"session_id": human["sessionId"], "confirmed": "true"}, headers=self.headers(human))
            self.assertEqual(response.status_code, 403)
            self.gateway.revoked.remove(human["executionId"])
            human["approved"] = True  # Explicit Node-current-human contract double.
            response = client.post("/galaxy/p13-strategies/" + human["runId"] + "/continue", data={"session_id": human["sessionId"], "confirmed": "true"}, headers=self.headers(human))
            self.assertIn(response.status_code, {200, 202}, response.text)
            self.wait(client, human, "COMPLETED")
            self.assertEqual(len(self.gateway.effects), 2)

    def test_semantic_model_empty_is_not_accepted_and_native_input_pause_has_closed_continuation(self):
        row = self.gateway.add("ai", "ai-human-participation")
        with TestClient(self.app()) as client:
            response = client.post("/galaxy/p13-strategies/" + row["runId"] + "/start", data={"session_id": row["sessionId"]}, headers=self.headers(row))
            self.assertEqual(response.status_code, 503)
            self.assertIsNone(row["nativeRunId"])
            self.assertEqual(self.gateway.effects, {})
        class ExplicitAnalyst:
            def run(self, *args, **kwargs):
                return SimpleNamespace(content={"decision": "needs-input"})
        with TestClient(self.app(p13_analyst_factory=ExplicitAnalyst)) as client:
            self.start(client, row)
            paused = self.wait(client, row, "PAUSED")
            self.assertEqual(paused["pauseKind"], "input")
            self.assertEqual(self.gateway.effects, {})
            response = client.post("/galaxy/p13-strategies/" + row["runId"] + "/continue", data={"session_id": row["sessionId"], "input_decision": "arbitrary-code"}, headers=self.headers(row))
            self.assertEqual(response.status_code, 400)
            row["decision"], row["approved"] = "proceed", True
            response = client.post("/galaxy/p13-strategies/" + row["runId"] + "/continue", data={"session_id": row["sessionId"], "input_decision": "proceed"}, headers=self.headers(row))
            self.assertIn(response.status_code, {200, 202}, response.text)
            self.wait(client, row, "COMPLETED")
            self.assertEqual(len(self.gateway.effects), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
