import asyncio
import json
import tempfile
import unittest
from dataclasses import dataclass, field
from pathlib import Path

from agno.agent import Agent
from agno.db.sqlite import SqliteDb
from agno.models.base import Model
from agno.models.message import Message
from agno.models.response import ModelResponse
from galaxy_agentos.conversation_history_projection import _project, with_conversation_history_projection


class HistoryProjectionTests(unittest.TestCase):
    def test_closed_copy_preserves_content_order_tool_pair_and_media(self):
        history = Message(role="user", content="旧搜索；继续之前可引用", from_history=True)
        assistant = Message(role="assistant", content=None, from_history=True, tool_calls=[{"id": "old", "type": "function", "function": {"name": "read", "arguments": "{}"}}])
        result = Message(role="tool", content=[{"type": "image_url", "image_url": {"url": "https://example.invalid/a"}}], tool_call_id="old", from_history=True)
        current = Message(role="user", content="新角色")
        messages = [history, assistant, result, current]
        args, _, status = _project((messages,), {})
        projected = args[0]
        self.assertIsNot(projected, messages)
        self.assertEqual([m.role for m in projected], [m.role for m in messages])
        self.assertEqual([m.id for m in projected], [m.id for m in messages])
        envelope = json.loads(projected[0].content)
        self.assertEqual(envelope["content"], history.content)
        self.assertEqual(envelope["instructionAuthority"], "not-a-current-work-queue")
        self.assertEqual(projected[1].tool_calls, assistant.tool_calls)
        self.assertEqual(projected[2].tool_call_id, "old")
        self.assertEqual(projected[2].content[1:], result.content)
        self.assertIs(projected[3], current)
        self.assertEqual(history.content, "旧搜索；继续之前可引用")
        self.assertIsNone(assistant.content)
        self.assertEqual(status, {"applied": True, "historyCount": 3, "notProjected": 0})

    def test_all_four_paths_do_not_mutate_or_leak_projection_context(self):
        class Fake:
            def invoke(self, messages): return messages
            async def ainvoke(self, messages): return messages
            def invoke_stream(self, messages): yield messages
            async def ainvoke_stream(self, messages): yield messages
        model = with_conversation_history_projection(Fake())
        old = Message(role="user", content="old", from_history=True)
        current = Message(role="user", content="current")
        messages = [old, current]
        async def arun(): return await model.ainvoke(messages)
        async def astream(): return [item async for item in model.ainvoke_stream(messages)][0]
        outputs = [model.invoke(messages), asyncio.run(arun()), list(model.invoke_stream(messages))[0], asyncio.run(astream())]
        for output in outputs:
            self.assertEqual(json.loads(output[0].content)["content"], "old")
            self.assertIs(output[1], current)
        self.assertEqual(old.content, "old")

    def test_nested_async_to_sync_projects_once_and_resets(self):
        class Nested:
            def invoke(self, messages): return messages
            async def ainvoke(self, messages): return self.invoke(messages)
            def invoke_stream(self, messages): yield self.invoke(messages)
            async def ainvoke_stream(self, messages): yield self.invoke(messages)
        model = with_conversation_history_projection(Nested())
        old = Message(role="user", content="old", from_history=True)
        out = asyncio.run(model.ainvoke([old]))
        self.assertEqual(json.loads(out[0].content)["content"], "old")
        self.assertEqual(json.loads(model.invoke([old])[0].content)["content"], "old")
        self.assertEqual(old.content, "old")

    def test_sdk_same_session_history_reference_and_explicit_continuation(self):
        calls = []
        def read_search(): calls.append("search"); return "search read"
        def prepare_role(): calls.append("role"); return "role proposed"
        def named_tool(name, ident):
            return {"id": ident, "type": "function", "function": {"name": name, "arguments": "{}"}}
        @dataclass
        class LocalModel(Model):
            id: str = "local-projection"
            name: str = "local"
            provider: str = "local"
            count: int = 0
            seen: list = field(default_factory=list)
            def invoke(self, messages, **kwargs):
                self.count += 1
                self.seen.append(list(messages))
                if self.count == 1:
                    return ModelResponse(role="assistant", tool_calls=[named_tool("read_search", "search-call")])
                if self.count == 4:
                    return ModelResponse(role="assistant", tool_calls=[named_tool("prepare_role", "role-call")])
                return ModelResponse(role="assistant", content="可以按治理角色方案继续。")
            async def ainvoke(self, *args, **kwargs): return self.invoke(*args, **kwargs)
            def invoke_stream(self, *args, **kwargs): yield self.invoke(*args, **kwargs)
            async def ainvoke_stream(self, *args, **kwargs): yield self.invoke(*args, **kwargs)
            def _parse_provider_response(self, response, **kwargs): return response
            def _parse_provider_response_delta(self, response): return response
        with tempfile.TemporaryDirectory() as folder:
            db = SqliteDb(db_file=str(Path(folder) / "history.db"))
            model = with_conversation_history_projection(LocalModel())
            agent = Agent(model=model, db=db, tools=[read_search, prepare_role], add_history_to_context=True,
                num_history_runs=10, store_tool_messages=False, telemetry=False)
            try:
                agent.run("查看旧搜索", user_id="user", session_id="session")
                agent.run("规划治理角色", user_id="user", session_id="session")
                agent.run("继续刚才方案", user_id="user", session_id="session")
                self.assertEqual(calls, ["search", "role"])
                second = model.seen[2]
                self.assertEqual([m.content for m in second if m.role == "user"][-1], "规划治理角色")
                previous = [json.loads(m.content) for m in second if m.role == "user" and m.from_history]
                self.assertEqual(previous[0]["content"], "查看旧搜索")
                third = model.seen[3]
                self.assertEqual([m.content for m in third if m.role == "user"][-1], "继续刚才方案")
                prior = [json.loads(m.content)["content"] for m in third if m.role == "user" and m.from_history]
                self.assertIn("规划治理角色", prior)
                self.assertEqual(model.seen[0][-1].content, "查看旧搜索")
            finally:
                db.db_engine.dispose()


if __name__ == "__main__": unittest.main()
