"""Finite real SDK/HTTP fixtures and actual CAS branches; no provider calls.

The PostgresDb CAS implementation runs unchanged on a local SQLite SQL
harness. This verifies its attempt/status/user branches, not PG row locking.
"""
import asyncio
from copy import deepcopy
from dataclasses import dataclass
import json
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from agno.agent import Agent
from agno.db.postgres import PostgresDb
from agno.db.sqlite import SqliteDb
from agno.metrics import RunMetrics
from agno.models.base import Model
from agno.models.message import Message
from agno.models.response import ModelResponse
from agno.os.authz.provider import AuthorizationContext
from agno.run.agent import RunOutput
from agno.run.authorization import RunAuthorization, authorization_scope
from agno.run.concurrency import worker_managed_execution
from agno.run.status_persist import RunPersistOutcome
import httpx
from sqlalchemy import Column, Integer, JSON, MetaData, String, Table, create_engine, select, update

from galaxy_agentos.authorization import GalaxyAuthorization
from galaxy_agentos.conversation_storage import conversation_database
from galaxy_agentos.gateway import AuthorityDenied, AuthorityUnavailable
from galaxy_agentos.model_gate import with_current_authority
from galaxy_agentos.model_profiles import RuntimeProfile, native_model
from galaxy_agentos.read_model import metadata


@dataclass
class ExplicitModel(Model):
    id: str = "explicit-local-model"
    calls: int = 0
    failure: bool = False

    def invoke(self, *args, **kwargs):
        self.calls += 1
        if self.failure:
            raise RuntimeError("explicit-local-provider-attempt-failed")
        return ModelResponse(role="assistant", content="explicit local response")

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


class CurrentAuthority:
    def authorize(self, user_id, **kwargs):
        return {"allowed": True, "resourceIds": ["galaxy-conversation-overview"],
            "execution": {"domain": "overview"}}


class CasHarness:
    def __init__(self, path, run):
        self.engine = create_engine("sqlite:///" + str(path), connect_args={"check_same_thread": False})
        tables = MetaData()
        self.table = Table("local_runs", tables, Column("run_id", String, primary_key=True),
            Column("session_id", String), Column("user_id", String), Column("status", String),
            Column("run_data", JSON), Column("updated_at", Integer))
        tables.create_all(self.engine)
        self.db = PostgresDb(db_engine=self.engine, id="local-real-sdk-cas")
        self.db._get_table = lambda **kwargs: self.table
        self.run = run
        with self.engine.begin() as connection:
            connection.execute(self.table.insert().values(run_id=run.run_id, session_id=run.session_id,
                user_id=run.user_id, status="RUNNING", run_data={"metadata": deepcopy(run.metadata),
                    "queue_attempt": 7, "status": "RUNNING"}, updated_at=1))

    def row(self):
        with self.engine.connect() as connection:
            return connection.execute(select(self.table.c.run_data).where(self.table.c.run_id == self.run.run_id)).scalar_one()

    def replace(self, value):
        with self.engine.begin() as connection:
            connection.execute(update(self.table).where(self.table.c.run_id == self.run.run_id).values(run_data=value))

    def close(self):
        self.db.Session.remove()
        self.engine.dispose()


def sse(delta, finish=None):
    value = {"id": "local-completion", "object": "chat.completion.chunk", "created": 1,
        "model": "explicit-local", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
    return b"data: " + json.dumps(value).encode() + b"\n\n"


class ModelVersionMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.gateway = CurrentAuthority()
        self.run = RunOutput(run_id=str(uuid4()), session_id=str(uuid4()),
            user_id="conversation:" + str(uuid4()), agent_id="galaxy-conversation-overview",
            metadata={"domain": "overview"}, metrics=RunMetrics())
        self.authority = RunAuthorization(provider=GalaxyAuthorization(self.gateway),
            context=AuthorizationContext(principal_id=self.run.user_id), enforce_tools=False)

    def model(self, version="models-local-a", db=None, failure=False):
        model = ExplicitModel(failure=failure)
        if version is not None:
            model._galaxy_settings_version = version
        model = with_current_authority(model, self.gateway)
        if db is not None:
            model._galaxy_usage_database = db
        return model

    def invoke(self, model, *, attempt=7, asynchronous=False):
        with authorization_scope(lambda: self.authority), worker_managed_execution(self.run.run_id, "local-worker", attempt):
            if asynchronous:
                return asyncio.run(model.aresponse(messages=[Message(role="user", content="local fixture")], run_response=self.run))
            return model.response(messages=[Message(role="user", content="local fixture")], run_response=self.run)

    def cas(self):
        value = CasHarness(Path(self.temp.name) / "cas.db", self.run)
        self.addCleanup(value.close)
        return value

    def test_real_sdk_agent_two_streamed_http_calls_persist_and_project_selected_version(self):
        requests = []
        selected = "models-fixed-before-run"

        def provider(request):
            requests.append(json.loads(request.content))
            if len(requests) == 1:
                body = sse({"role": "assistant", "tool_calls": [{"index": 0, "id": "call_local1", "type": "function",
                    "function": {"name": "current_summary", "arguments": "{}"}}]}) + sse({}, "tool_calls")
            else:
                body = sse({"role": "assistant", "content": "explicit local complete"}) + sse({}, "stop")
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body + b"data: [DONE]\n\n")

        model = native_model(RuntimeProfile("gemini", 100000, 1000, None, 30, True, False),
            alias="explicit-local", base_url="http://127.0.0.1:1/v1", api_key="synthetic", headers={
                "X-Galaxy-Model-Config-Version": selected})
        model._galaxy_settings_version = selected
        model.http_client = httpx.Client(transport=httpx.MockTransport(provider), trust_env=False)
        self.addCleanup(model.http_client.close)
        db = SqliteDb(db_file=str(Path(self.temp.name) / "agent.db"), id="local-model-version")
        self.addCleanup(db.db_engine.dispose)
        adapter = conversation_database(db)
        model = with_current_authority(model, self.gateway)
        model._galaxy_usage_database = adapter

        def current_summary():
            return {"state": "available", "basis": "explicit-local-fixture"}

        agent = Agent(id="galaxy-conversation-overview", model=model, tools=[current_summary], db=adapter,
            metadata={"domain": "overview"}, store_tool_messages=False, store_events=True,
            telemetry=False, debug_mode=False)
        with authorization_scope(lambda: self.authority):
            list(agent.run("local only", user_id=self.run.user_id, session_id=self.run.session_id,
                stream=True, stream_intermediate_steps=True))
        self.assertEqual(len(requests), 2)
        rows, count = db.get_runs(session_id=self.run.session_id, deserialize=False)
        self.assertEqual(count, 1)
        row = rows[0]
        recorded = row["run_data"]["metadata"]
        self.assertEqual(recorded["modelCalls"], 2)
        self.assertEqual(recorded["modelSettingsVersion"], selected)
        self.assertEqual(recorded["modelSettingsVersions"], [selected])
        self.assertEqual(metadata(row)["modelSettingsVersion"], selected)
        self.assertEqual(metadata(row)["modelSettingsVersions"], [selected])

    def test_actual_cas_records_two_fixed_instance_versions_in_order_without_duplicates(self):
        cas = self.cas()
        first = self.model("models-local-a", cas.db)
        second = self.model("models-local-b", cas.db)
        self.invoke(first)
        self.invoke(second, asynchronous=True)
        self.invoke(first)
        stored = cas.row()
        self.assertEqual(stored["queue_attempt"], 7)
        self.assertEqual(stored["metadata"]["modelCalls"], 3)
        self.assertEqual(stored["metadata"]["modelSettingsVersion"], "models-local-a")
        self.assertEqual(stored["metadata"]["modelSettingsVersions"], ["models-local-a", "models-local-b"])
        self.assertEqual(self.run.metadata, stored["metadata"])

    def test_stale_attempt_and_wrong_owner_block_provider_and_restore_all_metadata(self):
        cas = self.cas()
        model = self.model(db=cas.db)
        before = deepcopy(self.run.metadata)
        row = cas.row()
        row["queue_attempt"] = 8
        cas.replace(row)
        with self.assertRaises(AuthorityDenied):
            self.invoke(model, asynchronous=True)
        self.assertEqual(model.calls, 0)
        self.assertEqual(self.run.metadata, before)
        self.assertEqual(cas.row(), row)
        row["queue_attempt"] = 7
        cas.replace(row)
        self.run.user_id = "conversation:" + str(uuid4())
        with self.assertRaises(AuthorityUnavailable):
            self.invoke(model)
        self.assertEqual(model.calls, 0)
        self.assertEqual(self.run.metadata, before)
        self.assertEqual(cas.row(), row)

    def test_provider_failure_retains_the_attempted_version_already_recorded_by_cas(self):
        cas = self.cas()
        model = self.model("models-local-failed-attempt", cas.db, failure=True)
        with self.assertRaisesRegex(RuntimeError, "explicit-local-provider-attempt-failed"):
            self.invoke(model, asynchronous=True)
        self.assertEqual(model.calls, 1)
        self.assertEqual(cas.row()["metadata"]["modelCalls"], 1)
        self.assertEqual(cas.row()["metadata"]["modelSettingsVersion"], "models-local-failed-attempt")
        self.assertEqual(self.run.metadata, cas.row()["metadata"])

    def test_missing_or_invalid_model_version_stays_unknown_without_default_or_stale_label(self):
        cas = self.cas()
        for value in (None, "contains whitespace", "x" * 129, 3):
            model = self.model(value, cas.db)
            self.invoke(model)
            self.assertNotIn("modelSettingsVersion", self.run.metadata)
            self.assertNotIn("modelSettingsVersions", self.run.metadata)
        self.invoke(self.model("models-previous-known", cas.db))
        self.invoke(self.model(None, cas.db))
        self.assertNotIn("modelSettingsVersion", self.run.metadata)
        self.assertEqual(self.run.metadata["modelSettingsVersions"], ["models-previous-known"])

    def test_public_versions_require_verified_conversation_or_duty_coordinate_and_closed_values(self):
        row = {"run_id": self.run.run_id, "user_id": self.run.user_id,
            "agent_id": "galaxy-conversation-overview", "run_type": "agent", "run_data": {"metadata": {
                "domain": "overview", "modelSettingsVersion": "models-local-a", "modelSettingsVersions": ["models-local-a"]}}}
        self.assertEqual(metadata(row)["modelSettingsVersion"], "models-local-a")
        for changed in ({"user_id": "conversation:not-a-uuid"}, {"user_id": "execution:" + str(uuid4())},
                {"agent_id": "galaxy-conversation-governance"}, {"agent_id": "galaxy-overview"}):
            with self.subTest(changed=changed):
                view = metadata({**row, **changed})
                self.assertIsNone(view["modelSettingsVersion"])
                self.assertIsNone(view["modelSettingsVersions"])
        duty = {**row, "user_id": "autonomy:" + str(uuid4()), "agent_id": "galaxy-duty"}
        self.assertEqual(metadata(duty)["modelSettingsVersions"], ["models-local-a"])
        bad = deepcopy(row)
        bad["run_data"]["metadata"].update(modelSettingsVersion={"text": "private body"}, modelSettingsVersions=["good", {"body": "private"}])
        self.assertIsNone(metadata(bad)["modelSettingsVersion"])
        self.assertIsNone(metadata(bad)["modelSettingsVersions"])

    def test_old_run_without_version_is_read_without_backfill_or_mutation(self):
        row = {"run_id": str(uuid4()), "user_id": self.run.user_id, "agent_id": "galaxy-conversation-overview",
            "run_type": "agent", "run_data": {"metadata": {"domain": "overview", "modelCalls": 4}}}
        original = deepcopy(row)
        view = metadata(row)
        self.assertIsNone(view["modelSettingsVersion"])
        self.assertIsNone(view["modelSettingsVersions"])
        self.assertEqual(row, original)


if __name__ == "__main__":
    unittest.main()
