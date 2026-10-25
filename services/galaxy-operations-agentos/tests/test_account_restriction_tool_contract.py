"""New account card: actual Agno/Pydantic binding, recording Node transport.

No model, provider, database, real account or business operation is involved.
"""
import json
import unittest
from uuid import uuid4

from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall
from pydantic import TypeAdapter, ValidationError

from galaxy_agentos.conversation_tools import PreparedOperation, conversation_tools


class RecordingNode:
    def __init__(self):
        self.calls = []

    def conversation_tool(self, user_id, name, arguments, **context):
        self.calls.append({"userId": user_id, "name": name,
            "arguments": arguments, "context": context})
        return {"state": "prepared", "effectExecuted": False}


class AccountRestrictionToolContract(unittest.TestCase):
    def test_explicit_account_deadline_and_human_prepare_only_keep_original_native_context(self):
        schema = TypeAdapter(PreparedOperation)
        self.assertIn("account-restriction", schema.json_schema()["discriminator"]["mapping"])
        target = str(uuid4())
        apply = {"kind": "account-restriction", "targetId": target,
            "action": "apply", "reason": "明确合成的参与限制原因",
            "until": "2030-10-24T08:00:00+08:00"}
        release = {"kind": "account-restriction", "targetId": target,
            "action": "release", "reason": "明确合成的解除原因"}
        node = RecordingNode()
        tools = conversation_tools(node)
        context = RunContext(run_id=str(uuid4()), session_id=str(uuid4()),
            user_id="conversation:"+str(uuid4()), metadata={"operationId": str(uuid4())})
        function = Function.from_callable(tools[4])
        self.assertNotIn("run_context", function.parameters["properties"])
        self.assertNotIn("fc", function.parameters["properties"])
        for index, value in enumerate([apply, release, {**release, "until": None}]):
            operation = schema.validate_python(value)
            self.assertEqual(operation.model_dump(mode="json", exclude_unset=True), value)
            call = FunctionCall(function=function, call_id="account-review-"+str(index))
            self.assertEqual(json.loads(tools[4](context, call, operation))["state"], "prepared")
            packet = node.calls[-1]
            self.assertEqual(packet["name"], "prepare-operation")
            self.assertEqual(packet["arguments"], {key: item for key, item in value.items() if key != "until" or item is not None})
            self.assertEqual(packet["context"], {"run_id": context.run_id,
                "call_id": call.call_id, "session_id": context.session_id,
                "turn_id": context.metadata["operationId"]})
        invalid = [{key: value for key, value in apply.items() if key != "until"},
            {**apply, "until": None}, {**apply, "until": "2030-10-24T08:00:00"},
            {**apply, "until": "2030-02-31T08:00:00Z"},
            {**release, "until": apply["until"]},
            {**apply, "targetId": "not-an-account"}, {**apply, "expectedRevision": 1},
            {**apply, "operatorId": str(uuid4())}, {**apply, "operationId": str(uuid4())},
            {**apply, "durationSeconds": 86400}, {**apply, "grant": {}},
            {**apply, "reason": "x"}, {**apply, "reason": "x"*2001}]
        for value in invalid:
            with self.assertRaises(ValidationError):
                schema.validate_python(value)
        self.assertEqual(len(node.calls), 3, "only valid preparations cross the transport")
        self.assertIn("never invent a duration", tools[4].__doc__)


if __name__ == "__main__":
    unittest.main(verbosity=2)
