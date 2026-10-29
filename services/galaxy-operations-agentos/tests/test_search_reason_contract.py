"""Align the two existing search preparation members with Node's real reason."""
import json
import unittest
from uuid import uuid4

from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall
from pydantic import TypeAdapter, ValidationError

from galaxy_agentos.conversation_tools import FileScanRetry, PreparedOperation
from galaxy_agentos.conversation_tools import SearchApply, SearchRestore, ReadKind, _prepared_arguments, conversation_tools


class RecordingNode:
    def __init__(self):
        self.calls = []

    def conversation_tool(self, user_id, name, arguments, **context):
        self.calls.append((name, arguments, context))
        return {"state": "prepared", "effectExecuted": False}


class SearchReasonContract(unittest.TestCase):
    def test_search_draft_and_exact_version_read_contract(self):
        version = str(uuid4())
        settings = {"synonyms": [], "rankingMode": "relevance", "fixedConstraints": {
            "currentSource": True, "anonymousPublic": True, "withdrawnExcluded": True, "expiredExcluded": True}}
        adapter = TypeAdapter(PreparedOperation)
        create = adapter.validate_python({"kind": "search-draft-save", "settings": settings, "reason": "save"})
        self.assertEqual(_prepared_arguments(create), {"kind": "search-draft-save", "settings": settings, "reason": "save"})
        update = adapter.validate_python({"kind": "search-draft-save", "settings": settings, "reason": "save", "expectedDraftId": version})
        self.assertEqual(_prepared_arguments(update)["expectedDraftId"], version)
        self.assertEqual(TypeAdapter(ReadKind).validate_python("search-version"), "search-version")

    def test_only_search_preparation_uses_existing_trimmed_one_to_five_hundred(self):
        adapter = TypeAdapter(PreparedOperation)
        node = RecordingNode()
        prepare = next(tool for tool in conversation_tools(node) if tool.__name__ == "prepare_operation")
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
                self.assertEqual(result["state"], "prepared")
                self.assertFalse(result["effectExecuted"])
                self.assertFalse(result["preparationFeedback"]["mayClaimPrepared"])
                self.assertFalse(result["preparationFeedback"]["automaticRetry"])
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
