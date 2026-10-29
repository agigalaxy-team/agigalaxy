"""Native SDK/ASGI contracts; local explicit doubles, zero provider calls.

SQLite proves factory execution and metadata projection here. Real durable PG
acceptance/restart and the human model remain the central integration check.
"""
import asyncio
from contextlib import ExitStack
from copy import deepcopy
from dataclasses import dataclass
import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

from agno.agent import Agent
from agno.db.sqlite import SqliteDb
from agno.job_queue.store import InMemoryQueueStore
from agno.factory import RequestContext, TrustedContext, FactoryPermissionError
from agno.models.base import Model
from agno.models.response import ModelResponse
from agno.metrics import MessageMetrics, RunMetrics
from agno.models.message import Message
from agno.os.authz.provider import AuthorizationContext
from agno.run.agent import RunOutput
from agno.run.authorization import RunAuthorization, authorization_scope
from agno.run.base import RunContext, RunStatus
from agno.run.concurrency import worker_managed_execution, get_worker_ownership
from agno.run.status_persist import RunPersistOutcome
from agno.tools.function import Function, FunctionCall
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
import httpx
import jwt
from pydantic import TypeAdapter, ValidationError

from galaxy_agentos.app import PrivateSurface
from galaxy_agentos.authorization import GalaxyAuthorization
from galaxy_agentos.config import Settings
from galaxy_agentos.conversation_tools import conversation_tools
from galaxy_agentos.duties import duty_factory, duty_tools
from galaxy_agentos.duty_deadline import await_duty_deadline, DutyRoundTimeout
from galaxy_agentos.duty_storage import duty_database, duty_storage_fields, duty_report_fields
from galaxy_agentos.duty_surface import install_duty_routes, duty_view
from galaxy_agentos.duty_continuation import call_reference, continuation_tools
from galaxy_agentos.gateway import AuthorityDenied, AuthorityUnavailable, GalaxyGateway
from galaxy_agentos.model_settings import DOMAINS, domain_model
from galaxy_agentos.model_gate import with_current_authority


def settings(**extra):
    return Settings(database_url="postgresql+psycopg://unused.invalid/never-connected",
        authority_url="http://127.0.0.1:1/v1/internal/agentos/",
        service_key="local-only-service-key-not-production",
        verification_key="local-only-signing-key-not-production", **extra)


class CurrentTask:
    def __init__(self):
        ident = str(uuid4())
        self.task = {"taskId": ident, "operationId": ident, "planId": str(uuid4()),
            "planVersion": 1, "promptVersion": 1, "delegationVersion": None,
            "domain": "messaging", "aiAccountId": str(uuid4()), "mode": "ai",
            "source": "routine", "purpose": "operations-messaging", "sessionId": str(uuid4()),
            "roleVersion": "ai:current:1", "prompt": {"role": "核对当前待办", "context": {"title": "本轮巡检"}},
            "tools": ["current-summary", "query-operations", "read-operation-object", "assess-task"],
            "completion": {"disposition": "continue", "reasonCode": "task-assessment-required"}}
        self.revoked, self.calls, self.reports = False, [], []

    def duty_authorize(self, user_id, *, operation="read"):
        if user_id != "autonomy:" + self.task["taskId"] or self.revoked and operation != "read":
            raise AuthorityDenied("explicit-current-task-denied")
        return {"allowed": True, "task": deepcopy(self.task), "readExpiresAt": int(time.time()) + 30}

    def authorize(self, user_id, **kwargs):
        result = self.duty_authorize(user_id, operation=kwargs.get("operation", "read"))
        return {**result, "execution": result["task"], "resourceIds": ["galaxy-duty"]}

    def duty_tool(self, user_id, tool, arguments, **binding):
        self.duty_authorize(user_id, operation="tool")
        self.calls.append({"user": user_id, "tool": tool, "arguments": arguments, **binding})
        if tool == "assess-task":
            self.task["completion"] = {"disposition": "completed", "reasonCode": "task-goal-satisfied"}
        return {"state": "available", "counts": {"pending": 0}, "basis": "explicit-local-double"}

    def duty_report(self, user_id, value):
        self.duty_authorize(user_id)
        self.reports.append(value)
        return {"accepted": True}


@dataclass
class LocalModel(Model):
    id: str = "explicit-local-duty-model"
    name: str = "LocalOnly"
    provider: str = "NoNetwork"
    calls: int = 0
    def invoke(self, *args, **kwargs):
        self.calls += 1
        if self.calls == 1:
            return ModelResponse(role="assistant", tool_calls=[{"id": "local-summary", "type": "function",
                "function": {"name": "current_summary", "arguments": "{}"}}])
        if self.calls == 2:
            return ModelResponse(role="assistant", tool_calls=[{"id": "local-assessment", "type": "function",
                "function": {"name": "assess_task", "arguments": json.dumps({"assessment": {"goalSatisfied": True, "remainingWork": [], "summary": "local double"}})}}])
        return ModelResponse(role="assistant", content="PRIVATE_MODEL_RESULT_NOT_A_BUSINESS_RECEIPT")
    async def ainvoke(self, *args, **kwargs): return self.invoke(*args, **kwargs)
    def invoke_stream(self, *args, **kwargs): yield self.invoke(*args, **kwargs)
    async def ainvoke_stream(self, *args, **kwargs): yield self.invoke(*args, **kwargs)
    def _parse_provider_response(self, response, **kwargs): return response
    def _parse_provider_response_delta(self, response): return response


def claims(task, selected):
    now = int(time.time())
    return {"sub": "autonomy:" + task["taskId"], "iat": now, "exp": now + 60,
        "iss": selected.issuer, "aud": selected.audience, "scope": "task",
        "taskId": task["taskId"], "planId": task["planId"], "accountId": task["aiAccountId"],
        "delegationVersion": task["delegationVersion"]}


class DutyContracts(unittest.TestCase):
    def test_native_factory_hot_prompt_current_scope_and_actual_sdk_tool_execution(self):
        gateway, selected = CurrentTask(), settings()
        with tempfile.TemporaryDirectory() as directory, ExitStack() as resources:
            db = SqliteDb(db_file=str(Path(directory) / "native.db"), id="local-duty-contract")
            resources.callback(db.db_engine.dispose)
            factory = duty_factory(settings=selected, db=db, gateway=gateway, model_factory=LocalModel)
            def context():
                task = gateway.task
                return RequestContext(user_id="autonomy:" + task["taskId"], session_id=task["sessionId"],
                    input={"taskId": task["taskId"]}, trusted=TrustedContext(claims=claims(task, selected)))
            first = factory.resolve(context(), Agent)
            self.assertEqual(first.metadata["promptVersion"], 1)
            gateway.task["promptVersion"] = 2
            gateway.task["roundSeconds"] = 300
            gateway.task["prompt"]["role"] = "按更新要求核对实际消息"
            agent = factory.resolve(context(), Agent)
            self.assertEqual(agent.metadata["promptVersion"], 2)
            self.assertEqual((first.round_seconds, agent.round_seconds), (600, 300))
            self.assertIn("按更新要求", "\n".join(agent.instructions))
            self.assertNotIn("按更新要求", "\n".join(first.instructions))
            principal = context().user_id
            authorization = RunAuthorization(provider=GalaxyAuthorization(gateway),
                context=AuthorizationContext(principal_id=principal), enforce_tools=False)
            with authorization_scope(lambda: authorization):
                result = asyncio.run(agent.arun("本次服务端任务", session_id=gateway.task["sessionId"], user_id=principal))
            self.assertEqual(result.status, RunStatus.completed)
            self.assertEqual(duty_view(gateway.task["taskId"], result)["run"]["calls"], 3)
            self.assertIsNone(duty_view(gateway.task["taskId"], result)["run"]["tokens"]["total"])
            self.assertEqual(gateway.calls[0]["tool"], "current-summary")
            self.assertEqual(gateway.calls[0]["run_id"], result.run_id)
            UUID(gateway.calls[0]["call_id"])
            stored = db.get_run(run_id=result.run_id, deserialize=False)
            self.assertNotIn("PRIVATE_MODEL_RESULT", json.dumps(stored))
            self.assertTrue(any(value["modelState"] == "completed" for value in gateway.reports))
            self.assertTrue(all("businessState" not in value and "success" not in value for value in gateway.reports))
            gateway.revoked = True
            with self.assertRaises(FactoryPermissionError): factory.resolve(context(), Agent)
            with self.assertRaises(AuthorityDenied):
                agent.pre_hooks[0](RunContext(user_id=principal, session_id=gateway.task["sessionId"], run_id=result.run_id))

    def test_task_deadline_stamps_native_ownership_before_cancellation_without_replay(self):
        cancelled = []
        async def execute():
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.append(get_worker_ownership("native-original").cancellation_cause)
                raise
        async def check():
            with worker_managed_execution("native-original", "local-duty-worker", 1):
                with self.assertRaises(DutyRoundTimeout):
                    await await_duty_deadline(execute(), run_id="native-original", seconds=0.001)
        asyncio.run(check())
        self.assertEqual(cancelled, ["timeout"])
        self.assertIsNone(get_worker_ownership("native-original"))

    def test_model_call_count_is_persisted_under_native_attempt_fence_before_provider_invocation(self):
        gateway = CurrentTask()
        class ValueModel(LocalModel):
            def invoke(self, *args, **kwargs):
                self.calls += 1
                return ModelResponse(role="assistant", content="explicit local value")
        class AtomicCounter:
            outcome = RunPersistOutcome.STALE_ATTEMPT
            writes = []
            def update_run_in_session(self, **kwargs):
                self.writes.append(deepcopy(kwargs));return self.outcome
        db = AtomicCounter();model = with_current_authority(ValueModel(), gateway);model._galaxy_usage_database = db
        run = RunOutput(run_id="metered-native", agent_id="galaxy-duty", user_id="autonomy:" + gateway.task["taskId"],
            session_id=gateway.task["sessionId"], metadata={}, metrics=RunMetrics())
        authority = RunAuthorization(provider=GalaxyAuthorization(gateway),context=AuthorizationContext(principal_id=run.user_id),enforce_tools=False)
        async def check():
            with authorization_scope(lambda: authority), worker_managed_execution(run.run_id,"local-meter",7):
                with self.assertRaises(AuthorityDenied):
                    await model.aresponse(messages=[Message(role="user", content="local")],run_response=run)
                self.assertEqual(model.calls, 0)
                self.assertEqual(run.metadata,{})
                db.outcome=RunPersistOutcome.UPDATED
                await model.aresponse(messages=[Message(role="user", content="local")],run_response=run)
        asyncio.run(check())
        self.assertEqual(model.calls,1);self.assertEqual(run.metadata["modelCalls"],1)
        self.assertEqual(db.writes[-1]["expected_attempt"],7)
        self.assertEqual(db.writes[-1]["fields"]["metadata"]["modelCalls"],1)

    def test_native_human_pause_continues_same_run_from_original_node_fact_without_reexecuting_writer(self):
        gateway, selected = CurrentTask(), settings()
        task = gateway.task; task["tools"] = ["execute-operation", "assess-task"]
        original_operation, target_id = str(uuid4()), str(uuid4())
        class HumanModel(LocalModel):
            def invoke(self, *args, **kwargs):
                self.calls += 1
                if self.calls == 1:
                    return ModelResponse(role="assistant", tool_calls=[{"id": "original-human-action", "type": "function",
                        "function": {"name": "execute_operation", "arguments": json.dumps({"operation": {
                            "kind": "content-curation", "targetKind": "post", "targetId": target_id,
                            "pinned": True, "reason": "PRIVATE_DUTY_REASON"}})}}],
                        response_usage=MessageMetrics(input_tokens=10, output_tokens=2, total_tokens=12))
                if self.calls == 2:
                    return ModelResponse(role="assistant", tool_calls=[{"id": "resumed-assessment", "type": "function",
                        "function": {"name": "assess_task", "arguments": json.dumps({"assessment": {"goalSatisfied": True, "remainingWork": [], "summary": "decision applied"}})}}],
                        response_usage=MessageMetrics(input_tokens=10, output_tokens=2, total_tokens=12))
                return ModelResponse(role="assistant", content="PRIVATE_RESUMED_MODEL_BODY",
                    response_usage=MessageMetrics(input_tokens=10, output_tokens=2, total_tokens=12))
        def wait(user_id, tool, arguments, **binding):
            gateway.calls.append({"tool": tool, "arguments": arguments, **binding})
            if tool == "assess-task":
                task["completion"] = {"disposition": "completed"}
                return {"state": "available"}
            return {"state": "waiting-human", "operationId": original_operation, "code": "operations_autonomy_human_required"}
        gateway.duty_tool = wait
        with tempfile.TemporaryDirectory() as directory, ExitStack() as resources:
            db = SqliteDb(db_file=str(Path(directory) / "native.db"), id="local-pause-contract")
            resources.callback(db.db_engine.dispose)
            ctx = RequestContext(user_id="autonomy:" + task["taskId"], session_id=task["sessionId"],
                input={"taskId": task["taskId"]}, trusted=TrustedContext(claims=claims(task, selected)))
            original_model = HumanModel(); original_model._galaxy_settings_version = "manual-v1"
            agent = duty_factory(settings=selected, db=db, gateway=gateway, model_factory=lambda: original_model).resolve(ctx, Agent)
            authority = RunAuthorization(provider=GalaxyAuthorization(gateway), context=AuthorizationContext(principal_id=ctx.user_id), enforce_tools=False)
            with authorization_scope(lambda: authority):
                paused = asyncio.run(agent.arun("PRIVATE_TRANSIENT_INPUT", session_id=task["sessionId"], user_id=ctx.user_id))
                self.assertEqual(paused.status, RunStatus.paused)
                self.assertEqual(agent.model.calls, 1)
                stored = db.get_run(run_id=paused.run_id, deserialize=False)
                self.assertNotIn("PRIVATE_", json.dumps(stored))
                source = stored.get("run_data", stored)
                self.assertTrue(source["tools"][0]["external_execution_required"])
                self.assertEqual(source["tools"][0]["tool_args"], {})
                with self.assertRaises(AuthorityDenied):
                    agent.acontinue_run(run_id=paused.run_id, session_id=task["sessionId"], user_id=ctx.user_id)
                task["continuation"] = {"allowed": True, "decisions": [{"callId": gateway.calls[0]["call_id"],
                    "operationId": original_operation, "state": "rejected", "basis": "persisted-human-decision"}]}
                next_model = HumanModel(); next_model.calls = 1; next_model._galaxy_settings_version = "manual-v2"
                agent = duty_factory(settings=selected, db=db, gateway=gateway, model_factory=lambda: next_model).resolve(ctx, Agent)
                continued = asyncio.run(agent.acontinue_run(run_id=paused.run_id, session_id=task["sessionId"], user_id=ctx.user_id, stream=False))
            self.assertEqual(continued.run_id, paused.run_id)
            self.assertEqual(continued.status, RunStatus.completed)
            self.assertEqual(agent.model.calls, 3)
            usage = duty_view(task["taskId"], continued)["run"]
            self.assertEqual(usage["calls"], 3)
            self.assertEqual(usage["tokens"], {"input": 30, "output": 6, "total": 36})
            self.assertEqual(continued.metadata["modelSettingsVersion"], "manual-v2")
            self.assertEqual(continued.metadata["modelSettingsVersions"], ["manual-v1", "manual-v2"])
            self.assertEqual([call["tool"] for call in gateway.calls], ["execute-operation", "assess-task"])
            persisted = db.get_run(run_id=paused.run_id)
            self.assertGreater(duty_view(task["taskId"], persisted)["run"]["durationMs"], continued.metrics.duration * 1000,
                "Active duration includes the earlier execution leg without the human waiting interval")
            self.assertNotIn("PRIVATE_", json.dumps(db.get_run(run_id=paused.run_id, deserialize=False)))
            terminal = continued.to_dict(); terminal["status"] = "CANCELLED"
            with self.assertRaises(AuthorityDenied): continuation_tools(task, terminal)

    def test_manual_pause_uses_real_tool_and_resumes_same_native_run(self):
        class TwoPauses(CurrentTask):
            second_pause = None
            def duty_report(self, user_id, value):
                result = super().duty_report(user_id, value)
                if value.get("manualResumeConsumed"):
                    self.task["manualPause"]["phase"] = "ended"
                return result
            def duty_tool(self, user_id, tool, arguments, **binding):
                result = super().duty_tool(user_id, tool, arguments, **binding)
                if tool == "assess-task" and self.second_pause:
                    self.task["manualPause"] = {"phase": "requested", "pauseOperationId": self.second_pause, "nativeRunId": binding["run_id"], "checkpointCallIds": []}
                if self.task.get("manualPause", {}).get("phase") == "requested":
                    self.task["manualPause"].setdefault("eligibleCallIds", []).append(binding["call_id"])
                return result
        gateway, selected = TwoPauses(), settings()
        task = gateway.task
        pause_id, source_operation = str(uuid4()), str(uuid4())
        task["manualPause"] = {"phase": "requested", "pauseOperationId": pause_id, "nativeRunId": None, "checkpointCallIds": []}
        task["tools"] = ["current-summary", "assess-task"]
        with tempfile.TemporaryDirectory() as directory, ExitStack() as resources:
            db = SqliteDb(db_file=str(Path(directory) / "manual.db"), id="manual-pause-contract")
            resources.callback(db.db_engine.dispose)
            ctx = RequestContext(user_id="autonomy:" + task["taskId"], session_id=task["sessionId"], input={"taskId": task["taskId"]}, trusted=TrustedContext(claims=claims(task, selected)))
            model = LocalModel(); model._galaxy_settings_version = "manual-v1"
            agent = duty_factory(settings=selected, db=db, gateway=gateway, model_factory=lambda: model).resolve(ctx, Agent)
            authority = RunAuthorization(provider=GalaxyAuthorization(gateway), context=AuthorizationContext(principal_id=ctx.user_id), enforce_tools=False)
            with authorization_scope(lambda: authority):
                paused = asyncio.run(agent.arun("PRIVATE_TRANSIENT_INPUT", session_id=task["sessionId"], user_id=ctx.user_id))
                self.assertEqual(paused.status, RunStatus.paused)
                self.assertEqual(model.calls, 1)
                stored = db.get_run(run_id=paused.run_id, deserialize=False)
                self.assertNotIn("PRIVATE_", json.dumps(stored))
                raw = stored.get("run_data", stored)
                self.assertEqual(raw["metadata"]["manualPause"]["pauseOperationId"], pause_id)
                self.assertEqual(raw["metadata"]["manualPause"]["checkpointCallIds"], [gateway.calls[0]["call_id"]])
                self.assertTrue(raw["tools"][0]["external_execution_required"])
                self.assertEqual(raw["tools"][0]["tool_args"], {})
                resume_id = str(uuid4())
                task["manualPause"] = {"phase": "resuming", "pauseOperationId": pause_id, "resumeOperationId": resume_id, "nativeRunId": paused.run_id, "checkpointCallIds": [gateway.calls[0]["call_id"]]}
                task["continuation"] = {"allowed": True, "manualPause": True, "pauseOperationId": pause_id, "decisions": [{"callId": gateway.calls[0]["call_id"], "operationId": source_operation, "state": "no-action", "basis": "manual-pause-read-again"}]}
                gateway.second_pause = str(uuid4())
                resumed_model = LocalModel(); resumed_model.calls = 1; resumed_model._galaxy_settings_version = "manual-v1"
                agent = duty_factory(settings=selected, db=db, gateway=gateway, model_factory=lambda: resumed_model).resolve(ctx, Agent)
                continued = asyncio.run(agent.acontinue_run(run_id=paused.run_id, session_id=task["sessionId"], user_id=ctx.user_id))
                self.assertEqual(continued.run_id, paused.run_id)
                self.assertEqual(continued.status, RunStatus.paused)
                self.assertTrue(any(r.get("manualResumeConsumed", {}).get("resumeOperationId") == resume_id for r in gateway.reports))
                second_call = gateway.calls[1]["call_id"]
                task["manualPause"] = {"phase": "resuming", "pauseOperationId": gateway.second_pause, "resumeOperationId": str(uuid4()), "nativeRunId": paused.run_id, "checkpointCallIds": [second_call]}
                task["continuation"] = {"allowed": True, "manualPause": True, "pauseOperationId": gateway.second_pause, "decisions": [{"callId": second_call, "operationId": str(uuid4()), "state": "no-action", "basis": "manual-pause-read-again"}]}
                final_model = LocalModel(); final_model.calls = 2; final_model._galaxy_settings_version = "manual-v1"
                agent = duty_factory(settings=selected, db=db, gateway=gateway, model_factory=lambda: final_model).resolve(ctx, Agent)
                final = asyncio.run(agent.acontinue_run(run_id=paused.run_id, session_id=task["sessionId"], user_id=ctx.user_id))
                self.assertEqual(final.run_id, paused.run_id)
                self.assertEqual(final.status, RunStatus.completed)
            self.assertEqual([call["tool"] for call in gateway.calls], ["current-summary", "assess-task"])

    def test_manual_pause_ignores_local_unrecorded_tool_result(self):
        class Gateway(CurrentTask):
            def duty_tool(self, user_id, tool, arguments, **binding):
                value = super().duty_tool(user_id, tool, arguments, **binding)
                self.task["manualPause"].setdefault("eligibleCallIds", []).append(binding["call_id"])
                return value
        @dataclass
        class BadThenGood(LocalModel):
            def invoke(self, *args, **kwargs):
                self.calls += 1
                if self.calls == 1:
                    return ModelResponse(role="assistant", tool_calls=[{"id": "local-invalid", "type": "function", "function": {"name": "current_summary", "arguments": '{"unexpected":1}'}}])
                return ModelResponse(role="assistant", tool_calls=[{"id": "recorded-read", "type": "function", "function": {"name": "current_summary", "arguments": "{}"}}])
        gateway, selected = Gateway(), settings()
        task = gateway.task
        task["manualPause"] = {"phase": "requested", "pauseOperationId": str(uuid4()), "nativeRunId": None, "eligibleCallIds": []}
        task["tools"] = ["current-summary"]
        with tempfile.TemporaryDirectory() as directory, ExitStack() as resources:
            db = SqliteDb(db_file=str(Path(directory) / "local-invalid.db"), id="manual-invalid-contract")
            resources.callback(db.db_engine.dispose)
            ctx = RequestContext(user_id="autonomy:" + task["taskId"], session_id=task["sessionId"], input={"taskId": task["taskId"]}, trusted=TrustedContext(claims=claims(task, selected)))
            model = BadThenGood(); model._galaxy_settings_version = "manual-v1"
            agent = duty_factory(settings=selected, db=db, gateway=gateway, model_factory=lambda: model).resolve(ctx, Agent)
            authority = RunAuthorization(provider=GalaxyAuthorization(gateway), context=AuthorizationContext(principal_id=ctx.user_id), enforce_tools=False)
            with authorization_scope(lambda: authority):
                result = asyncio.run(agent.arun("check", session_id=task["sessionId"], user_id=ctx.user_id))
            self.assertEqual(result.status, RunStatus.paused)
            self.assertEqual(model.calls, 2)
            self.assertEqual(len(gateway.calls), 1)
            self.assertEqual(result.metadata["manualPause"]["checkpointCallIds"], [gateway.calls[0]["call_id"]])

    def test_natural_human_requirement_supersedes_old_manual_marker(self):
        from galaxy_agentos.duty_continuation import with_duty_pauses
        from galaxy_agentos.duty_storage import duty_report_fields
        from agno.models.response import ToolExecution
        pause_id, resume_id, call_id = str(uuid4()), str(uuid4()), str(uuid4())
        operation = str(uuid4())
        run = RunOutput(run_id=str(uuid4()), status=RunStatus.running,
            metadata={"manualPause": {"pauseOperationId": pause_id, "checkpointCallIds": [call_id]},
                "manualResumeConsumed": {"pauseOperationId": pause_id, "resumeOperationId": resume_id, "checkpointCallIds": [call_id]}})
        tool = ToolExecution(tool_name="execute_operation", tool_call_id="new-human", result=json.dumps({"state": "waiting-human", "operationId": operation}))
        class ModelDouble:
            def response(self, **kwargs):
                kwargs["after_tool_results"](SimpleNamespace(tool_executions=[tool]))
            async def aresponse(self, **kwargs):
                await kwargs["after_tool_results"](SimpleNamespace(tool_executions=[tool]))
        with_duty_pauses(ModelDouble()).response(run_response=run)
        self.assertTrue(run.requirements[0].tool_execution.external_execution_required)
        self.assertNotIn("manualPause", run.metadata)
        self.assertNotIn("manualResumeConsumed", run.metadata)
        run.status = RunStatus.paused
        self.assertNotIn("manualPause", duty_report_fields(run.to_dict()))

    def test_private_continuation_uses_native_ticket_cas_and_closed_original_decisions(self):
        gateway, selected = CurrentTask(), settings(); task = gateway.task
        run_id, provider_call, original_operation = str(uuid4()), "provider-waiting-action", str(uuid4())
        run = RunOutput(run_id=run_id, agent_id="galaxy-duty", session_id=task["sessionId"],
            user_id="autonomy:" + task["taskId"], status=RunStatus.paused)
        from agno.models.response import ToolExecution
        run.tools = [ToolExecution(tool_name="execute_operation", tool_call_id=provider_call, tool_args={}, external_execution_required=True)]
        task["continuation"] = {"allowed": False, "decisions": []}
        class Ledger:
            def get_runs(self, **kwargs): return [run]
        store = InMemoryQueueStore()
        asyncio.run(store.enqueue_job({"id": run_id, "status": "paused", "job_type": "run", "attempt": 1,
            "component_type": "agent", "component_id": "galaxy-duty", "session_id": task["sessionId"],
            "user_id": run.user_id, "payload": {"stream": False}, "max_attempts": 1}))
        app = FastAPI(); runtime = {"db": Ledger(), "gateway": gateway}
        runtime["dutySurface"] = install_duty_routes(app, selected, runtime)
        app.state.queue_worker = SimpleNamespace(store=store)
        app.add_middleware(PrivateSurface, settings=selected, runtime=runtime)
        headers = {"Authorization": "Bearer " + jwt.encode(claims(task, selected), selected.verification_key, algorithm="HS256"),
            "X-Galaxy-Service-Key": selected.service_key, "Idempotency-Key": task["taskId"]}
        path = "/galaxy/autonomy/tasks/" + task["taskId"] + "/continue"
        with TestClient(app) as client:
            self.assertEqual(client.post(path, headers=headers, json={}).status_code, 409)
            task["continuation"] = {"allowed": True, "decisions": [{"callId": call_reference(task["taskId"], run_id, provider_call),
                "operationId": original_operation, "state": "completed", "basis": "persisted-domain-operation-receipt"}]}
            self.assertEqual(client.post(path, headers=headers, json={"tools": []}).status_code, 403)
            accepted = client.post(path, headers=headers, json={})
            self.assertEqual(accepted.status_code, 202, accepted.text)
            self.assertEqual(accepted.json()["nativeRunId"], run_id)
            self.assertEqual(client.post(path, headers=headers, json={}).status_code, 202)
            current = client.get(path.removesuffix("/continue"), headers=headers)
            self.assertEqual(current.json()["status"], "PENDING", "Queued continuation wins over the prior PAUSED run-row view")
            self.assertEqual(gateway.reports[-1]["status"], "running")
        ticket = asyncio.run(store.get_job(run_id))
        self.assertEqual(ticket["max_attempts"], 2)
        self.assertEqual(ticket["payload"]["continue"]["_agno_authorization"]["context"]["principal_id"], run.user_id)
        approved = ticket["payload"]["continue"]["updated_tools"][0]
        self.assertEqual(approved["tool_args"], {})
        self.assertEqual(json.loads(approved["result"])["operationId"], original_operation)

    def test_duty_view_includes_all_recorded_model_calls_and_safe_usage_without_tool_bodies(self):
        task = CurrentTask().task
        value = duty_view(task["taskId"], {"run_id": "native-original", "agent_id": "galaxy-duty", "status": "COMPLETED",
            "content": "PRIVATE_RESPONSE", "metadata": {"modelCalls": 2}, "metrics": {"details": {"human-model": [{}]},
                "input_tokens": 100, "output_tokens": 20, "total_tokens": 120, "duration": 1.25}})
        self.assertEqual(value["run"]["calls"], 2)
        self.assertEqual(value["run"]["tokens"], {"input": 100, "output": 20, "total": 120})
        self.assertEqual(value["run"]["durationMs"], 1250)
        self.assertNotIn("PRIVATE", json.dumps(value))
        self.assertIsNone(duty_view(task["taskId"], {"run_id":"old-native", "metrics":{"details":{"model":[{},{}]}}})["run"]["calls"],
            "Legacy unique model entries cannot be converted to invocation counts")

    def test_tools_follow_current_whitelist_and_all_domains_share_typed_action_contract(self):
        gateway = CurrentTask()
        self.assertEqual([fn.name for fn in duty_tools(gateway, {"current-summary"})], ["current_summary"])
        schemas = []
        for domain in DOMAINS:
            fn = Function.from_callable(conversation_tools(gateway, domain=domain)[-1]); fn.process_entrypoint()
            schemas.append(fn.parameters)
        self.assertTrue(all(value == schemas[0] for value in schemas))
        action = duty_tools(gateway, {"execute-operation"})[0]
        from galaxy_agentos.conversation_tools import DutyPreparedOperation
        typ = DutyPreparedOperation
        with self.assertRaises(ValidationError):
            TypeAdapter(typ).validate_python({"kind": "content-curation", "targetKind": "post", "targetId": str(uuid4()), "operationId": str(uuid4())})
        adapter = TypeAdapter(typ)
        ident = str(uuid4())
        self.assertEqual(adapter.validate_python({"kind": "ordinary-strategy-draft", "strategyId": ident,
            "parameterEdits": [{"path": [0, 19], "value": 3}]}).parameterEdits[0].value, 3)
        with self.assertRaises(ValidationError):
            adapter.validate_python({"kind": "ordinary-strategy-draft", "strategyId": ident,
                "parameterEdits": [{"path": [20], "value": 3}]})
        batch = {"kind": "public-content-batch", "items": [{"kind": "post", "id": ident}], "action": "restore", "reason": "原范围恢复"}
        self.assertEqual(adapter.validate_python(batch).items[0].id, UUID(ident))
        with self.assertRaises(ValidationError): adapter.validate_python({**batch, "items": batch["items"] * 2})
        with self.assertRaises(ValidationError): adapter.validate_python({**batch, "action": "hide"})
        self.assertEqual(adapter.validate_python({"kind": "private-case-message", "reportId": ident,
            "messageId": str(uuid4()), "action": "keep", "summary": "按本案当前条件维持"}).action, "keep")
        draft_config = {"channels": ["inapp"], "content": {"purpose": "community-update", "title": "待人工核对的草稿",
            "body": "请在发布前核对当前事实。", "expiresAt": "2035-01-01T12:00:00+08:00"},
            "audience": {"kind": "all-accounts"}, "schedule": {"kind": "immediate"}}
        created = adapter.validate_python({"kind": "message-draft-create", "config": draft_config})
        self.assertNotIn("automation", created.model_dump(mode="json")["config"])
        self.assertEqual(adapter.validate_python({"kind": "message-draft-save", "targetId": ident, "config": draft_config}).targetId, UUID(ident))
        with self.assertRaises(ValidationError):
            adapter.validate_python({"kind": "message-draft-create", "planId": ident, "config": draft_config})
        with self.assertRaises(ValidationError):
            adapter.validate_python({"kind": "message-draft-create", "config": {**draft_config, "automation": {"kind": "ordinary", "factsConfirmed": True}}})
        with self.assertRaises(ValidationError):
            adapter.validate_python({"kind": "message-draft-create", "config": {**draft_config, "content": {**draft_config["content"], "href": "https://outside.invalid"}}})
        tool = duty_tools(gateway, {"current-summary"})[0]
        fn = tool; fn.process_entrypoint()
        fc = FunctionCall(function=fn, call_id="provider-owned-call")
        context = RunContext(user_id="autonomy:" + gateway.task["taskId"], session_id=gateway.task["sessionId"], run_id="native-run")
        tool.entrypoint(context, fc); tool.entrypoint(context, fc)
        self.assertEqual(gateway.calls[-1]["call_id"], gateway.calls[-2]["call_id"])
        gateway.task["tools"] = []
        self.assertEqual(json.loads(tool.entrypoint(context, fc))["state"], "denied")

    def test_local_validation_failure_records_original_task_call_without_private_invalid_value(self):
        gateway = CurrentTask()
        def record(user_id, tool, arguments, **binding):
            gateway.calls.append({"tool":tool,"arguments":arguments,**binding})
            return {"state":"recorded"}
        gateway.duty_tool = record
        tool = duty_tools(gateway, {"query-operations"})[0]
        context = RunContext(user_id="autonomy:"+gateway.task["taskId"], session_id=gateway.task["sessionId"], run_id="native-run", metadata={})
        fc = FunctionCall(function=tool, call_id="local-invalid")
        feedback = json.loads(tool.entrypoint(context, fc, module="feedback", view="list", filters={"limit":"PRIVATE_INVALID"}))
        self.assertEqual(feedback["state"], "invalid-request")
        self.assertEqual(gateway.calls[-1]["tool"], "query-operations")
        self.assertTrue(gateway.calls[-1]["validation_failure"]["ambiguous"])
        self.assertNotIn("PRIVATE_INVALID", json.dumps(gateway.calls[-1]))
        self.assertEqual(gateway.calls[-1]["call_id"], call_reference(gateway.task["taskId"], "native-run", "local-invalid"))

    def test_private_http_requires_service_and_task_claims_and_never_accepts_model_input(self):
        gateway, selected = CurrentTask(), settings()
        task = gateway.task
        class Ledger:
            rows = []
            def get_runs(self, **kwargs): return list(self.rows)
        ledger = Ledger()
        app, dispatches = FastAPI(), []
        runtime = {"db": ledger, "gateway": gateway}
        runtime["dutySurface"] = install_duty_routes(app, selected, runtime)
        @app.post("/agents/galaxy-duty/runs")
        async def native_accept(request: Request):
            dispatches.append(dict(await request.form()))
            ledger.rows.append(RunOutput(run_id="native-original", status=RunStatus.pending,
                agent_id="galaxy-duty", session_id=task["sessionId"], user_id="autonomy:" + task["taskId"]))
            return {"run_id": "native-original", "status": "PENDING"}
        app.state.queue_worker = SimpleNamespace()
        app.add_middleware(PrivateSurface, settings=selected, runtime=runtime)
        token = jwt.encode(claims(task, selected), selected.verification_key, algorithm="HS256")
        headers = {"Authorization": "Bearer " + token, "X-Galaxy-Service-Key": selected.service_key, "Idempotency-Key": task["taskId"]}
        path = "/galaxy/autonomy/tasks/" + task["taskId"]
        with TestClient(app) as client:
            self.assertEqual(client.get(path, headers={"Authorization": "Bearer " + token}).status_code, 403)
            self.assertEqual(client.post(path + "/runs", headers=headers, json={"message": "inject"}).status_code, 403)
            response = client.post(path + "/runs", headers=headers, json={})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["nativeRunId"], "native-original")
            self.assertEqual(client.post(path + "/runs", headers=headers, json={}).json()["nativeRunId"], "native-original")
            self.assertEqual(len(dispatches), 1)
            self.assertEqual(set(dispatches[0]), {"message", "session_id", "factory_input", "background", "stream"})
            self.assertNotIn("prompt", json.dumps(dispatches))
            self.assertEqual(client.post("/agents/galaxy-duty/runs", headers=headers, data={}).status_code, 403)
            other = {**claims(task, selected), "accountId": str(uuid4())}
            wrong = {**headers, "Authorization": "Bearer " + jwt.encode(other, selected.verification_key, algorithm="HS256")}
            self.assertEqual(client.get(path, headers=wrong).status_code, 403)
            gateway.revoked = True
            self.assertEqual(client.get(path, headers=headers).status_code, 200)
            self.assertEqual(client.post(path + "/runs", headers=headers, json={}).status_code, 403)

    def test_gateway_task_transport_is_closed_and_distinguishes_outage(self):
        selected, sent = settings(), []
        def handler(request):
            sent.append((str(request.url), json.loads(request.content)))
            return httpx.Response(200, json={"allowed": True, "task": {"taskId": ident}})
        ident = str(uuid4())
        gateway = GalaxyGateway(selected, transport=httpx.MockTransport(handler)); self.addCleanup(gateway.close)
        gateway.duty_authorize("autonomy:" + ident, operation="tool")
        self.assertTrue(sent[0][0].endswith("/v1/internal/agentos/autonomy/authorize"))
        self.assertEqual(sent[0][1], {"taskId": ident, "operation": "tool"})
        with self.assertRaises(AuthorityDenied): gateway.duty_authorize("conversation:" + ident)
        def unavailable(request): return httpx.Response(503, json={"error": "PRIVATE_SERVICE_PROSE"})
        down = GalaxyGateway(selected, transport=httpx.MockTransport(unavailable)); self.addCleanup(down.close)
        with self.assertRaises(AuthorityUnavailable): down.duty_authorize("autonomy:" + ident)

    def test_code_task_reuses_node_rules_without_constructing_agent_or_native_model_run(self):
        gateway, selected = CurrentTask(), settings()
        task = gateway.task; task["mode"] = "code"; task["state"] = "running"
        calls = []
        def code(user_id):
            calls.append(user_id); task["state"] = "completed"
            return {"taskId": task["taskId"], "operationId": task["taskId"], "nativeRunId": None,
                "status": "COMPLETED", "modelState": "not-required", "awaitingHuman": False}
        gateway.duty_code = code
        class NoNativeReads:
            def get_runs(self, **kwargs): raise AssertionError("code must not create/read an Agno run")
        app = FastAPI(); runtime = {"db": NoNativeReads(), "gateway": gateway}
        runtime["dutySurface"] = install_duty_routes(app, selected, runtime)
        app.add_middleware(PrivateSurface, settings=selected, runtime=runtime)
        token = jwt.encode(claims(task, selected), selected.verification_key, algorithm="HS256")
        headers = {"Authorization": "Bearer " + token, "X-Galaxy-Service-Key": selected.service_key, "Idempotency-Key": task["taskId"]}
        path = "/galaxy/autonomy/tasks/" + task["taskId"]
        with TestClient(app) as client:
            result = client.post(path + "/runs", headers=headers, json={})
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json()["modelState"], "not-required")
            self.assertIsNone(result.json()["nativeRunId"])
            self.assertEqual(client.get(path, headers=headers).json()["status"], "COMPLETED")
            self.assertEqual(calls, ["autonomy:" + task["taskId"]])

    def test_bindings_are_hot_loaded_without_provider_call_and_old_model_is_version_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bindings.json"
            def write(version, alias):
                path.write_text(json.dumps({"version": version, "scenarios": {domain: {"alias": alias,
                    "dataPolicyApproved": True, "parameters": {}} if domain == "messaging" else None for domain in DOMAINS}}))
            write("manual-v1", "galaxy-manual1")
            selected = settings(model_gateway_url="http://127.0.0.1:9", model_gateway_key="local-only-never-connected-model-key", model_bindings_file=str(path))
            old = domain_model(selected, "messaging", CurrentTask())
            write("manual-v2", "galaxy-manual2")
            fresh = domain_model(selected, "messaging", CurrentTask())
            self.assertEqual((old.id, old._galaxy_settings_version), ("galaxy-manual1", "manual-v1"))
            self.assertEqual((fresh.id, fresh._galaxy_settings_version), ("galaxy-manual2", "manual-v2"))

    def test_failure_code_reads_original_nested_native_row_metadata(self):
        row = {"run_id":"original-run", "status":"ERROR", "run_data":{"status":"RUNNING", "metadata":{"completionFailureCode":"operations_autonomy_completion_incomplete"}}}
        report = duty_report_fields(row)
        self.assertEqual(report["nativeRunId"], "original-run")
        self.assertEqual(report["modelState"], "failed")
        self.assertEqual(report["code"], "operations_autonomy_completion_incomplete")
        row["run_data"]["metadata"]["completionFailureCode"] = "untrusted-value"
        self.assertEqual(duty_report_fields(row)["code"], "operations_autonomy_model_failed")

    def test_atomic_storage_preserves_native_fence_and_withholds_timeout_tool_and_prompt_bodies(self):
        gateway = CurrentTask()
        fields = {"run_id": "native", "user_id": "autonomy:" + gateway.task["taskId"], "agent_id": "galaxy-duty",
            "status": "ERROR", "content": "PRIVATE_ERROR", "input": "PRIVATE_INPUT", "messages": [{"role": "system", "content": "PRIVATE_PROMPT"}],
            "metadata": {"taskId": gateway.task["taskId"], "promptVersion": 2, "rolePrompt": "PRIVATE_ROLE"},
            "tools": [{"tool_name": "execute_operation", "tool_args": {"body": "PRIVATE_TOOL"}, "result": "PRIVATE_RESULT"}]}
        class AtomicDb:
            id = "explicit-atomic-double"
            row = None
            received = None
            outcome = RunPersistOutcome.UPDATED
            def update_run_in_session(self, *args, fields, **kwargs):
                self.received = {"fields": fields, **kwargs}
                self.row = {**fields, "agent_id": "galaxy-duty", "user_id": "autonomy:" + gateway.task["taskId"]}
                return self.outcome
            def get_run(self, **kwargs): return self.row
        db = AtomicDb(); projected = duty_database(db, gateway)
        result = projected.update_run_in_session("session", "native", fields=fields, expected_attempt=7, content_if_absent="PRIVATE_FALLBACK")
        self.assertEqual(result, RunPersistOutcome.UPDATED)
        self.assertEqual(db.received["expected_attempt"], 7)
        self.assertIsNone(db.received["content_if_absent"])
        self.assertNotIn("PRIVATE_", json.dumps(db.received))
        self.assertEqual(gateway.reports[-1]["modelState"], "failed")
        count = len(gateway.reports); db.outcome = RunPersistOutcome.STALE_ATTEMPT
        projected.update_run_in_session("session", "native", fields=fields, expected_attempt=6)
        self.assertEqual(len(gateway.reports), count)


if __name__ == "__main__": unittest.main(verbosity=2)
