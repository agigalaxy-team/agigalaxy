import unittest
from uuid import uuid4

from agno.tools.function import Function, FunctionCall
from galaxy_agentos.conversation_task_operations import task_operation_tool


class TaskOperationToolTest(unittest.TestCase):
    def test_native_tool_schema_and_original_coordinates(self):
        calls = []
        def send(context, call, name, arguments):
            calls.append((context, call.call_id, name, arguments))
            return '{"receipt":{"state":"unknown"}}'

        tool = task_operation_tool(send)
        function = Function.from_callable(tool)
        self.assertEqual(function.name, "read_task_operation")
        for supported in ("file access", "account restriction", "public-case resolution"):
            self.assertIn(supported, function.description)
        self.assertEqual(set(function.parameters["required"]), {"task_id", "operation_id"})
        task, operation = uuid4(), uuid4()
        call = FunctionCall(function=function, call_id="original-call")
        self.assertIn('"unknown"', tool(None, call, task, operation))
        self.assertEqual(calls[0][2:], ("read-task-operation", {"taskId": str(task), "operationId": str(operation)}))


if __name__ == "__main__":
    unittest.main()
