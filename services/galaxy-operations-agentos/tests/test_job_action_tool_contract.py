"""Finite job cards use native Pydantic/Agno; no model or live database."""
import json
import unittest
from uuid import uuid4

from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall
from pydantic import TypeAdapter, ValidationError
from galaxy_agentos.conversation_tools import PreparedOperation, DutyPreparedOperation, conversation_tools


class NodeRecorder:
    def __init__(self):
        self.calls = []

    def conversation_tool(self, user_id, name, arguments, **context):
        self.calls.append((name, arguments, context))
        return {"state": "prepared", "effectExecuted": False}


class JobActionToolContract(unittest.TestCase):
    def test_native_typed_preparation_never_supplies_operation_or_source_version(self):
        adapter = TypeAdapter(PreparedOperation)
        duty = TypeAdapter(DutyPreparedOperation)
        node = NodeRecorder()
        prepare = conversation_tools(node)[-1]
        context = RunContext(run_id=str(uuid4()), session_id=str(uuid4()),
            user_id="conversation:" + str(uuid4()), metadata={"operationId": str(uuid4())})
        function = Function.from_callable(prepare)
        for kind in ("job-cancel", "job-retry", "search-retry"):
            value = {"kind": kind, "targetId": str(uuid4()), "reason": "明确合成任务处理"}
            if kind != "search-retry":
                value["queue"] = "information-watch"
            typed = adapter.validate_python(value)
            duty.validate_python(value)
            call = FunctionCall(function=function, call_id="job-card-" + kind)
            result = json.loads(prepare(context, call, typed))
            self.assertEqual(node.calls[-1][0], "prepare-operation")
            self.assertEqual(node.calls[-1][1], value)
            self.assertFalse(result["effectExecuted"])
            for extra in ({"operationId": str(uuid4())}, {"expectedState": "failed"},
                          {"expectedGeneration": 7}, {"path": "/arbitrary"}):
                with self.assertRaises(ValidationError):
                    adapter.validate_python({**value, **extra})
        with self.assertRaises(ValidationError):
            adapter.validate_python({"kind": "job-retry", "targetId": str(uuid4()),
                "reason": "explicit test", "queue": "autonomy-task"})


if __name__ == "__main__":
    unittest.main()
