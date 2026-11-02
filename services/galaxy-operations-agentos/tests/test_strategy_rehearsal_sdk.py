import unittest

from agno.tools.function import Function
from galaxy_agentos.conversation_tools import conversation_tools, preparation_tools


def find_branch(value):
    if isinstance(value, dict):
        if value.get("properties", {}).get("kind", {}).get("const") == "strategy-rehearsal":
            return value
        for child in value.values():
            found = find_branch(child)
            if found:
                return found
    if isinstance(value, list):
        for child in value:
            found = find_branch(child)
            if found:
                return found
    return None


class StrategyRehearsalSDKTest(unittest.TestCase):
    def test_native_schema_describes_real_sample_identity_and_empty_scope(self):
        prepare = preparation_tools(object(), domains=["strategy"])[0]
        native = Function.from_callable(prepare)
        native.process_entrypoint()
        rehearsal = find_branch(native.parameters)
        self.assertEqual(set(rehearsal["required"]), {"kind", "versionId", "executionIds"})
        self.assertIn("never conversation, turn", rehearsal["description"])
        self.assertIn("does not establish", " ".join(rehearsal["description"].split()))
        self.assertIn("strategy configuration version", rehearsal["properties"]["versionId"]["description"])
        samples = rehearsal["properties"]["executionIds"]
        self.assertEqual(samples["maxItems"], 200)
        self.assertIn("not conversation, turn", samples["description"])
        self.assertIn("uncovered", samples["description"])


if __name__ == "__main__":
    unittest.main()
