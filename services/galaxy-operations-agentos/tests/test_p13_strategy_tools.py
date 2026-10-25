"""One new wrapper contract; actual Agno tool schema, no model/database call.

The independent Node leaf executes these same closed arguments against actual
PG/current authority/consumer; this test's gateway is explicitly a double.
"""
import json
import unittest
from uuid import uuid4

from agno.run.base import RunContext
from agno.tools.function import Function

from galaxy_agentos.gateway import AuthorityDenied
from galaxy_agentos.p13_strategy_tools import strategy_tools


class P13OrdinaryToolsTest(unittest.TestCase):
    def test_native_tool_schema_and_stable_original_intents(self):
        class Gateway:
            def __init__(self):
                self.calls = []
                self.revoked = False

            def tool(self, user_id, tool, arguments, **context):
                if self.revoked:
                    raise AuthorityDenied("current_grant_revoked")
                self.calls.append((user_id, tool, arguments, context))
                return {"state": "saved", "revision": arguments.get("expectedRevision", 0) + 1}

        gateway = Gateway()
        tools = strategy_tools(gateway)
        self.assertEqual([tool.__name__ for tool in tools], ["read_selected_strategy",
            "save_selected_strategy_draft", "publish_selected_strategy"])
        for tool in tools:
            schema = Function.from_callable(tool).parameters
            self.assertNotIn("run_context", schema["properties"])
            self.assertNotIn("configuration", schema["properties"])
            self.assertNotIn("goals", schema["properties"])
        context = RunContext(run_id="synthetic-native-run", session_id="synthetic-session",
            user_id="execution:" + str(uuid4()))
        strategy = str(uuid4())
        tools[0](context, strategy)
        change = [{"path": [0, 1], "value": 17}]
        result = json.loads(tools[1](context, strategy, 2, change, enabled=False))
        self.assertEqual(result["state"], "saved")
        original_id = gateway.calls[-1][2]["operationId"]
        tools[1](context, strategy, 2, change, enabled=False)
        self.assertEqual(gateway.calls[-1][2]["operationId"], original_id)
        self.assertEqual(gateway.calls[-1][2]["parameterEdits"], change)
        self.assertEqual(gateway.calls[-1][0], context.user_id)
        self.assertEqual(gateway.calls[-1][3]["run_id"], context.run_id)
        tools[2](context, strategy, 3, str(uuid4()))
        self.assertNotEqual(gateway.calls[-1][2]["operationId"], original_id)
        gateway.revoked = True
        with self.assertRaises(AuthorityDenied):
            tools[1](context, strategy, 2, change, enabled=False)


if __name__ == "__main__":
    unittest.main()
