import unittest
from copy import deepcopy
from types import SimpleNamespace
from agno.models.message import Message
from galaxy_agentos.conversation_retry import _filter_source_history
from galaxy_agentos.conversation_turn_state import turn_state


class SourceHistoryTests(unittest.TestCase):
    def test_legacy_and_changed_turns_filter_only_derived_history_without_mutating_original(self):
        old = SimpleNamespace(metadata={"operationId": "old"}, messages=[Message(role="user", content="old user"), Message(role="assistant", content="old private")], content="old private")
        changed = SimpleNamespace(metadata={"operationId": "changed"}, messages=[Message(role="user", content="changed user"), Message(role="assistant", content="changed private")], content="changed private")
        new = SimpleNamespace(metadata={"operationId": "new"}, messages=[Message(role="user", content="new user"), Message(role="assistant", content="new answer")], content="new answer")
        session = SimpleNamespace(runs=[old, changed, new])
        context = SimpleNamespace(run_id="run", metadata={"operationId": "current"})
        turn_state(context)["sourceQualification"] = {"affectedTurns": ["changed"], "legacyUnknown": True, "legacySafeTurns": ["changed", "new"]}
        _filter_source_history(session, context)
        self.assertEqual([[m.content for m in run.messages] for run in session.runs], [["old user"], ["changed user"], ["new user", "new answer"]])
        self.assertEqual(old.content, "old private")
        self.assertEqual(changed.messages[-1].content, "changed private")
        self.assertTrue(turn_state(context)["_sourceHistoryRestricted"])


if __name__ == "__main__": unittest.main()
