import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from agno.db.sqlite import SqliteDb
from agno.models.base import Model
from agno.models.response import ModelResponse
from agno.models.message import Message
from galaxy_agentos.conversation_compaction import ConversationCompaction, ConversationToolCompression, with_compaction_finish_guard
from galaxy_agentos.conversation_retry import ConversationAgent
from galaxy_agentos.conversation_storage import conversation_database
from galaxy_agentos.model_gate import with_current_authority


@dataclass
class LocalModel(Model):
    id: str = "fixture"
    name: str = "fixture"
    provider: str = "fixture"
    seen: list = field(default_factory=list)
    fail_summary: bool = False

    def invoke(self, messages, **kwargs):
        snapshot = [(m.role, m.content, m.from_history) for m in messages]
        self.seen.append(snapshot)
        if messages and messages[0].role == "system" and "summary" in str(messages[0].content).lower():
            return ModelResponse(role="assistant", content="" if self.fail_summary else "历史需求：保留未完成事项。")
        return ModelResponse(role="assistant", content="fixture response " + ("x" * 200))

    async def ainvoke(self, *args, **kwargs): return self.invoke(*args, **kwargs)
    def invoke_stream(self, *args, **kwargs): yield self.invoke(*args, **kwargs)
    async def ainvoke_stream(self, *args, **kwargs): yield self.invoke(*args, **kwargs)
    def _parse_provider_response(self, response, **kwargs): return response
    def _parse_provider_response_delta(self, response): return response


class Gateway:
    def authorize(self, user_id, operation): return {"allowed": True}


class CompactionTest(unittest.TestCase):
    def make_agent(self, db, model):
        model = with_compaction_finish_guard(with_current_authority(model, Gateway()))
        model._galaxy_usage_database = db
        compaction = ConversationCompaction(input_budget=8192, model=model, compact_at_tokens=80,
            uncompacted_tokens=10, compacted_token_budget=200, enforce_token_budget=False,
            store_compacted_messages=True, search_compacted_messages=False)
        return ConversationAgent(id="fixture", model=model, db=db, compaction=compaction,
            instructions=["fixed system boundary"], add_history_to_context=True,
            store_tool_messages=False, telemetry=False)

    def test_chinese_context_estimate_includes_tokenizer_count(self):
        import tiktoken
        from galaxy_agentos.conversation_compaction import _count
        text = "银河上下文与未完成事项，保留原始记录。" * 100
        expected = len(tiktoken.get_encoding("o200k_base").encode(text))
        self.assertGreaterEqual(_count([Message(role="user", content=text)], None), expected)

    def test_archive_failure_does_not_switch_history_view(self):
        class Identity: context = type("Context", (), {"principal_id": "user"})()
        with tempfile.TemporaryDirectory() as folder, patch("galaxy_agentos.model_gate.current_authorization", return_value=Identity()):
            db = SqliteDb(db_file=str(Path(folder) / "archive-failure.db"))
            model = LocalModel()
            agent = self.make_agent(db, model)
            try:
                agent.run("first " + "a" * 250, user_id="user", session_id="archive")
                with patch("agno.compaction.archive.CompactionArchive.write", return_value=False):
                    result = agent.run("second " + "a" * 250, user_id="user", session_id="archive")
                    if result.metadata.get("compactionStatus") is None:
                        result = agent.run("third " + "a" * 250, user_id="user", session_id="archive")
                self.assertEqual(result.metadata.get("compactionStatus"), "failed")
                self.assertFalse(db.get_compactions_for_session("archive"))
                self.assertTrue(any("first " in str(content) for _, content, _ in model.seen[-1]))
                self.assertFalse(any("历史需求" in str(content) for _, content, _ in model.seen[-1]))
            finally:
                db.db_engine.dispose()

    def test_short_history_forces_fold_before_native_500_run_cap(self):
        model = LocalModel()
        compaction = ConversationCompaction(input_budget=100000, model=model, compact_at_tokens=80000,
            uncompacted_tokens=8000, compacted_token_budget=1000, enforce_token_budget=False,
            store_compacted_messages=True, search_compacted_messages=False)
        history = [Message(role=role, content="x") for _ in range(400) for role in ("user", "assistant")]
        self.assertTrue(compaction.should_compact(history, context_tokens=1000))
        boundary = compaction.plan(history)
        self.assertIsNotNone(boundary)
        self.assertGreater(boundary, 0)
        self.assertLessEqual(sum(m.role == "user" for m in history[boundary:]), 200)

    def test_summary_records_batch_and_fit(self):
        model = LocalModel()
        compaction = ConversationCompaction(input_budget=8192, model=model, compact_at_tokens=4000,
            uncompacted_tokens=100, compacted_token_budget=200, enforce_token_budget=False,
            store_compacted_messages=True, search_compacted_messages=False)
        records = compaction._chunks([Message(role="user", content="a" * 20) for _ in range(20)])
        text, next_index = compaction._batch(records, 0, None, False)
        self.assertEqual(next_index, 20)
        self.assertIn("historicalRole", text)
        self.assertIn("messageId", text)
        huge = compaction._chunks([Message(role="user", content="x" * 5000)])
        self.assertGreater(len(huge), 1)
        self.assertIn('"fragments":', huge[0])

    def test_native_sqlite_run_and_failure_preserve_records(self):
        class Identity: context = type("Context", (), {"principal_id": "user"})()
        with tempfile.TemporaryDirectory() as folder, patch("galaxy_agentos.model_gate.current_authorization", return_value=Identity()):
            db = SqliteDb(db_file=str(Path(folder) / "test.db"))
            model = LocalModel()
            agent = self.make_agent(db, model)
            try:
                for number in range(5):
                    result = agent.run("request " + str(number) + " " + ("a" * 250), user_id="user", session_id="session")
                records = db.get_compactions_for_session("session")
                self.assertTrue(records)
                self.assertGreater(result.metadata.get("modelCalls", 0), 1)
                self.assertEqual(model.seen[-1][-1][1], "request 4 " + ("a" * 250))
                self.assertEqual(model.seen[-1][0][0], "system")
                self.assertTrue(any(role == "user" and "历史需求" in str(content)
                    for role, content, _ in model.seen[-1]))
                runs = db.get_runs(session_id="session", user_id="user", limit=20)
                self.assertEqual(len(runs), 5)
                self.assertTrue(any("request 0" in str(run.input.input_content) for run in runs))
                before = len(records)
                model.fail_summary = True
                agent.run("request failed summary " + ("z" * 2000), user_id="user", session_id="session")
                self.assertEqual(len(db.get_compactions_for_session("session")), before)
            finally:
                db.db_engine.dispose()

    def test_tool_loop_pressure_uses_original_and_counts_summary(self):
        @dataclass
        class ToolModel(LocalModel):
            def invoke(self, messages, **kwargs):
                self.seen.append([(m.role, m.content, m.compressed_content) for m in messages])
                if messages and messages[0].role == "system" and "summary" in str(messages[0].content).lower():
                    return ModelResponse(role="assistant", content="历史需求：保留未完成事项。")
                if not any(m.role == "tool" for m in messages):
                    return ModelResponse(role="assistant", tool_calls=[{"id":"tool-1", "type":"function", "function":{"name":"read_data", "arguments":"{}"}}])
                return ModelResponse(role="assistant", content="done")
        def read_data():
            """Return a synthetic large tool result."""
            return "large original evidence " * 200
        class Identity: context = type("Context", (), {"principal_id": "user"})()
        with tempfile.TemporaryDirectory() as folder, patch("galaxy_agentos.model_gate.current_authorization", return_value=Identity()):
            db = SqliteDb(db_file=str(Path(folder) / "tool.db"))
            model = with_compaction_finish_guard(with_current_authority(ToolModel(), Gateway()))
            compaction = ConversationCompaction(input_budget=8192, model=model, compact_at_tokens=250,
                uncompacted_tokens=30, compacted_token_budget=200, enforce_token_budget=False,
                store_compacted_messages=True, search_compacted_messages=False)
            manager = ConversationToolCompression(compaction)
            agent = ConversationAgent(model=model, db=db, tools=[read_data], compress_tool_results=True,
                compression_manager=manager, telemetry=False)
            try:
                result = agent.run("read", user_id="user", session_id="tool")
                tool_messages = [item for call in model.seen for item in call if item[0] == "tool"]
                self.assertTrue(any(content and compressed for _, content, compressed in tool_messages))
                self.assertGreaterEqual(result.metadata.get("modelCalls", 0), 3)
            finally:
                db.db_engine.dispose()

    def test_preexisting_run_usage_is_updated_through_storage_adapter(self):
        from agno.run.agent import RunOutput
        class Identity: context = type("Context", (), {"principal_id": "user"})()
        with tempfile.TemporaryDirectory() as folder, patch("galaxy_agentos.model_gate.current_authorization", return_value=Identity()):
            source = SqliteDb(db_file=str(Path(folder) / "cas.db"))
            from agno.session.agent import AgentSession
            source.upsert_session(AgentSession(session_id="cas", user_id="user", agent_id="fixture"))
            updates = []
            # SQLite has no update_run_in_session; emulate its exact-row write
            # against its actual native run table, as the Postgres method does.
            def update_run_in_session(*, session_id, run_id, user_id, expected_attempt, fields):
                row = source.get_run(run_id=run_id)
                if row is None or row.session_id != session_id or row.user_id != user_id:
                    return False
                row.metadata = fields["metadata"]
                source.upsert_run(row, session_id=session_id, user_id=user_id)
                updates.append((run_id, dict(row.metadata)))
                return True
            source.update_run_in_session = update_run_in_session
            db = conversation_database(source)
            agent = self.make_agent(db, LocalModel())
            try:
                for number in range(4):
                    ident = "run-" + str(number)
                    source.upsert_run(RunOutput(run_id=ident, session_id="cas", user_id="user", agent_id="fixture"), session_id="cas", user_id="user")
                    result = agent.run("request " + str(number) + "a" * 250, user_id="user", session_id="cas", run_id=ident)
                observed = [metadata["modelCalls"] for run_id, metadata in updates if run_id == result.run_id]
                self.assertTrue(db.get_compactions_for_session("cas"))
                self.assertGreaterEqual(len(observed), 2)
                self.assertEqual(observed, list(range(1, len(observed) + 1)))
                self.assertEqual(source.get_run(run_id=result.run_id).metadata["modelCalls"], len(observed))
            finally:
                db.db_engine.dispose()

    def test_async_native_session_compacts(self):
        class Identity: context = type("Context", (), {"principal_id": "user"})()
        with tempfile.TemporaryDirectory() as folder, patch("galaxy_agentos.model_gate.current_authorization", return_value=Identity()):
            db = conversation_database(SqliteDb(db_file=str(Path(folder) / "async.db")))
            agent = self.make_agent(db, LocalModel())
            async def execute():
                for number in range(4):
                    result = await agent.arun("async " + str(number) + "a" * 250, user_id="user", session_id="async")
                return result
            try:
                result = asyncio.run(execute())
                self.assertTrue(db.get_compactions_for_session("async"))
                self.assertGreater(result.metadata.get("modelCalls", 0), 1)
            finally:
                db.db_engine.dispose()

    def test_concurrent_native_runs_keep_usage_and_sessions_separate(self):
        class Identity: context = type("Context", (), {"principal_id": "user"})()
        with tempfile.TemporaryDirectory() as folder, patch("galaxy_agentos.model_gate.current_authorization", return_value=Identity()):
            db = SqliteDb(db_file=str(Path(folder) / "concurrent.db"))
            model = LocalModel()
            agent = self.make_agent(db, model)
            # Initialize database schema before concurrent operations.
            agent.run("seed", user_id="user", session_id="seed")
            def run(ident):
                result = None
                for number in range(4):
                    result = agent.run(ident + str(number) + ("a" * 250), user_id="user", session_id=ident)
                return result
            try:
                with ThreadPoolExecutor(max_workers=2) as executor:
                    results = list(executor.map(run, ["first", "second"]))
                for ident, result in zip(["first", "second"], results):
                    self.assertEqual(result.session_id, ident)
                    self.assertGreater(result.metadata.get("modelCalls", 0), 1)
                    records = db.get_compactions_for_session(ident)
                    self.assertTrue(records)
                    self.assertTrue(all(item["session_id"] == ident for item in records))
            finally:
                db.db_engine.dispose()

if __name__ == "__main__": unittest.main()
