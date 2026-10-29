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

    def test_actual_native_nested_role_command_contract_is_schema_owned(self):
        prepare = next(tool for tool in conversation_tools(object()) if tool.__name__ == "prepare_operation")
        native = Function.from_callable(prepare)
        native.process_entrypoint()
        arguments = {"operation": {"kind": "ai-role-command", "command": {"kind": "role-create", "secret_extra_name": "secret_extra_value"}}}
        facts = operation_schema_feedback(native.parameters, arguments)
        self.assertEqual(set(facts["allowedCommandKinds"]), {"role-create", "role-update", "assignment-save"})
        self.assertEqual(set(facts["commandSchemas"]["role-create"]["requiredFields"]),
            {"kind", "expectedVersion", "name", "description", "enabled", "permissions", "targetAiAccountIds"})
        self.assertEqual(set(facts["commandSchemas"]["assignment-save"]["requiredFields"]),
            {"kind", "expectedVersion", "aiAccountId", "roleId", "enabled"})
        self.assertIn("id", facts["commandSchemas"]["assignment-save"]["allowedFields"])
        self.assertNotIn("managedAiAccountIds", facts["commandSchemas"]["role-create"]["allowedFields"])
        self.assertNotIn("secret_extra_name", repr(facts))
        self.assertNotIn("secret_extra_value", repr(facts))
        self.assertNotIn("commandSchemas", operation_schema_feedback(native.parameters, {"operation": {"kind": "unknown_private_kind"}}))
        self.assertNotIn("unknown_private_kind", repr(operation_schema_feedback(native.parameters, {"operation": {"kind": "unknown_private_kind"}})))

    def test_nested_ref_and_ambiguous_outer_are_safe(self):
        command = {"oneOf": [{"$ref": "#/$defs/Role"}]}
        operation = {"properties": {"kind": {"const": "outer"}, "command": command}, "required": ["kind", "command"]}
        schema = {"properties": {"operation": {"oneOf": [operation]}}, "$defs": {"Role": {"properties": {"kind": {"const": "role-create"}, "name": {}}, "required": ["kind", "name"]}}}
        facts = operation_schema_feedback(schema, {"operation": {"kind": "outer"}})
        self.assertEqual(facts["commandSchemas"]["role-create"]["requiredFields"], ["kind", "name"])
        other = {"properties": {"kind": {"const": "outer"}, "command": {"oneOf": [{"properties": {"kind": {"const": "different"}}}]}}}
        schema["properties"]["operation"]["oneOf"].append(other)
        self.assertNotIn("commandSchemas", operation_schema_feedback(schema, {"operation": {"kind": "outer"}}))

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
