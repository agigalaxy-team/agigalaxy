import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

from sqlalchemy import Column, Integer, JSON, MetaData, String, Table, create_engine, select
from sqlalchemy.orm import sessionmaker

from galaxy_agentos.read_model import list_runs, metadata, run_detail


class AiRunsReadModelTest(unittest.TestCase):
    def test_ordinary_sessions_participate_in_native_domain_pages_without_exposing_dialogue(self):
        engine = create_engine("sqlite://")
        self.addCleanup(engine.dispose)
        table = Table("native_runs", MetaData(), Column("run_id", String, primary_key=True),
            Column("user_id", String), Column("session_id", String), Column("agent_id", String),
            Column("workflow_id", String), Column("run_type", String), Column("status", String),
            Column("created_at", Integer), Column("updated_at", Integer), Column("run_data", JSON))
        table.metadata.create_all(engine)
        conversation = str(uuid4())
        rows = [{"run_id": "ordinary", "user_id": "conversation:" + conversation, "session_id": str(uuid4()),
            "agent_id": "galaxy-conversation-overview", "workflow_id": None, "run_type": "agent", "status": "COMPLETED", "created_at": 9, "updated_at": 10,
            "run_data": {"metadata": {"domain": "overview", "promptVersion": "galaxy-conversation-v1"}, "content": "PRIVATE_DIALOGUE", "input": "PRIVATE_INPUT"}},
            {"run_id": "execution", "user_id": "execution:" + str(uuid4()), "session_id": str(uuid4()), "agent_id": "galaxy-overview", "workflow_id": None,
             "run_type": "agent", "status": "COMPLETED", "created_at": 8, "updated_at": 9, "run_data": {"metadata": {"domain": "overview"}}},
            {"run_id": "other-domain", "user_id": "conversation:" + str(uuid4()), "session_id": str(uuid4()), "agent_id": "galaxy-conversation-discovery", "workflow_id": None,
             "run_type": "agent", "status": "COMPLETED", "created_at": 7, "updated_at": 8, "run_data": {"metadata": {"domain": "discovery"}}}]
        with engine.begin() as connection:
            connection.execute(table.insert(), rows)
        class NativeDb:
            Session = sessionmaker(engine)
            def _get_table(self, **kwargs):
                return table
            def get_run(self, run_id, **kwargs):
                with self.Session() as session:
                    row = session.execute(select(table).where(table.c.run_id == run_id)).mappings().one_or_none()
                    return dict(row) if row else None
            def get_traces(self, **kwargs):
                return [SimpleNamespace(trace_id="trace")], 1
            def get_spans(self, **kwargs):
                stamp = datetime(2026, 10, 23, tzinfo=timezone.utc)
                return [SimpleNamespace(span_id="model", trace_id="trace", parent_span_id=None, attributes={"openinference.span.kind": "LLM"},
                    name="provider.response", status_code="OK", start_time=stamp, end_time=stamp, duration_ms=0)]
        db = NativeDb()
        first = list_runs(db, domain="overview", limit=1)
        self.assertEqual((first["total"], first["nextPage"]), (2, 2))
        self.assertEqual(first["items"][0]["conversationId"], conversation)
        self.assertEqual(first["items"][0]["promptVersion"], "galaxy-conversation-v1")
        self.assertEqual(first["items"][0]["tokens"], {"input": None, "output": None, "total": None})
        self.assertEqual(list_runs(db, domain="overview", limit=1, page=2)["items"][0]["runId"], "execution")
        detail = run_detail(db, "ordinary")
        self.assertEqual(detail["spans"][0]["kind"], "LLM")
        self.assertIsNone(detail["input"]["value"])
        self.assertNotIn("PRIVATE", str(detail))
        forged = {**rows[0], "agent_id": "galaxy-conversation-discovery"}
        self.assertIsNone(metadata(forged)["conversationId"])
        self.assertIsNone(metadata({**rows[0], "user_id": "conversation:not-an-id"})["conversationId"])
        failed = {**rows[0], "status": "ERROR", "run_data": {"events": [{"error_type": "AuthorityUnavailable", "error": "PRIVATE_PROVIDER_ERROR"}]}}
        self.assertEqual(metadata(failed)["errorCode"], "operations_authorization_unavailable")
        self.assertNotIn("PRIVATE_PROVIDER_ERROR", str(metadata(failed)))


if __name__ == "__main__":
    unittest.main()
