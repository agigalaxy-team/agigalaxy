import unittest

from agno.tools.function import Function
from galaxy_agentos.conversation_tools import conversation_tools


def find_publish(value):
    if isinstance(value, dict):
        if value.get("properties", {}).get("kind", {}).get("const") == "strategy-publish":
            return value
        for child in value.values():
            found = find_publish(child)
            if found:
                return found
    if isinstance(value, list):
        for child in value:
            found = find_publish(child)
            if found:
                return found
    return None


class StrategyPublishReceiptSDKTest(unittest.TestCase):
    def test_native_schema_identifies_original_rehearsal_and_current_draft(self):
        prepare = next(tool for tool in conversation_tools(object()) if tool.__name__ == "prepare_operation")
        native = Function.from_callable(prepare)
        native.process_entrypoint()
        publish = find_publish(native.parameters)
        self.assertIsNotNone(publish)
        self.assertEqual(set(publish["required"]), {"kind", "versionId", "rehearsalId", "reason"})
        self.assertIn("current strategy draft configuration version ID", publish["properties"]["versionId"]["description"])
        rehearsal = publish["properties"]["rehearsalId"]["description"]
        self.assertIn("real valid original rehearsal receipt for that same version", rehearsal)
        self.assertIn("not a conversation, turn, run or card ID", rehearsal)
        self.assertIn("not current publication authority", " ".join(publish["description"].split()))


if __name__ == "__main__":
    unittest.main()
