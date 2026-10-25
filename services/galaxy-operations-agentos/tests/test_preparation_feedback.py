"""Closed receipt feedback and actual SDK function execution; no model."""
from copy import deepcopy
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall
from galaxy_agentos.conversation_tools import _preparation_feedback, conversation_tools


class PreparationFeedbackTests(unittest.TestCase):
    def check(self, original, expected, prepared):
        before = deepcopy(original)
        result = _preparation_feedback(original)
        self.assertEqual(original, before)
        self.assertEqual({key: result[key] for key in original}, before)
        self.assertEqual(result['preparationFeedback']['state'], expected)
        self.assertIs(result['preparationFeedback']['cardPrepared'], prepared)
        self.assertFalse(result['preparationFeedback']['automaticRetry'])
        self.assertEqual(result['preparationFeedback']['businessEffect'], 'not-proven-by-preparation')
        return result

    def test_actual_card_contract_and_no_top_level_id_guess(self):
        self.check({'state': 'prepared', 'card': {'state': 'prepared', 'cardId': str(uuid4())}}, 'prepared', True)
        for value in ({'state': 'prepared', 'cardId': str(uuid4())}, {'state': 'prepared', 'card': {'state': 'prepared'}},
                {'state': 'prepared', 'card': {'state': 'prepared', 'cardId': 'fake'}},
                {'state': 'prepared', 'card': {'state': 'unknown', 'cardId': str(uuid4())}}):
            self.check(value, 'unknown', None)

    def test_no_change_and_generic_gateway_refusal_are_not_prepared(self):
        result = self.check({'state': 'unavailable', 'code': 'operations_ai_prompt_no_change'}, 'not-prepared', False)
        self.assertEqual(result['preparationFeedback']['nextStep'], 'explain-no-change-needed')
        result = self.check({'state': 'invalid-request', 'reason': 'agentos_tool_arguments_invalid', 'nextStep': 'correct-arguments', 'effectState': 'not-confirmed'}, 'not-prepared', False)
        self.assertEqual(result['preparationFeedback']['nextStep'], 'explain-original-refusal')
        self.assertNotIn('operations_ai_prompt_no_change', json.dumps(result))

    def test_unknown_processing_and_old_completed_never_manufacture_effects(self):
        for state in ('unknown', 'processing'):
            result = self.check({'state': state, 'operationId': str(uuid4()), 'effectExecuted': True}, state, None)
            self.assertEqual(result['preparationFeedback']['nextStep'], 'query-original-operation')
            self.assertTrue(result['effectExecuted'])
        self.check({'state': 'completed', 'card': {'state': 'completed', 'cardId': str(uuid4())}, 'effectExecuted': True}, 'original-receipt-required', False)

    def test_real_agno_function_call_returns_augmented_original_receipt_once(self):
        class Gateway:
            calls = 0
            def conversation_tool(self, user_id, name, arguments, **binding):
                self.calls += 1
                return {'state': 'invalid-request', 'reason': 'agentos_tool_arguments_invalid', 'effectState': 'not-confirmed'}
        gateway = Gateway()
        entrypoint = conversation_tools(gateway, domain='overview')[-1]
        function = Function.from_callable(entrypoint)
        function.process_entrypoint()
        function._run_context = RunContext(run_id=str(uuid4()), user_id='conversation:' + str(uuid4()),
            session_id=str(uuid4()), metadata={'operationId': str(uuid4())})
        call = FunctionCall(function=function, call_id='explicit-local-call', arguments={'operation': {
            'kind': 'ai-work-prompt-save', 'aiAccountId': str(uuid4()), 'prompt': 'explicit local prompt'}})
        self.assertTrue(call.execute())
        result = json.loads(call.result)
        self.assertEqual(result['state'], 'invalid-request')
        self.assertEqual(result['reason'], 'agentos_tool_arguments_invalid')
        self.assertEqual(result['preparationFeedback']['state'], 'not-prepared')
        self.assertFalse(result['preparationFeedback']['mayClaimPrepared'])
        self.assertEqual(gateway.calls, 1)

    def test_local_source_refusal_has_same_closed_feedback_without_gateway_request(self):
        class Gateway:
            def conversation_tool(self, *args, **kwargs):
                raise AssertionError('a local source rejection must not call Gateway')
        tool = conversation_tools(Gateway(), domain='overview')[-1]
        function = Function.from_callable(tool)
        function.process_entrypoint()
        function._run_context = RunContext(run_id=str(uuid4()), user_id='conversation:' + str(uuid4()),
            session_id=str(uuid4()), metadata={'operationId': str(uuid4())})
        call = FunctionCall(function=function, call_id='explicit-local-call', arguments={'operation': {
            'kind': 'ai-work-prompt-save', 'aiAccountId': str(uuid4()), 'prompt': 'explicit local prompt'}})
        original = {'state': 'invalid-request', 'reason': 'agentos_public_reference_mismatch', 'effectState': 'not-confirmed'}
        with patch('galaxy_agentos.conversation_tools.tool_public_reference', return_value=(None, original)):
            self.assertTrue(call.execute())
        result = json.loads(call.result)
        self.assertEqual(result['reason'], original['reason'])
        self.assertEqual(result['preparationFeedback']['state'], 'not-prepared')


if __name__ == '__main__':
    unittest.main()
