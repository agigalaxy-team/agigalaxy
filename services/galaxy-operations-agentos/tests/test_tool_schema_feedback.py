import unittest
import json
from dataclasses import dataclass, field
from uuid import uuid4

from agno.agent import Agent
from agno.models.base import Model
from agno.models.response import ModelResponse
from agno.tools.function import Function
from galaxy_agentos.conversation_tools import conversation_tools
from galaxy_agentos.tool_schema_feedback import operation_schema_feedback, repair_operation_alias
from galaxy_agentos.tool_reliability import reliable_function


class ToolSchemaFeedbackTest(unittest.TestCase):
    def test_agent_corrects_invalid_tag_using_native_feedback(self):
        calls = []
        target = str(uuid4())
        class Gateway:
            def conversation_tool(self, user, name, arguments, **binding):
                calls.append((name, arguments))
                return {"state": "prepared", "card": {"state": "prepared", "cardId": str(uuid4())}}
        prepare = next(tool for tool in conversation_tools(Gateway()) if tool.__name__ == "prepare_operation")
        tool = reliable_function(prepare)
        @dataclass
        class Sequence(Model):
            id: str = "schema-feedback-test"
            name: str = "schema-feedback-test"
            provider: str = "test"
            count: int = 0
            received: list = field(default_factory=list)
            def invoke(self, messages, **kwargs):
                self.count += 1
                if self.count == 1:
                    operation = {"kind": "wrong-private-kind", "targetId": target, "action": "activate"}
                elif self.count == 2:
                    feedback = json.loads(next(m.content for m in messages if m.role == "tool"))
                    self.received.append(feedback)
                    branch = feedback["operationSchemas"]["messaging-state"]
                    assert "activate" in branch["fieldSchemas"]["action"]["enum"]
                    assert branch["fieldSchemas"]["targetId"]["format"] == "uuid"
                    operation = {"kind": "messaging-state", "targetId": target, "action": "activate"}
                else:
                    return ModelResponse(role="assistant", content="done")
                return ModelResponse(role="assistant", tool_calls=[{"id": "call_" + str(self.count), "type": "function", "function": {"name": "prepare_operation", "arguments": json.dumps({"operation":operation})}}])
            async def ainvoke(self, *args, **kwargs): return self.invoke(*args, **kwargs)
            def invoke_stream(self, *args, **kwargs): yield self.invoke(*args, **kwargs)
            async def ainvoke_stream(self, *args, **kwargs): yield self.invoke(*args, **kwargs)
            def _parse_provider_response(self, response, **kwargs): return response
            def _parse_provider_response_delta(self, response): return response
        model = Sequence()
        Agent(model=model, tools=[tool], telemetry=False).run("activate selected plan", user_id="conversation:"+str(uuid4()), session_id=str(uuid4()), metadata={"operationId":str(uuid4())})
        self.assertEqual(len(model.received), 1)
        self.assertNotIn("wrong-private-kind", json.dumps(model.received[0]))
        self.assertEqual(calls, [("prepare-operation", {"kind":"messaging-state", "targetId":target, "action":"activate"})])

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
        messaging = facts["operationSchemas"]["messaging-state"]
        self.assertTrue(messaging["schemaComplete"])
        self.assertEqual(messaging["fieldSchemas"]["action"]["enum"], ["activate", "pause", "resume", "stop", "withdraw"])
        self.assertEqual(messaging["fieldSchemas"]["targetId"]["format"], "uuid")

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

    def test_oversized_enum_and_conflicting_branch_are_explicitly_incomplete(self):
        first = {"properties": {"kind": {"const": "one"}, "action": {"enum": [str(i) for i in range(65)]}}, "required": ["kind", "action"]}
        first_other = {"properties": {"kind": {"const": "one"}, "other": {"type": "string"}}, "required": ["kind", "other"]}
        second = {"properties": {"kind": {"const": "two"}, "action": {"enum": [str(i) for i in range(65)]}}, "required": ["kind", "action"]}
        facts = operation_schema_feedback({"properties": {"operation": {"oneOf": [first, first_other, second]}}})
        self.assertEqual(facts["allowedOperationKinds"], ["one", "two"])
        self.assertFalse(facts["operationSchemas"]["one"]["schemaComplete"])
        self.assertFalse(facts["operationSchemas"]["two"]["schemaComplete"])
        self.assertNotIn("enum", facts["operationSchemas"]["two"]["fieldSchemas"]["action"])

    def test_schema_patterns_and_unsupported_constraints_are_honest(self):
        one = {"properties": {"kind": {"const": "one"}, "code": {"type":"string", "pattern":"^[a-z]+$"}, "amount": {"type":"number", "multipleOf":2}}, "required": ["kind", "code", "amount"]}
        two = {"properties": {"kind": {"const": "two"}, "payload": {"type":"object", "additionalProperties":{"type":"string"}}}, "required": ["kind", "payload"]}
        facts = operation_schema_feedback({"properties": {"operation": {"oneOf": [one, two]}}})
        self.assertEqual(facts["operationSchemas"]["one"]["fieldSchemas"]["code"]["pattern"], "^[a-z]+$")
        self.assertEqual(facts["operationSchemas"]["one"]["fieldSchemas"]["amount"]["multipleOf"], 2)
        self.assertTrue(facts["operationSchemas"]["one"]["schemaComplete"])
        self.assertFalse(facts["operationSchemas"]["two"]["schemaComplete"])


if __name__ == "__main__":
    unittest.main()
