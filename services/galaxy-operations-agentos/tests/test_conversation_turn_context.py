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
from galaxy_agentos.conversation_turn_state import turn_state, RECEIPT_FEEDBACK, TASK_CONTEXT
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

    def test_root_objective_is_not_cut_and_first_turn_is_distinct_from_feedback(self):
        model=with_conversation_turn_context(Model()); run=RunOutput(run_id="task-run",metadata={"operationId":"o"})
        goal="甲"*12000; work=["任务"+str(n) for n in range(12)]
        turn_state(run)[TASK_CONTEXT]={"objective":goal,"objectiveAvailable":True,"remaining":work,"phase":"continue","rootOperationId":"private-id"}
        token=_RUN.set(run)
        try:
            with patch("builtins.print"): projected=model.invoke([Message(role="user",content="反馈")])
            content=projected[0].content; self.assertIn(goal,content); self.assertIn("任务11",content); self.assertNotIn("private-id",content)
            turn_state(run)[TASK_CONTEXT]={"objective":None,"objectiveAvailable":False,"remaining":[],"phase":"continue"}
            with patch("builtins.print"): projected=model.invoke([Message(role="user",content="当前目标")])
            self.assertIn("首次请求仍以当前用户消息为目标",projected[0].content); self.assertEqual(projected[1].content,"当前目标")
        finally: _RUN.reset(token)

    def test_original_receipt_projects_business_only_across_model_paths(self):
        model=with_conversation_turn_context(Model()); source=Message(role="user",content="原轮")
        run=RunOutput(run_id="receipt-run",metadata={"operationId":"current-turn"})
        original={"cardId":"CARD-SECRET-LOCATOR", "operationId":"ORIGINAL-SECRET-LOCATOR", "parentTurnId":"PARENT-SECRET-LOCATOR", "state":"completed", "effectExecuted":True,
            "presentation":{"summary":"调整推荐设置", "changes":[{"label":"避免重复", "before":"关闭", "after":"开启"}], "details":[{"label":"范围","value":"推荐策略"}], "warnings":["以实际结果为准"], "reviewable":True, "operationId":"UNTRUSTED-EXTRA"},
            "receipt":{"state":"recorded", "summary":"变更已记录", "cardId":"UNTRUSTED-EXTRA"}}
        turn_state(run)[RECEIPT_FEEDBACK]=original; token=_RUN.set(run)
        try:
            for mode in ("invoke","ainvoke","invoke_stream","ainvoke_stream"):
                with patch("builtins.print"):
                    if mode=="invoke": messages=model.invoke([source])
                    elif mode=="ainvoke": messages=asyncio.run(model.ainvoke([source]))
                    elif mode=="invoke_stream": messages=list(model.invoke_stream([source]))[0]
                    else:
                        async def collect(): return [v async for v in model.ainvoke_stream([source])]
                        messages=asyncio.run(collect())[0]
                content=messages[0].content
                for forbidden in ("CARD-SECRET-LOCATOR","ORIGINAL-SECRET-LOCATOR","PARENT-SECRET-LOCATOR","UNTRUSTED-EXTRA","cardId","operationId","parentTurnId","completed","recorded","effectExecuted"):
                    self.assertNotIn(forbidden,content)
                for expected in ("调整推荐设置","避免重复","关闭","开启","处理已结束","已记录","已执行","变更已记录"):
                    self.assertIn(expected,content)
                self.assertIs(messages[1],source); self.assertEqual(turn_state(run)[RECEIPT_FEEDBACK],original)
        finally: _RUN.reset(token)

    def test_task_history_projects_all_ordered_facts_without_mutation(self):
        model = with_conversation_turn_context(Model())
        run = RunOutput(run_id="history-run", metadata={"operationId":"current"})
        history = []
        for index, state in enumerate(("completed", "completed", "prepared"), 1):
            history.append({"cardId":f"card-{index}", "operationId":f"op-{index}", "parentTurnId":f"turn-{index}",
                "state":state, "effectExecuted":True if index < 3 else False,
                "receipt":{"state":"recorded", "summary":f"结果{index}"},
                "presentation":{"summary":f"步骤{index}", "changes":[{"label":"设置", "before":"旧", "after":"新"}],
                    "details":[{"label":"范围", "value":"全站"}], "warnings":[], "reviewable":True}})
        task = {"objective":"原始完整目标", "objectiveAvailable":True, "remaining":["最后一步"],
            "phase":"continue", "actionHistory":history}
        before = json.loads(json.dumps(task, ensure_ascii=False))
        turn_state(run)[TASK_CONTEXT] = task
        current = Message(role="user", content="反馈")
        token = _RUN.set(run)
        try:
            with patch("builtins.print"): messages = model.invoke([current])
            content = messages[0].content
            payload = json.loads(content[content.index('{'):])
            self.assertEqual(payload["原目标"], "原始完整目标")
            self.assertEqual(payload["剩余工作"], ["最后一步"])
            self.assertEqual([v["操作摘要"] for v in payload["操作历史"]], ["步骤1", "步骤2", "步骤3"])
            self.assertEqual([v["实际效果"] for v in payload["操作历史"]], ["已执行", "已执行", "未执行"])
            self.assertEqual(payload["操作历史"][2]["操作状态"], "待人工确认")
            self.assertEqual(payload["操作历史"][1]["变更"][0]["变更后"], "新")
            self.assertEqual(payload["操作历史"][1]["operationId"], "op-2")
            self.assertIn("不是新指令", content)
            self.assertIn("已成功步骤不得重做", content)
            self.assertIs(messages[1], current)
            self.assertEqual(task, before)
        finally: _RUN.reset(token)
    def test_unknown_and_oversized_receipt_keeps_business_summary_without_internal_ids(self):
        model=with_conversation_turn_context(Model()); run=RunOutput(run_id="r",metadata={"operationId":"o"})
        turn_state(run)[RECEIPT_FEEDBACK]={"cardId":"hidden-card", "operationId":"hidden-operation", "parentTurnId":"hidden-parent", "state":"future-unrecognized", "effectExecuted":None, "presentation":{"summary":"原操作摘要", "details":[{"label":"内容", "value":"字"*5000} for _ in range(3)]}, "receipt":{"state":"future-value", "summary":"真实回执摘要"}}
        token=_RUN.set(run)
        try:
            with patch("builtins.print"): content=model.invoke([Message(role="user",content="继续")])[0].content
            self.assertIn("原操作摘要",content); self.assertIn("真实回执摘要",content); self.assertIn("尚未确认",content); self.assertIn("详细内容过长",content)
            for forbidden in ("hidden-card","hidden-operation","hidden-parent","future-unrecognized","future-value"): self.assertNotIn(forbidden,content)
        finally: _RUN.reset(token)

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
