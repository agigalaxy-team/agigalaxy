"""New optional-vs-clearing null regression; actual native model serialization."""
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
        self.calls.append({"name": name, "arguments": arguments, "context": context})
        return {"state": "prepared", "effectExecuted": False}


class PreparedNullabilityContract(unittest.TestCase):
    def test_optional_nulls_are_omitted_while_real_clear_intents_survive(self):
        target = str(uuid4())
        adapter = TypeAdapter(PreparedOperation)
        node = RecordingNode()
        prepare = conversation_tools(node)[-1]
        context = RunContext(run_id=str(uuid4()), session_id=str(uuid4()),
            user_id="conversation:" + str(uuid4()), metadata={"operationId": str(uuid4())})
        call = FunctionCall(function=Function.from_callable(prepare), call_id="optional-clearing-null")
        values = [
            {"kind": "content-visibility", "targetKind": "post", "targetId": target,
                "action": "restore", "until": None, "reason": "合成恢复原因"},
            {"kind": "section-visibility", "targetId": target,
                "action": "restore", "until": None, "reason": "合成恢复原因"},
            {"kind": "resource-visibility", "targetKind": "projects", "targetId": target,
                "action": "restore", "until": None, "reason": "合成恢复原因"},
            {"kind": "content-curation", "targetKind": "post", "targetId": target,
                "topic": None, "pinned": None, "featured": None, "tagIds": None, "reason": "合成清除分类"},
            {"kind": "content-curation", "targetKind": "reply", "targetId": target,
                "pinned": False, "featured": None, "reason": "合成取消置顶"},
            {"kind": "feedback-update", "targetId": target, "category": None,
                "module": None, "state": None, "note": None},
            {"kind": "feedback-update", "targetId": target, "state": "processing", "module": None},
            {"kind": "case-resolve", "targetId": target, "resolution": "dismissed",
                "summary": "合成复核说明", "restrictionAction": None, "hideUntil": None},
            {"kind": "case-resolve", "targetId": target, "resolution": "accepted",
                "summary": "合成复核说明", "restrictionAction": "release", "hideUntil": None},
        ]
        for value in values:
            result = json.loads(prepare(context, call, adapter.validate_python(value)))
            self.assertEqual(result["state"], "prepared")
            self.assertFalse(result["effectExecuted"])
            self.assertFalse(result["preparationFeedback"]["mayClaimPrepared"])
            sent = node.calls[-1]
            self.assertEqual(sent["name"], "prepare-operation")
            self.assertEqual(sent["context"], {"run_id": context.run_id, "call_id": call.call_id,
                "session_id": context.session_id, "turn_id": context.metadata["operationId"]})
            actual = sent["arguments"]
            expected = {name: item for name, item in value.items()
                if item is not None or name in {"topic", "category"}}
            self.assertEqual(actual, expected)
        self.assertIsNone(node.calls[3]["arguments"]["topic"])
        self.assertIs(node.calls[4]["arguments"]["pinned"], False)
        self.assertIsNone(node.calls[5]["arguments"]["category"])
        for value in [
            {"kind": "content-curation", "targetKind": "post", "targetId": target,
                "pinned": None, "reason": "并无实际修改"},
            {"kind": "feedback-update", "targetId": target, "module": None, "note": None},
            {"kind": "content-visibility", "targetKind": "post", "targetId": target,
                "action": "hide", "until": None, "reason": "并无明确期限"},
        ]:
            with self.assertRaises(ValidationError):
                adapter.validate_python(value)
        self.assertEqual(len(node.calls), len(values))
        # Exact synthetic transport arguments are consumed by a separate local
        # check against the real current Node/Zod schemas; no business executes.
        print("NODE_PREPARED_CONTRACT=" + json.dumps([row["arguments"] for row in node.calls]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
