"""Finite guards/real SDK tool calls and current shared contracts; no model."""
from copy import deepcopy
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest
from uuid import uuid4

from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall
from galaxy_agentos.conversation_tools import (_WINDOW_DAYS, _WINDOW_DEFAULT_DAYS, _query_filter_feedback,
    conversation_tools, preparation_tools)


class Gateway:
    def __init__(self, result):
        self.result, self.calls = result, []
    def conversation_tool(self, user, name, arguments, **binding):
        self.calls.append((name, deepcopy(arguments)))
        return deepcopy(self.result)


def execute(tool, arguments):
    function = Function.from_callable(tool)
    function.process_entrypoint()
    function._run_context = RunContext(run_id=str(uuid4()), session_id=str(uuid4()),
        user_id='conversation:' + str(uuid4()), metadata={'operationId': str(uuid4())})
    call = FunctionCall(function=function, call_id='explicit-local-fixture', arguments=arguments)
    assert call.execute()
    return json.loads(call.result)


class AnalysisSemanticsTests(unittest.TestCase):
    def test_window_omission_uses_service_defaults_and_invalid_values_are_rejected(self):
        for (module, view), allowed in _WINDOW_DAYS.items():
            with self.subTest(module=module, view=view):
                self.assertIsNone(_query_filter_feedback(module, view, {}))
                for invalid in (0, 91, True, None):
                    self.assertIsNotNone(_query_filter_feedback(module, view, {'days': invalid}))
                self.assertIsNone(_query_filter_feedback(module, view, {'days': allowed[0]}))

    def test_query_passes_omission_and_explicit_window_without_altering_result(self):
        original = {'state': 'available', 'data': {'period': {'days': 30}, 'count': 0, 'retention': None}}
        gateway = Gateway(original)
        tool = conversation_tools(gateway, domain='discovery')[0]
        self.assertEqual(execute(tool, {'module': 'recommendations', 'view': 'overview'}), original)
        self.assertEqual(gateway.calls[0][1]['filters'], {})
        actual = execute(tool, {'module': 'recommendations', 'view': 'overview', 'filters': {'days': 7}})
        self.assertEqual(gateway.calls[1][1]['filters'], {'days': 7})
        self.assertEqual(actual, original)

    def test_maintenance_log_result_remains_unchanged(self):
        original = {'state': 'available', 'data': {'items': [{'event': 'runtime_event_rejected', 'code': 'other_error'}]}}
        gateway = Gateway(original)
        value = execute(conversation_tools(gateway, domain='maintenance')[0], {'module': 'maintenance', 'view': 'logs'})
        self.assertEqual(value, original)
        self.assertEqual(len(gateway.calls), 1)

    def test_real_sdk_feedback_restore_omits_unrequested_note_but_preserves_explicit_note(self):
        gateway = Gateway({'state': 'prepared', 'card': {'state': 'prepared', 'cardId': str(uuid4())}})
        tool = preparation_tools(gateway, domains=['feedback_accounts'])[0]
        operation = {'kind': 'feedback-update', 'targetId': str(uuid4()), 'category': None, 'module': 'other', 'state': 'pending'}
        value = execute(tool, {'operation': operation})
        self.assertEqual(gateway.calls[0][1], operation)
        self.assertNotIn('note', gateway.calls[0][1])
        self.assertTrue(value['preparationFeedback']['cardPrepared'])
        execute(tool, {'operation': {**operation, 'note': 'explicit local requested note'}})
        self.assertEqual(gateway.calls[1][1]['note'], 'explicit local requested note')

    def test_actual_shared_query_schema_defaults(self):
        node = os.environ.get('GALAXY_NODE_BINARY') or shutil.which('node')
        self.assertIsNotNone(node, 'Install repository Node dependencies and put Node on PATH')
        result = subprocess.run([node, str(Path(__file__).with_name('node_analysis_contract_fixture.mjs'))],
            capture_output=True, text=True, timeout=25)
        self.assertEqual(result.returncode, 0, result.stderr)
        proof = json.loads(result.stdout)
        self.assertEqual(proof['windowRoutes'], len(_WINDOW_DAYS))
        self.assertTrue(proof['sharedDefaultsUnchanged'])
        self.assertEqual({(item['module'], item['view']): item['days'] for item in proof['defaultDays']}, _WINDOW_DEFAULT_DAYS)

    def test_default_metadata_matches_valid_values_without_filling_filters(self):
        self.assertEqual(set(_WINDOW_DEFAULT_DAYS), set(_WINDOW_DAYS))
        for route, default in _WINDOW_DEFAULT_DAYS.items():
            original = {}
            self.assertIsNone(_query_filter_feedback(*route, original))
            self.assertEqual(original, {})
            self.assertIn(default, _WINDOW_DAYS[route])


if __name__ == '__main__':
    unittest.main()
