import asyncio
import json
import unittest
from dataclasses import dataclass, field

from agno.agent import Agent
from agno.models.base import Model
from agno.models.openai import OpenAIChat
from agno.models.response import ModelResponse
from agno.tools.function import Function, FunctionCall
from galaxy_agentos.conversation_tool_batches import with_conversation_tool_batches


class BatchTests(unittest.TestCase):
    def test_native_batches_reject_all_preparations_and_allow_reads_then_correction(self):
        effects = []
        def prepare_operation():
            effects.append("prepare")
            return "prepared"
        def read():
            effects.append("read")
            return "read"
        def call(fn, ident):
            function = Function.from_callable(fn)
            function.process_entrypoint()
            return FunctionCall(function=function, arguments={}, call_id=ident)
        async def check(async_mode):
            model = with_conversation_tool_batches(OpenAIChat(id="test"))
            results = []
            calls = [call(prepare_operation, "one"), call(read, "read"), call(prepare_operation, "two")]
            if async_mode:
                _ = [event async for event in model.arun_function_calls(calls, results)]
            else:
                list(model.run_function_calls(calls, results))
            self.assertEqual(effects, ["read"])
            rejected = [r for r in results if r.tool_call_error]
            self.assertEqual({r.tool_call_id for r in rejected}, {"one", "two"})
            self.assertTrue(all(json.loads(r.content)["state"] == "invalid-request" for r in rejected))
            results = []
            calls = [call(prepare_operation, "three")]
            if async_mode:
                _ = [event async for event in model.arun_function_calls(calls, results)]
            else:
                list(model.run_function_calls(calls, results))
            self.assertEqual(effects, ["read", "prepare"])
            self.assertEqual(results[0].tool_call_id, "three")
        for mode in (False, True):
            effects.clear()
            asyncio.run(check(mode))

    def test_native_agent_delivers_both_errors_to_next_model_request(self):
        effects = []
        def prepare_operation():
            effects.append("prepare")
            return "prepared"
        def read():
            effects.append("read")
            return "read"
        def tool(name, ident):
            return {"id": ident, "type": "function", "function": {"name": name, "arguments": "{}"}}
        @dataclass
        class Sequence(Model):
            id: str = "local-batch"
            name: str = "local"
            provider: str = "local"
            count: int = 0
            seen: list = field(default_factory=list)
            def invoke(self, messages, **kwargs):
                self.count += 1
                self.seen.append(list(messages))
                if self.count == 1:
                    return ModelResponse(role="assistant", tool_calls=[tool("prepare_operation", "one"), tool("read", "read"), tool("prepare_operation", "two")])
                if self.count == 2:
                    return ModelResponse(role="assistant", tool_calls=[tool("prepare_operation", "three")])
                return ModelResponse(role="assistant", content="done")
            async def ainvoke(self, *args, **kwargs): return self.invoke(*args, **kwargs)
            def invoke_stream(self, *args, **kwargs): yield self.invoke(*args, **kwargs)
            async def ainvoke_stream(self, *args, **kwargs): yield self.invoke(*args, **kwargs)
            def _parse_provider_response(self, response, **kwargs): return response
            def _parse_provider_response_delta(self, response): return response
        model = with_conversation_tool_batches(Sequence())
        agent = Agent(model=model, tools=[prepare_operation, read], telemetry=False)
        agent.run("choose one")
        self.assertEqual(effects, ["read", "prepare"])
        errors = [m for m in model.seen[1] if m.role == "tool" and m.tool_call_error]
        self.assertEqual({m.tool_call_id for m in errors}, {"one", "two"})
        self.assertTrue(all(json.loads(m.content)["state"] == "invalid-request" for m in errors))


if __name__ == "__main__":
    unittest.main()
