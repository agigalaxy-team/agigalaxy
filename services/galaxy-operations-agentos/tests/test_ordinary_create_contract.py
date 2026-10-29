import unittest
from pydantic import TypeAdapter, ValidationError
from galaxy_agentos.conversation_tool_contracts import DutyPreparedOperation, PreparedOperation, _prepared_arguments


class OrdinaryCreateContract(unittest.TestCase):
    def test_duty_only_closed_template_request(self):
        item = {"kind": "ordinary-strategy-create-draft", "sourceStrategyId": "11111111-1111-4111-8111-111111111111", "sourceVersionId": "22222222-2222-4222-8222-222222222222", "expectedRevision": 9, "name": "日常策略", "reason": "沿用已批准范围", "parameterEdits": [{"path": [0], "value": 10}]}
        operation = TypeAdapter(DutyPreparedOperation).validate_python(item)
        self.assertEqual(_prepared_arguments(operation), item)
        with self.assertRaises(ValidationError): TypeAdapter(PreparedOperation).validate_python(item)
        with self.assertRaises(ValidationError): TypeAdapter(DutyPreparedOperation).validate_python({**item, "ordinaryBounds": {"canCreate": True}})
        with self.assertRaises(ValidationError): TypeAdapter(DutyPreparedOperation).validate_python({**item, "sourceVersionId": "bad"})


if __name__ == "__main__": unittest.main()
