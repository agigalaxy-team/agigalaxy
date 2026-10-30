import asyncio
import json
import unittest
from dataclasses import dataclass, field

from agno.agent import Agent
from agno.models.base import Model
from agno.models.openai import OpenAIChat
from agno.models.response import ModelResponse
from agno.models.message import Message
from agno.tools.function import Function, FunctionCall
from galaxy_agentos.conversation_tool_batches import with_conversation_tool_batches
from galaxy_agentos.model_usage import _RUN
from galaxy_agentos.conversation_turn_state import turn_state, PLAN
from types import SimpleNamespace


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

    def test_mixed_results_follow_original_call_order_with_prefix_in_sync_and_async(self):
        for async_mode in (False, True):
            for kind in ("assessment", "preparation"):
                effects=[]
                def read(value: int):
                    effects.append(("read",value)); return json.dumps({"value":value})
                def assess_turn():
                    effects.append(("assess",None)); return "unexpected"
                def prepare_operation(value: int):
                    effects.append(("prepare",value)); return "unexpected"
                def call(fn, ident, arguments):
                    function=Function.from_callable(fn); function.process_entrypoint()
                    return FunctionCall(function=function,call_id=ident,arguments=arguments)
                calls=([call(read,"read-first",{"value":1}),call(assess_turn,"assess",{}),call(read,"read-last",{"value":2})]
                    if kind=="assessment" else
                    [call(read,"read-first",{"value":1}),call(prepare_operation,"prepare-first",{"value":1}),
                     call(read,"read-last",{"value":2}),call(prepare_operation,"prepare-last",{"value":2})])
                prior=Message(role="tool",tool_call_id="older",content="previous")
                results=[prior]; model=with_conversation_tool_batches(OpenAIChat(id="test"))
                if async_mode:
                    async def collect(): return [item async for item in model.arun_function_calls(calls,results)]
                    asyncio.run(collect())
                else: list(model.run_function_calls(calls,results))
                self.assertIs(results[0],prior); self.assertEqual(results[0].content,"previous")
                self.assertEqual([item.tool_call_id for item in results[1:]],[call.call_id for call in calls])
                self.assertEqual(len(set(item.tool_call_id for item in results[1:])),len(calls))
                self.assertCountEqual(effects,[("read",1),("read",2)])
                by_id={item.tool_call_id:item for item in results[1:]}
                self.assertEqual(json.loads(by_id["read-first"].content),{"value":1})
                self.assertEqual(json.loads(by_id["read-last"].content),{"value":2})
                rejected=[item for item in results[1:] if item.tool_call_id not in {"read-first","read-last"}]
                self.assertTrue(all(item.tool_call_error and json.loads(item.content)["state"]=="invalid-request" for item in rejected))

    def test_three_distinct_candidates_or_reject_batch_before_dispatch(self):
        effects=[]
        def prepare_operation(value: int):
            effects.append(value)
            return "prepared"
        def call(value, ident):
            fn=Function.from_callable(prepare_operation); fn.process_entrypoint()
            return FunctionCall(function=fn, arguments={"value":value}, call_id=ident)
        async def check(async_mode, values):
            model=with_conversation_tool_batches(OpenAIChat(id="test")); results=[]
            run=SimpleNamespace(metadata={})
            turn_state(run)[PLAN]={"intent":"prepare","proposalCount":3,"alternatives":True}
            token=_RUN.set(run)
            try:
                calls=[call(v,str(i)) for i,v in enumerate(values)]
                if async_mode: _=[v async for v in model.arun_function_calls(calls,results)]
                else: list(model.run_function_calls(calls,results))
            finally: _RUN.reset(token)
            return results
        for mode in (False,True):
            effects.clear(); result=asyncio.run(check(mode,[1,2,3])); self.assertCountEqual(effects,[1,2,3]); self.assertTrue(all(not r.tool_call_error for r in result))
            effects.clear(); result=asyncio.run(check(mode,[1,1,2])); self.assertEqual(effects,[]); self.assertEqual(len(result),3); self.assertTrue(all(r.tool_call_error for r in result))
            effects.clear(); result=asyncio.run(check(mode,[1,2,3,4])); self.assertEqual(effects,[]); self.assertEqual(len(result),4)

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
