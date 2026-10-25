"""Close one proven native/Node filter mismatch; no model or delivery."""
import json
import unittest
from uuid import uuid4

from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall
from pydantic import ValidationError

from galaxy_agentos.conversation_tools import QueryFilters, conversation_tools


class RecordingNode:
    def __init__(self):
        self.calls = []

    def conversation_tool(self, user_id, name, arguments, **context):
        self.calls.append((user_id, name, arguments, context))
        return {"state": "available", "effectExecuted": False}


class MessagingRecipientFilterContract(unittest.TestCase):
    def test_existing_node_channel_filter_reaches_the_fixed_read_view(self):
        node = RecordingNode()
        query, read = conversation_tools(node)[:2]
        context = RunContext(run_id=str(uuid4()), session_id=str(uuid4()),
            user_id="conversation:" + str(uuid4()), metadata={"operationId": str(uuid4())})
        function = Function.from_callable(query)
        call = FunctionCall(function=function, call_id="recipient-channel")
        run_id = str(uuid4())
        for channel in ["email", "inapp"]:
            value = QueryFilters(runId=run_id, channel=channel, state="failed")
            result = json.loads(query(context, call, "messaging", "recipients", value))
            self.assertEqual(result, {"state": "available", "effectExecuted": False})
            self.assertEqual(node.calls[-1][1:3], ("query-operations", {
                "module": "messaging", "view": "recipients",
                "filters": {"runId": run_id, "channel": channel, "state": "failed"}}))
            self.assertEqual(node.calls[-1][3], {"run_id": context.run_id,
                "call_id": call.call_id, "session_id": context.session_id,
                "turn_id": context.metadata["operationId"]})
        for channel in ["smtp", "all", "sms", "", True]:
            with self.assertRaises(ValidationError):
                QueryFilters(runId=run_id, channel=channel)
        fields = function.parameters["properties"]["filters"]
        self.assertIn('"channel"', json.dumps(fields))
        self.assertNotIn("run_context", function.parameters["properties"])
        self.assertNotIn("fc", function.parameters["properties"])
        # A newly expressible field still cannot leak into another fixed view.
        result = json.loads(query(context, call, "analytics", "paths", QueryFilters(channel="email")))
        self.assertEqual(result["state"], "invalid-request")
        self.assertFalse(result["effectExecuted"])
        rcall = FunctionCall(function=Function.from_callable(read), call_id="recipient-read-reject")
        result = json.loads(read(context, rcall, "account-summary", str(uuid4()), QueryFilters(channel="email")))
        self.assertEqual(result["state"], "invalid-request")
        self.assertEqual(len(node.calls), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
