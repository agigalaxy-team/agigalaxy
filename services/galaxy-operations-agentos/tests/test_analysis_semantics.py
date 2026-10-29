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
    _analysis_constraints, conversation_tools)


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
    def test_supported_window_routes_require_explicit_valid_days_and_never_choose_defaults(self):
        for (module, view), allowed in _WINDOW_DAYS.items():
            with self.subTest(module=module, view=view):
                missing = _query_filter_feedback(module, view, {})
                self.assertEqual(missing['requiredFilterKeys'], ['days'])
                self.assertEqual(missing['allowedDays'], allowed)
                self.assertFalse(missing['dataRead'])
                self.assertEqual(missing['defaultDays'], _WINDOW_DEFAULT_DAYS[(module, view)])
                for invalid in (0, 91, True, None):
                    self.assertIsNotNone(_query_filter_feedback(module, view, {'days': invalid}))
                valid = {'days': allowed[0]}
                if view == 'account':
                    valid['accountId'] = str(uuid4())
                self.assertIsNone(_query_filter_feedback(module, view, valid))
        for module, view in [('maintenance', 'logs'), ('recommendations', 'history'), ('content', 'sections')]:
            self.assertIsNone(_query_filter_feedback(module, view, {}))

    def test_constraints_preserve_original_zero_unknown_samples_rates_period_and_fields(self):
        original = {'availability': 'available', 'data': {'period': {'days': 30}, 'count': 0,
            'retention': None, 'samples': 529, 'ctr': 1, 'other': ['original']}, 'coverage': {'complete': False}}
        before = deepcopy(original)
        result = _analysis_constraints(original, module='recommendations', view='overview', filters={'days': 7})
        self.assertEqual(original, before)
        self.assertEqual({key: result[key] for key in original}, before)
        self.assertEqual(result['analysisConstraints']['requestedDays'], 7)
        self.assertEqual(result['data']['period']['days'], 30)
        self.assertIn('null/unknown', ''.join(result['analysisConstraints']['rules']))
        self.assertNotIn('inferredCause', json.dumps(result))

    def test_real_sdk_query_missing_days_never_calls_gateway_and_explicit_window_preserves_actual_period(self):
        gateway = Gateway({'state': 'available', 'data': {'period': {'days': 30}, 'count': 0}})
        tool = conversation_tools(gateway, domain='discovery')[0]
        rejected = execute(tool, {'module': 'recommendations', 'view': 'overview'})
        self.assertEqual(rejected['reason'], 'agentos_query_window_required')
        self.assertEqual(gateway.calls, [])
        actual = execute(tool, {'module': 'recommendations', 'view': 'overview', 'filters': {'days': 7}})
        self.assertEqual(gateway.calls[0][1]['filters'], {'days': 7})
        self.assertEqual(actual['data']['period']['days'], 30)
        self.assertEqual(actual['analysisConstraints']['requestedDays'], 7)
        self.assertEqual(len(gateway.calls), 1)

    def test_real_sdk_maintenance_log_result_has_exact_normalizer_constraint(self):
        original = {'state': 'available', 'data': {'items': [{'event': 'runtime_event_rejected', 'code': 'other_error'}]}}
        gateway = Gateway(original)
        value = execute(conversation_tools(gateway, domain='maintenance')[0], {'module': 'maintenance', 'view': 'logs'})
        self.assertEqual(value['data'], original['data'])
        self.assertIn('非事件名allowlist', value['analysisConstraints']['runtimeEventMeanings']['runtime_event_rejected'])
        self.assertEqual(len(gateway.calls), 1)

    def test_real_sdk_feedback_restore_omits_unrequested_note_but_preserves_explicit_note(self):
        gateway = Gateway({'state': 'prepared', 'card': {'state': 'prepared', 'cardId': str(uuid4())}})
        tool = conversation_tools(gateway, domain='overview')[-1]
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

    def test_default_metadata_does_not_fill_days_or_request_a_user_choice(self):
        self.assertEqual(set(_WINDOW_DEFAULT_DAYS), set(_WINDOW_DAYS))
        for (module, view), default in _WINDOW_DEFAULT_DAYS.items():
            original = {}
            feedback = _query_filter_feedback(module, view, original)
            self.assertEqual(original, {})
            self.assertEqual(feedback['defaultDays'], default)
            self.assertIn(default, feedback['allowedDays'])
            self.assertEqual(feedback['reason'], 'agentos_query_window_required')
            self.assertIn('无需追问', feedback['explanation'])
            self.assertFalse(feedback['dataRead'])


if __name__ == '__main__':
    unittest.main()
