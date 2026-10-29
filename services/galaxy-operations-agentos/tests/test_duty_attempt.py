import unittest
import asyncio
import tempfile
import time
from os import environ
from pathlib import Path
from uuid import uuid4
from types import SimpleNamespace

import jwt
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from agno.run.agent import RunOutput
from agno.run.base import RunStatus
from agno.agent import Agent
from agno.db.sqlite import SqliteDb
from agno.factory import RequestContext, TrustedContext
from agno.run.authorization import RunAuthorization, authorization_scope

from agno.os.authz.provider import AuthorizationContext
from galaxy_agentos.authorization import GalaxyAuthorization
from galaxy_agentos.duty_attempt import AttemptGateway
from galaxy_agentos.duty_storage import duty_report_fields, duty_storage_fields
from galaxy_agentos.duty_surface import duty_view, install_duty_routes
from galaxy_agentos.gateway import AuthorityDenied
from test_duties import CurrentTask, PrivateSurface, LocalModel, claims, settings
from galaxy_agentos.duties import duty_factory
from galaxy_agentos.app import create_app
from galaxy_agentos.config import Settings
from database_contract import test_database_target, verify_test_database_target


class AttemptTask(CurrentTask):
    def duty_authorize(self, user_id, *, operation="read", native_attempt_id=None):
        if native_attempt_id != self.task.get("nativeAttemptId"):
            raise AuthorityDenied("stale-attempt")
        return super().duty_authorize(user_id, operation=operation)

    def duty_tool(self, user_id, tool, arguments, **binding):
        self.duty_authorize(user_id, operation="tool", native_attempt_id=binding.get("native_attempt_id"))
        self.calls.append({"tool": tool, **binding})
        if tool == "assess-task":
            self.task["completion"] = {"disposition": "completed", "reasonCode": "task-goal-satisfied"}
        return {"state": "available"}

    def duty_report(self, user_id, value):
        self.duty_authorize(user_id, native_attempt_id=value.get("nativeAttemptId"))
        self.reports.append(value)
        return {"accepted": True}


class DutyAttempts(unittest.TestCase):
    def test_real_durable_queue_two_attempts_keep_distinct_sessions(self):
        target = verify_test_database_target(test_database_target(environ))
        selected = Settings(database_url=target.url, database_schema=target.schema,
            authority_url="http://127.0.0.1:1/v1/internal/agentos/",
            service_key="synthetic-service-key-not-a-production-secret",
            verification_key="synthetic-signing-key-not-a-production-secret")
        gateway = AttemptTask()
        task, user = gateway.task, "autonomy:" + gateway.task["taskId"]
        class FailedModel(LocalModel):
            def invoke(self, *args, **kwargs): raise RuntimeError("synthetic failure")
        def model(): return FailedModel() if task.get("nativeAttemptId") is None else LocalModel()
        app = create_app(selected, gateway=gateway, duty_model_factory=model, tracing=False)
        def headers(attempt):
            signed = claims(task, selected)
            if attempt is not None: signed["nativeAttemptId"] = attempt
            return {"Authorization": "Bearer " + jwt.encode(signed, selected.verification_key, algorithm="HS256"),
                "X-Galaxy-Service-Key": selected.service_key, "Idempotency-Key": attempt or task["taskId"]}
        path = "/galaxy/autonomy/tasks/" + task["taskId"]
        def terminal(client, header):
            for _ in range(200):
                value = client.get(path, headers=header)
                if value.status_code == 200 and value.json()["status"] in {"ERROR", "COMPLETED"}:
                    return value.json()
                time.sleep(.1)
            self.fail("native attempt did not finish")
        with TestClient(app) as client:
            first_header = headers(None)
            response = client.post(path + "/runs", headers=first_header, json={})
            self.assertIn(response.status_code, (200, 202), response.text)
            first = terminal(client, first_header)
            self.assertEqual(first["status"], "ERROR")
            old_session = task["sessionId"]
            attempt = task["nativeAttemptId"] = str(uuid4())
            task["sessionId"] = str(uuid4())
            next_header = headers(attempt)
            # Force the real pre-factory pending window while retaining the
            # actual durable queue and its original signed scope.
            client.portal.call(client.app.state.queue_worker.stop)
            response = client.post(path + "/runs", headers=next_header, json={})
            self.assertIn(response.status_code, (200, 202), response.text)
            pending = client.get(path, headers=next_header)
            self.assertEqual(pending.status_code, 200, pending.text)
            self.assertEqual((pending.json()["status"], pending.json()["nativeAttemptId"]), ("PENDING", attempt))
            client.portal.call(client.app.state.queue_worker.start)
            second = terminal(client, next_header)
            self.assertEqual(second["status"], "COMPLETED")
            self.assertEqual(second["nativeAttemptId"], attempt)
            self.assertEqual(second["sessionId"], task["sessionId"])
            self.assertNotEqual(first["nativeRunId"], second["nativeRunId"])
            self.assertEqual(first["sessionId"], old_session)
            self.assertEqual(client.get(path, headers=first_header).status_code, 403)
            self.assertEqual(client.post(path + "/runs", headers=next_header, json={}).json()["nativeRunId"], second["nativeRunId"])
            old_row = app.state.galaxy_runtime["db"].get_run(run_id=first["nativeRunId"], deserialize=False)
            self.assertEqual(duty_report_fields(old_row).get("nativeAttemptId"), None)
    def test_actual_agent_persists_and_uses_its_original_attempt(self):
        gateway, selected = AttemptTask(), settings()
        task = gateway.task
        attempt = task["nativeAttemptId"] = str(uuid4())
        user = "autonomy:" + task["taskId"]
        signed = {**claims(task, selected), "nativeAttemptId": attempt}
        with tempfile.TemporaryDirectory() as directory:
            db = SqliteDb(db_file=str(Path(directory) / "native.db"), id="attempt-contract")
            try:
                context = RequestContext(user_id=user, session_id=task["sessionId"], input={"taskId": task["taskId"]},
                    trusted=TrustedContext(claims=signed))
                agent = duty_factory(settings=selected, db=db, gateway=gateway, model_factory=LocalModel).resolve(context, Agent)
                auth = RunAuthorization(provider=GalaxyAuthorization(gateway),
                    context=AuthorizationContext(principal_id=user, claims=signed), enforce_tools=False)
                with authorization_scope(lambda: auth):
                    result = asyncio.run(agent.arun("task", session_id=task["sessionId"], user_id=user))
                row = db.get_run(run_id=result.run_id, deserialize=False)
                self.assertEqual(row["run_data"]["metadata"]["nativeAttemptId"], attempt)
                self.assertTrue(gateway.calls)
                self.assertTrue(all(call["native_attempt_id"] == attempt for call in gateway.calls))
                self.assertEqual(duty_report_fields(row)["nativeAttemptId"], attempt)
            finally:
                db.db_engine.dispose()

    def test_http_retry_binds_original_attempt_and_session(self):
        gateway, selected = AttemptTask(), settings()
        task = gateway.task
        attempt = task["nativeAttemptId"] = str(uuid4())
        class Ledger:
            rows = []
            def get_runs(self, **kwargs): return list(self.rows)
        ledger, app, calls = Ledger(), FastAPI(), []
        runtime = {"db": ledger, "gateway": gateway}
        runtime["dutySurface"] = install_duty_routes(app, selected, runtime)
        @app.post("/agents/galaxy-duty/runs")
        async def accept(request: Request):
            calls.append(request.headers["idempotency-key"])
            ledger.rows.append(RunOutput(run_id="native-original", status=RunStatus.pending,
                agent_id="galaxy-duty", session_id=task["sessionId"], user_id="autonomy:" + task["taskId"],
                metadata={"nativeAttemptId": attempt}))
            return {"run_id": "native-original", "status": "PENDING"}
        app.state.queue_worker = SimpleNamespace()
        app.add_middleware(PrivateSurface, settings=selected, runtime=runtime)
        def headers(a, key):
            token = jwt.encode({**claims(task, selected), "nativeAttemptId": a}, selected.verification_key, algorithm="HS256")
            return {"Authorization": "Bearer " + token, "X-Galaxy-Service-Key": selected.service_key, "Idempotency-Key": key}
        path = "/galaxy/autonomy/tasks/" + task["taskId"]
        with TestClient(app) as client:
            self.assertEqual(client.post(path + "/runs", headers=headers(attempt, task["taskId"]), json={}).status_code, 403)
            response = client.post(path + "/runs", headers=headers(attempt, attempt), json={})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual((response.json()["nativeAttemptId"], response.json()["sessionId"]), (attempt, task["sessionId"]))
            self.assertEqual(client.post(path + "/runs", headers=headers(attempt, attempt), json={}).status_code, 200)
            self.assertEqual(calls, [attempt])
            reports = len(gateway.reports)
            self.assertEqual(client.get(path, headers=headers(attempt, attempt)).status_code, 200)
            self.assertEqual(len(gateway.reports), reports, "Native.Read must not mutate the task revision")
            # The pre-factory pending row can lack metadata; its own durable
            # ticket must prove the original signed attempt and session.
            ledger.rows[0].metadata = {}
            ticket = {"id": "native-original", "idempotency_key": attempt, "component_type": "agent",
                "component_id": "galaxy-duty", "user_id": "autonomy:" + task["taskId"], "session_id": task["sessionId"],
                "payload": {"scope": {"source": "factory", "context": {"user_id": "autonomy:" + task["taskId"],
                    "session_id": task["sessionId"], "input": {"taskId": task["taskId"]},
                    "claims": {**claims(task, selected), "nativeAttemptId": attempt}}}}}
            class Store:
                async def get_job(self, _run_id): return ticket
                async def list_jobs(self, **kwargs): return [ticket], 1
            app.state.queue_worker.store = Store()
            pending = client.get(path, headers=headers(attempt, attempt))
            self.assertEqual(pending.status_code, 200, pending.text)
            self.assertEqual(pending.json()["nativeAttemptId"], attempt)
            ticket["session_id"] = str(uuid4())
            self.assertEqual(client.get(path, headers=headers(attempt, attempt)).status_code, 403)
            ticket["session_id"] = task["sessionId"]
            ticket["status"] = "queued"
            ledger.rows.clear()
            accepted = client.get(path, headers=headers(attempt, attempt))
            self.assertEqual(accepted.status_code, 200, accepted.text)
            self.assertEqual((accepted.json()["nativeRunId"], accepted.json()["nativeAttemptId"]), ("native-original", attempt))
            task["nativeAttemptId"], task["sessionId"] = str(uuid4()), str(uuid4())
            self.assertEqual(client.get(path, headers=headers(attempt, attempt)).status_code, 403)
            self.assertEqual(client.get(path, headers=headers(task["nativeAttemptId"], task["nativeAttemptId"])).status_code, 403)

    def test_authority_and_reports_remain_bound_to_original_attempt(self):
        gateway = AttemptTask()
        attempt = gateway.task["nativeAttemptId"] = str(uuid4())
        user = "autonomy:" + gateway.task["taskId"]
        bound = AttemptGateway(gateway, attempt)
        self.assertTrue(bound.duty_authorize(user)["allowed"])
        context = AuthorizationContext(principal_id=user, claims={"nativeAttemptId": attempt},
            resource_type="agents", resource_id="galaxy-duty", action="read")
        self.assertTrue(GalaxyAuthorization(gateway).check(context))
        row = {"run_id": str(uuid4()), "session_id": gateway.task["sessionId"], "status": "ERROR",
            "metadata": {"nativeAttemptId": attempt}}
        self.assertEqual(duty_report_fields(row)["nativeAttemptId"], attempt)
        self.assertEqual(duty_view(gateway.task["taskId"], row)["sessionId"], gateway.task["sessionId"])
        self.assertEqual(duty_view(gateway.task["taskId"], row)["nativeAttemptId"], attempt)
        self.assertEqual(duty_storage_fields(row)["metadata"]["nativeAttemptId"], attempt)
        gateway.task["nativeAttemptId"] = str(uuid4())
        with self.assertRaises(AuthorityDenied): bound.duty_authorize(user)
        self.assertFalse(GalaxyAuthorization(gateway).check(context))
        self.assertEqual(duty_report_fields(row)["nativeAttemptId"], attempt)
