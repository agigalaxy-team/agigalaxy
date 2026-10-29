import unittest

from agno.tools.function import Function
from galaxy_agentos.conversation_tools import conversation_tools
from galaxy_agentos.tool_schema_feedback import operation_schema_feedback, repair_operation_alias


class ToolSchemaFeedbackTest(unittest.TestCase):
    def test_actual_native_prepare_schema_exposes_strategy_contract(self):
        prepare = next(tool for tool in conversation_tools(object()) if tool.__name__ == "prepare_operation")
        native = Function.from_callable(prepare)
        native.process_entrypoint()
        facts = operation_schema_feedback(native.parameters)
        for kind, required in {
            "strategy-draft": {"kind", "configuration", "reason"},
            "strategy-rehearsal": {"kind", "versionId", "executionIds"},
            "strategy-publish": {"kind", "versionId", "rehearsalId", "reason"},
        }.items():
            self.assertIn(kind, facts["allowedOperationKinds"])
            self.assertEqual(set(facts["operationSchemas"][kind]["requiredFields"]), required)
        repaired = repair_operation_alias({"operation": {"kind": "StrategyDraft"}}, native.parameters)
        self.assertEqual(repaired["operation"]["kind"], "strategy-draft")

    def test_ambiguous_alias_is_never_guessed(self):
        schema = {"properties": {"operation": {"oneOf": [
            {"title": "Ambiguous", "properties": {"kind": {"const": "first"}}, "required": ["kind"]},
            {"title": "Ambiguous", "properties": {"kind": {"const": "second"}}, "required": ["kind"]},
            {"$ref": "#/$defs/Third"},
        ]}}, "$defs": {"Third": {"title": "Unique", "properties": {"kind": {"const": "third"}, "targetId": {}}, "required": ["kind", "targetId"]}}}
        source = {"operation": {"kind": "Ambiguous"}}
        self.assertIs(repair_operation_alias(source, schema), source)
        self.assertEqual(repair_operation_alias({"operation": {"kind": "Third"}}, schema)["operation"]["kind"], "third")
        facts = operation_schema_feedback(schema)
        self.assertEqual(facts["allowedOperationKinds"], ["first", "second", "third"])
        self.assertEqual(facts["operationSchemas"]["third"]["requiredFields"], ["kind", "targetId"])
        self.assertNotIn("private-invalid-value", repr(facts))


if __name__ == "__main__":
    unittest.main()
