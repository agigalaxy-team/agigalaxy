"""One actual Agno3.1.7/PostgreSQL continuation leaf, no provider request.

Only the dedicated check schema is used. Galaxy authority/effects are explicit
contracts; the companion Node leaf covers the real current PG authority.
"""
from concurrent.futures import ThreadPoolExecutor
import os
import time
import unittest
from uuid import uuid4

import jwt
from agno.db.postgres import PostgresDb
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, text

from galaxy_agentos.app import create_app
from galaxy_agentos.config import Settings
from galaxy_agentos.gateway import AuthorityDenied
from test_p13_strategies import LocalGalaxyContract


SCHEMA = "galaxy_p13_continuation_check_20261023"


class CurrentGalaxy(LocalGalaxyContract):
    def __init__(self):
        super().__init__()
        self.commands, self.effect_calls = {}, 0

    def request(self, path, data):
        result = super().request(path, data)
        if path == "p13/context" and data.get("continuationOperationId"):
            value = self.commands.get(data["continuationOperationId"])
            if not value or value["runId"] != data["runId"]:
                raise AuthorityDenied()
            return {**result, "continuation": value}
        if path == "p13/step" and data.get("phase") == "effect":
            self.effect_calls += 1
        return result


class NativeContinuationTest(unittest.TestCase):
    def test_original_receipt_and_native_queue_cas_commit_together_and_survive_lost_ack_restart(self):
        dsn = os.environ.get("GALAXY_AGENTOS_TEST_DATABASE_URL")
        if not dsn or os.environ.get("GALAXY_P13_CHECK_SCHEMA") != SCHEMA:
            self.fail("dedicated PostgreSQL check schema is required; SQLite is not durable-queue evidence")
        engine = create_engine(dsn)
        self.addCleanup(engine.dispose)
        def clean():
            with engine.begin() as connection:
                connection.execute(text('DROP SCHEMA IF EXISTS "' + SCHEMA + '" CASCADE'))
        clean()
        self.addCleanup(clean)
        gateway = CurrentGalaxy()
        settings = Settings(database_url="postgresql+psycopg://unused-contract",
            authority_url="http://127.0.0.1:1/v1/internal/agentos/", service_key="synthetic-p13-service-only-not-a-real-secret",
            verification_key="synthetic-p13-signing-only-not-a-real-secret")
        def app():
            db = PostgresDb(db_url=dsn, db_schema=SCHEMA)
            self.addCleanup(db.db_engine.dispose)
            return create_app(settings, gateway=gateway, db=db, tracing=False)
        def headers(row, operation=None):
            now = int(time.time())
            token = jwt.encode({"sub": "execution:" + row["executionId"], "iat": now, "exp": now + 120,
                "iss": settings.issuer, "aud": settings.audience}, settings.verification_key, algorithm="HS256")
            return {"Authorization": "Bearer " + token, **({"Idempotency-Key": operation} if operation else {})}
        row = gateway.add("human", "human-led")
        root = "/galaxy/p13-strategies/" + row["runId"]
        def wait(client, wanted, ticket=None):
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                r = client.get(root, headers=headers(row))
                self.assertEqual(r.status_code, 200, r.text)
                job = client.app.state.galaxy_runtime["db"].get_job(r.json().get("runId") or "none", strict=True)
                if r.json()["status"] == wanted and (ticket is None or job and job["status"] == ticket):
                    return r.json(), job
                time.sleep(.03)
            self.fail("native continuation status deadline: " + r.text)
        with TestClient(app(), raise_server_exceptions=False) as client:
            started = client.post(root + "/start", data={"session_id": row["sessionId"]}, headers=headers(row))
            self.assertIn(started.status_code, {200, 202}, started.text)
            paused, job = wait(client, "PAUSED", "paused")
            attempt = job["attempt"]
            self.assertRegex(paused["pauseId"] or "", r"^[a-f0-9-]{36}:0$")
            operation = str(uuid4())
            gateway.commands[operation] = {"operationId": operation, "runId": row["runId"],
                "nativeRunId": paused["runId"], "pauseId": paused["pauseId"], "confirmed": True}
            row["approved"] = True
            path = root + "/continuations/" + operation
            self.assertEqual(client.get(path, headers=headers(row)).json()["state"], "not-recorded")
            self.assertEqual(gateway.effect_calls, 0)
            db = client.app.state.galaxy_runtime["db"]
            self.assertTrue(getattr(client.app.state.queue_worker.store, "_store", None) is db,
                "native queue must use the runtime DB instance with the receipt seam")
            observed = []
            original_continue = db.continue_job
            def observe_continue(*args, **kwargs):
                from galaxy_agentos.p13_continuation import _current
                observed.append(_current.get() is not None)
                return original_continue(*args, **kwargs)
            db.continue_job = observe_continue
            fault = {"armed": True}
            def fail_receipt(connection, cursor, statement, parameters, context, executemany):
                values = parameters.values() if isinstance(parameters, dict) else parameters
                payloads = [getattr(value, "obj", value) for value in values]
                writing_receipt = any(isinstance(value, dict) and "galaxy_p13_continuations_v1" in value for value in payloads)
                if fault["armed"] and statement.lstrip().upper().startswith("UPDATE") and writing_receipt:
                    fault["armed"] = False
                    raise RuntimeError("synthetic_receipt_commit_failure")
            event.listen(db.db_engine, "before_cursor_execute", fail_receipt)
            rejected = client.post(root + "/continue", data={"session_id": row["sessionId"], "confirmed": "true"}, headers=headers(row, operation))
            self.assertEqual(observed, [True], "continuation context must reach the native queue CAS")
            self.assertGreaterEqual(rejected.status_code, 500)
            event.remove(db.db_engine, "before_cursor_execute", fail_receipt)
            self.assertFalse(fault["armed"], "failure happened between native CAS and receipt commit")
            unchanged = db.get_job(paused["runId"], strict=True)
            self.assertEqual(unchanged["status"], "paused")
            self.assertEqual(unchanged["attempt"], attempt)
            self.assertEqual(client.get(path, headers=headers(row)).json()["state"], "not-recorded")
            self.assertEqual(gateway.effect_calls, 0)
            def post_original():
                return client.post(root + "/continue", data={"session_id": row["sessionId"], "confirmed": "true"}, headers=headers(row, operation))
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: post_original(), range(2)))
            self.assertTrue(all(r.status_code in {200, 202} for r in results), [r.text for r in results])
            completed, completed_job = wait(client, "COMPLETED", "completed")
            self.assertEqual(completed_job["attempt"], attempt + 1)
            self.assertEqual(gateway.effect_calls, 1)
            self.assertEqual(len(completed_job["payload"]["galaxy_p13_continuations_v1"]), 1)
            self.assertEqual(client.get(path, headers=headers(row)).json()["state"], "accepted")
        # Discarding both HTTP acknowledgements above does not require a new
        # decision. A new application/process reads the same durable receipt.
        with TestClient(app()) as client:
            replay = client.get(path, headers=headers(row))
            self.assertEqual(replay.status_code, 200, replay.text)
            self.assertEqual(replay.json()["state"], "accepted")
            result = client.post(root + "/continue", data={"session_id": row["sessionId"], "confirmed": "true"}, headers=headers(row, operation))
            self.assertEqual(result.status_code, 200, result.text)
            conflict = client.post(root + "/continue", data={"session_id": row["sessionId"], "confirmed": "false"}, headers=headers(row, operation))
            self.assertEqual(conflict.status_code, 409)
            self.assertEqual(gateway.effect_calls, 1)
            self.assertEqual(client.app.state.galaxy_runtime["db"].get_job(paused["runId"], strict=True)["attempt"], attempt + 1)
            gateway.revoked.add(row["executionId"])
            self.assertEqual(client.get(path, headers=headers(row)).status_code, 403)
            self.assertEqual(gateway.effect_calls, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
