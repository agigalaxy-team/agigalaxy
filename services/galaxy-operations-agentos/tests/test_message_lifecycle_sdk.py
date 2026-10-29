import unittest

from agno.tools.function import Function
from galaxy_agentos.conversation_tools import conversation_tools


def branch(value, kind):
    if isinstance(value, dict):
        if value.get("properties", {}).get("kind", {}).get("const") == kind:
            return value
        for child in value.values():
            found = branch(child, kind)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = branch(child, kind)
            if found:
                return found
    return None


class MessageLifecycleSDKTest(unittest.TestCase):
    def test_real_prepare_schema_distinguishes_draft_save_and_delivery(self):
        prepare = next(tool for tool in conversation_tools(object()) if tool.__name__ == "prepare_operation")
        native = Function.from_callable(prepare)
        native.process_entrypoint()
        save = branch(native.parameters, "message-draft-save")
        state = branch(native.parameters, "messaging-state")
        self.assertEqual(set(save["required"]), {"kind", "targetId", "config"})
        self.assertIn("does not activate or deliver", save["description"])
        self.assertIn("original operation", save["description"])
        self.assertEqual(set(state["required"]), {"kind", "targetId", "action"})
        action = state["properties"]["action"]
        self.assertEqual(action["enum"], ["activate", "pause", "resume", "stop", "withdraw"])
        self.assertIn("human confirmation", action["description"])
        self.assertIn("original run and receipt", action["description"])
        self.assertIn("lifecycle", state["description"])
        self.assertIn("original operation", state["description"])


    def test_real_prepare_schema_separates_notice_from_plan(self):
        prepare = next(tool for tool in conversation_tools(object()) if tool.__name__ == "prepare_operation")
        native = Function.from_callable(prepare)
        native.process_entrypoint()
        expected = {
            "message-draft-create": {"kind", "config"},
            "message-draft-save": {"kind", "targetId", "config"},
            "notice-draft-create": {"kind", "content"},
            "notice-draft-save": {"kind", "targetId", "expectedVersion", "content"},
            "notice-state": {"kind", "targetId", "expectedVersion", "action"},
        }
        for kind, required in expected.items():
            with self.subTest(kind=kind):
                schema = branch(native.parameters, kind)
                self.assertEqual(set(schema["required"]), required)
                self.assertIn("plan", schema["description"].lower())
                self.assertIn("notice", schema["description"].lower())
        state = branch(native.parameters, "notice-state")
        self.assertEqual(state["properties"]["action"]["enum"], ["publish", "withdraw"])


if __name__ == "__main__":
    unittest.main()
