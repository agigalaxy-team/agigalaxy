import asyncio
import hashlib
import json
import unittest
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from unittest.mock import patch

from agno.agent import Agent
from agno.db.sqlite import SqliteDb
from agno.models.base import Model as NativeModel
from agno.models.message import Message
from agno.models.response import ModelResponse
from agno.run.agent import RunInput, RunOutput
from galaxy_agentos.conversation_turn_context import with_conversation_turn_context
from galaxy_agentos.model_usage import _RUN, install_usage_scope


class Model:
    def invoke(self, messages): return messages
    async def ainvoke(self, messages): return messages
    def invoke_stream(self, messages): yield messages
    async def ainvoke_stream(self, messages): yield messages


class TurnContextTests(unittest.TestCase):
    def test_all_model_paths_log_current_run_without_content_or_cross_run_state(self):
        model = with_conversation_turn_context(Model())
        history = Message(role="user", content="old search secret", from_history=True)
        current = Message(role="user", content="new role request")
        messages = [history, Message(role="assistant", content="old", from_history=True), current]
        for mode in ("invoke", "ainvoke", "invoke_stream", "ainvoke_stream"):
            run = RunOutput(run_id="run-" + mode, input=RunInput(input_content=current.content), metadata={"operationId": "operation-1"})
            token = _RUN.set(run)
            try:
                with patch("builtins.print") as captured:
                    if mode == "invoke": model.invoke(messages)
                    elif mode == "ainvoke": asyncio.run(model.ainvoke(messages))
                    elif mode == "invoke_stream": list(model.invoke_stream(messages))
                    else:
                        async def collect(): return [item async for item in model.ainvoke_stream(messages)]
                        asyncio.run(collect())
                line = captured.call_args_list[0].args[0]
                self.assertNotIn("old search secret", line)
                self.assertNotIn("new role request", line)
                event = json.loads(line)
                self.assertEqual(event["event"], "conversation-turn-context")
                self.assertEqual(event["runId"], "run-" + mode)
                self.assertEqual(event["currentInputSha256"], hashlib.sha256(current.content.encode()).hexdigest())
                self.assertEqual(event["currentUserCount"], 1)
                self.assertTrue(event["currentInputMatchesLastUser"])
                self.assertEqual(event["historyCount"], 2)
                self.assertEqual(event["currentToolCount"], 0)
            finally:
                _RUN.reset(token)

    def test_two_native_runs_preserve_current_user_without_replaying_old_tool(self):
        calls = []
        @dataclass
        class NativeSequence(NativeModel):
            id: str = "local-sequence"
            name: str = "local"
            provider: str = "local"
            count: int = 0
            seen: list = field(default_factory=list)
            def invoke(self, messages, **kwargs):
                self.count += 1
                self.seen.append(list(messages))
                if self.count == 1:
                    return ModelResponse(role="assistant", tool_calls=[{"id": "old-call", "type": "function", "function": {"name": "read_search", "arguments": "{}"}}])
                return ModelResponse(role="assistant", content="ok")
            def _parse_provider_response(self, response, **kwargs): return response
            def _parse_provider_response_delta(self, response): return response
            async def ainvoke(self, *args, **kwargs): return self.invoke(*args, **kwargs)
            def invoke_stream(self, *args, **kwargs): yield self.invoke(*args, **kwargs)
            async def ainvoke_stream(self, *args, **kwargs): yield self.invoke(*args, **kwargs)
        def read_search():
            calls.append("search")
            return "done"
        with tempfile.TemporaryDirectory() as folder:
            db = SqliteDb(db_file=str(Path(folder) / "runs.db"))
            model = NativeSequence()
            install_usage_scope(model)
            with_conversation_turn_context(model)
            agent = Agent(model=model, db=db, tools=[read_search], add_history_to_context=True,
                num_history_runs=10, store_tool_messages=False, telemetry=False)
            try:
                with patch("builtins.print") as captured:
                    agent.run("old search", user_id="test-user", session_id="test-session", metadata={"operationId": "op-one"})
                    agent.run("new role", user_id="test-user", session_id="test-session", metadata={"operationId": "op-two"})
                self.assertEqual(calls, ["search"])
                events = [json.loads(c.args[0]) for c in captured.call_args_list if c.args and isinstance(c.args[0], str) and '"conversation-turn-context"' in c.args[0]]
                self.assertEqual(events[-1]["operationId"], "op-two")
                self.assertEqual(events[-1]["currentUserCount"], 1)
                self.assertTrue(events[-1]["currentInputMatchesLastUser"])
                self.assertNotEqual(events[0]["runId"], events[-1]["runId"])
                self.assertEqual([m.content for m in model.seen[-1] if m.role == "user"][-1], "new role")
            finally:
                db.db_engine.dispose()


if __name__ == "__main__":
    unittest.main()
