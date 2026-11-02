import asyncio
import json
import unittest
from agno.models.openai import OpenAIChat
from agno.models.message import Message
from agno.tools.function import Function, FunctionCall
from galaxy_agentos.conversation_tool_batches import with_conversation_tool_batches


class BatchTests(unittest.TestCase):
    def test_mixed_results_keep_original_order_and_dispatch_each_call(self):
        for async_mode in (False, True):
            effects = []
            def read(value: int):
                effects.append(("read", value))
                return json.dumps({"value": value})
            def prepare_feedback_accounts_operation(value: int):
                effects.append(("prepare", value))
                return json.dumps({"state": "prepared", "value": value})
            def call(fn, ident, value):
                function = Function.from_callable(fn)
                function.process_entrypoint()
                return FunctionCall(function=function, call_id=ident, arguments={"value": value})
            calls = [call(read, "read-first", 1), call(prepare_feedback_accounts_operation, "prepare", 3),
                call(read, "read-last", 2)]
            prior = Message(role="tool", tool_call_id="older", content="previous")
            results = [prior]
            model = with_conversation_tool_batches(OpenAIChat(id="test"))
            if async_mode:
                async def collect():
                    return [item async for item in model.arun_function_calls(calls, results)]
                asyncio.run(collect())
            else:
                list(model.run_function_calls(calls, results))
            self.assertIs(results[0], prior)
            self.assertEqual([item.tool_call_id for item in results[1:]], [call.call_id for call in calls])
            self.assertCountEqual(effects, [("read", 1), ("prepare", 3), ("read", 2)])
            self.assertTrue(all(not item.tool_call_error for item in results[1:]))


if __name__ == "__main__": unittest.main()
