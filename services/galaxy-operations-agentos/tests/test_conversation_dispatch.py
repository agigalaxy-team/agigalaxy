import json
import unittest
from uuid import uuid4

from agno.tools.function import Function
from galaxy_agentos.business_tools import is_preparation_tool
from galaxy_agentos.conversation_dispatch import dispatch_tools, Interval, Once


class WorkRequestContracts(unittest.TestCase):
    def test_arbitrary_goal_and_schedule_are_data_not_a_task_template(self):
        calls = []
        def send(context, call, name, args):
            calls.append((name, args))
            return json.dumps({"state": "prepared", "effectExecuted": False})
        request, read = dispatch_tools(send)
        schema = Function.from_callable(request).parameters
        self.assertNotIn("run_context", schema["properties"])
        self.assertNotIn("fc", schema["properties"])
        self.assertTrue(is_preparation_tool(request.__name__))
        goal = 'Compare feedback mentioning {"theme":"accessibility"}; report evidence.'
        request(None, None, "overview", "Independent review", goal, Interval(kind="interval", minutes=20000))
        self.assertEqual(calls[-1][0], "prepare-operation")
        self.assertEqual(calls[-1][1]["goal"], goal)
        self.assertEqual(calls[-1][1]["trigger"]["minutes"], 20000)
        self.assertEqual(calls[-1][1]["actions"], [])
        self.assertNotIn("prompt", calls[-1][1])
        request(None, None, "discovery", "Review a trend", "Read current trends", Once(kind="once"))
        self.assertEqual(calls[-1][1]["trigger"], {"kind": "once"})
        ident = uuid4()
        read(None, None, ident)
        self.assertEqual(calls[-1], ("read-dispatched-task", {"dispatchId": str(ident)}))

    def test_core_dispatch_does_not_require_loading_a_business_domain(self):
        from galaxy_agentos.conversation_turn_context import _stage_tools
        tools=[{"type":"function","function":{"name":name}} for name in ("request_task","read_dispatched_task","prepare_content_operation")]
        _,kwargs=_stage_tools((),{"tools":tools,"tool_choice":"auto"})
        names=[t["function"]["name"] for t in kwargs["tools"]]
        self.assertIn("request_task",names)
        self.assertIn("read_dispatched_task",names)
