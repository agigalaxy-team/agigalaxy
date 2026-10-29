import unittest
from pydantic import TypeAdapter, ValidationError
from galaxy_agentos.conversation_tool_contracts import DutyPreparedOperation, PreparedOperation, _prepared_arguments
from galaxy_agentos.duties import duty_tools


def find_branch(value, kind):
    if isinstance(value, dict):
        if value.get("properties", {}).get("kind", {}).get("const") == kind:
            return value
        for child in value.values():
            found = find_branch(child, kind)
            if found:
                return found
    if isinstance(value, list):
        for child in value:
            found = find_branch(child, kind)
            if found:
                return found
    return None


class OrdinaryCreateContract(unittest.TestCase):
    def test_actual_duty_sdk_explains_source_revision_and_internal_preview(self):
        native = duty_tools(object(), {"execute-operation"})[0]
        native.process_entrypoint()
        create = find_branch(native.parameters, "ordinary-strategy-create-draft")
        publish = find_branch(native.parameters, "ordinary-strategy-publish")
        self.assertIsNotNone(create)
        self.assertIsNotNone(publish)
        revision = create["properties"]["expectedRevision"]["description"]
        self.assertIn("strategy head policyRevision", revision)
        self.assertIn("not the autonomous task configRevision", revision.replace("never the", "not the"))
        self.assertIn("not newStrategyId", publish["properties"]["strategyId"]["description"])
        self.assertIn("same task's original creation receipt", publish["properties"]["versionId"]["description"])
        self.assertIn("separate generic strategy rehearsal is not needed", " ".join(publish["description"].split()))
        self.assertEqual(set(publish["required"]), {"kind", "strategyId", "versionId"})

    def test_duty_only_closed_template_request(self):
        item = {"kind": "ordinary-strategy-create-draft", "sourceStrategyId": "11111111-1111-4111-8111-111111111111", "sourceVersionId": "22222222-2222-4222-8222-222222222222", "expectedRevision": 9, "name": "日常策略", "reason": "沿用已批准范围", "parameterEdits": [{"path": [0], "value": 10}]}
        operation = TypeAdapter(DutyPreparedOperation).validate_python(item)
        self.assertEqual(_prepared_arguments(operation), item)
        with self.assertRaises(ValidationError): TypeAdapter(PreparedOperation).validate_python(item)
        with self.assertRaises(ValidationError): TypeAdapter(DutyPreparedOperation).validate_python({**item, "ordinaryBounds": {"canCreate": True}})
        with self.assertRaises(ValidationError): TypeAdapter(DutyPreparedOperation).validate_python({**item, "sourceVersionId": "bad"})


if __name__ == "__main__": unittest.main()
