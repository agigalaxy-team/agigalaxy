import json
from pathlib import Path
import unittest

from agno.tools.function import Function
from galaxy_agentos.conversation_tool_contracts import StrategyDraft
from galaxy_agentos.conversation_tools import conversation_tools
from galaxy_agentos.p13_configuration import _SCHEMA


def find_draft(value):
    if isinstance(value, dict):
        if value.get("properties", {}).get("kind", {}).get("const") == "strategy-draft":
            return value
        for item in value.values():
            found = find_draft(item)
            if found:
                return found
    if isinstance(value, list):
        for item in value:
            found = find_draft(item)
            if found:
                return found
    return None


class P13ConfigurationSchemaTest(unittest.TestCase):
    def test_native_tool_exposes_full_configuration_shape_and_roundtrips(self):
        candidate = json.loads((Path(__file__).parent / "fixtures" / "p13_configuration.json").read_text(encoding="utf-8"))
        draft = StrategyDraft(kind="strategy-draft", configuration=candidate, reason="review the controlled template")
        self.assertEqual(draft.model_dump(mode="json", exclude_unset=True)["configuration"], candidate)
        prepare = next(tool for tool in conversation_tools(object()) if tool.__name__ == "prepare_operation")
        native = Function.from_callable(prepare)
        native.process_entrypoint()
        schema = find_draft(native.parameters)["properties"]["configuration"]
        # Pydantic adds its model-facing property title; all generated
        # validation-bearing content must otherwise remain byte-for-byte equal.
        self.assertEqual(schema.get("title"), "Configuration")
        self.assertEqual({key: value for key, value in schema.items() if key != "title"}, _SCHEMA)
        self.assertEqual(set(schema["properties"]), {"common", "domains", "strategies"})
        strategy = schema["properties"]["strategies"]["items"]["properties"]
        self.assertIn("condition", strategy)
        self.assertIn("recovery", strategy)
        self.assertIn("canCreate", strategy["ordinaryBounds"]["anyOf"][0]["properties"])
        execution = strategy["execution"]["anyOf"][0]["properties"]
        self.assertTrue({"actions", "grantIds", "resourceScope", "trigger"} <= set(execution))
        self.assertNotIn('"$ref"', json.dumps(schema))


if __name__ == "__main__":
    unittest.main()
