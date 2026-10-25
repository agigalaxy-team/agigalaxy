"""Align the two existing search preparation members with Node's real reason."""
import json
import unittest
from uuid import uuid4

from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall
from pydantic import TypeAdapter, ValidationError

from galaxy_agentos.conversation_tools import FileScanRetry, PreparedOperation
from galaxy_agentos.conversation_tools import SearchApply, SearchRestore, conversation_tools


class RecordingNode:
    def __init__(self):
        self.calls = []

    def conversation_tool(self, user_id, name, arguments, **context):
        self.calls.append((name, arguments, context))
        return {"state": "prepared", "effectExecuted": False}


class SearchReasonContract(unittest.TestCase):
    def test_only_search_preparation_uses_existing_trimmed_one_to_five_hundred(self):
        adapter = TypeAdapter(PreparedOperation)
        node = RecordingNode()
        prepare = conversation_tools(node)[4]
        context = RunContext(run_id=str(uuid4()), session_id=str(uuid4()),
            user_id="conversation:" + str(uuid4()), metadata={"operationId": str(uuid4())})
        call = FunctionCall(function=Function.from_callable(prepare), call_id="search-reason")
        version = str(uuid4())
        for kind in ["search-apply", "search-restore"]:
            for reason in ["用", "应用", "例" * 500, "  应用  "]:
                value = {"kind": kind, "reason": reason}
                if kind == "search-restore":
                    value["versionId"] = version
                operation = adapter.validate_python(value)
                result = json.loads(prepare(context, call, operation))
                self.assertEqual(result, {"state": "prepared", "effectExecuted": False})
                expected = {**value, "reason": reason.strip()}
                self.assertEqual(node.calls[-1][0:2], ("prepare-operation", expected))
                self.assertEqual(node.calls[-1][2], {"run_id": context.run_id,
                    "call_id": call.call_id, "session_id": context.session_id,
                    "turn_id": context.metadata["operationId"]})
            for reason in ["", "  ", "例" * 501]:
                value = {"kind": kind, "reason": reason}
                if kind == "search-restore":
                    value["versionId"] = version
                with self.assertRaises(ValidationError):
                    adapter.validate_python(value)
        self.assertEqual(len(node.calls), 8)
        for model in [SearchApply, SearchRestore]:
            reason_schema = model.model_json_schema()["properties"]["reason"]
            self.assertEqual((reason_schema["minLength"], reason_schema["maxLength"]), (1, 500))
        # Other existing human operations retain their independent 3..1600 rule.
        with self.assertRaises(ValidationError):
            FileScanRetry(kind="file-scan-retry", targetKind="chat", targetId=uuid4(), reason="应用")
        self.assertEqual(FileScanRetry(kind="file-scan-retry", targetKind="chat",
            targetId=uuid4(), reason="例" * 501).reason, "例" * 501)


if __name__ == "__main__":
    unittest.main(verbosity=2)
