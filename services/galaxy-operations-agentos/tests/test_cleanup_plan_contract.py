import unittest
from pydantic import TypeAdapter, ValidationError
from galaxy_agentos.conversation_tool_contracts import PreparedOperation, _prepared_arguments


class CleanupPlanContractTest(unittest.TestCase):
    def test_opaque_processing_token_is_not_stripped(self):
        token = '  ["state",1]  '
        args = {"kind": "file-cleanup-plan-create", "items": [{"kind": "forum", "id": "7f8fb2cc-c1ad-40a7-9078-d0054bf1a916", "expectedVersion": token}]}
        parsed = TypeAdapter(PreparedOperation).validate_python(args)
        self.assertEqual(_prepared_arguments(parsed)["items"][0]["expectedVersion"], token)

    def test_invalid_duplicates_are_rejected(self):
        item = {"kind": "forum", "id": "7f8fb2cc-c1ad-40a7-9078-d0054bf1a916", "expectedVersion": "token"}
        with self.assertRaises(ValidationError):
            TypeAdapter(PreparedOperation).validate_python({"kind": "file-cleanup-plan-create", "items": [item, item]})


if __name__ == "__main__":
    unittest.main()
