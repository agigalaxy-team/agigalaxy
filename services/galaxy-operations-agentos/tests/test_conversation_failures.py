import asyncio
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest

from agno.exceptions import ModelProviderError, ModelRateLimitError, ContextWindowExceededError
from galaxy_agentos.conversation_failures import failure_view, with_conversation_failures


class ConversationFailureTest(unittest.TestCase):
    def test_01_closed_provider_error_survives_durable_string_without_changing_authority_or_success(self):
        secret = 'PRIVATE_PROVIDER_RESPONSE_OR_REQUEST'

        class Model:
            error = ModelProviderError(secret, status_code=503)
            calls = 0
            def invoke(self):
                self.calls += 1
                if self.error:
                    raise self.error
                return 'unchanged successful response'
            async def ainvoke(self):
                return self.invoke()
            def invoke_stream(self):
                yield 'already received text'
                self.invoke()
            async def ainvoke_stream(self):
                yield 'already received text'
                self.invoke()

        model = with_conversation_failures(Model())
        for error, category, status, expected_type in [
            (ModelProviderError(secret, status_code=503), 'service-unavailable', 503, ModelProviderError),
            (ModelProviderError(secret, status_code=429), 'rate-limit', 429, ModelRateLimitError),
            (ModelProviderError('maximum context length '+secret, status_code=400), 'context-limit', 400, ContextWindowExceededError),
            (ModelProviderError(secret, status_code=504), 'timeout', 504, ModelProviderError),
            (ModelProviderError(secret, status_code=401), 'request-rejected', 401, ModelProviderError),
        ]:
            with self.subTest(category=category):
                model.error = error
                before = model.calls
                for invoke in [model.invoke, lambda: asyncio.run(model.ainvoke()), lambda: list(model.invoke_stream())]:
                    with self.assertRaises(expected_type) as caught:
                        invoke()
                    self.assertNotIn(secret, str(caught.exception))
                    self.assertEqual(failure_view(str(caught.exception)), {'stage':'model-request','category':category,'reportedStatus':status})
                async def streamed():
                    return [item async for item in model.ainvoke_stream()]
                with self.assertRaises(expected_type) as caught:
                    asyncio.run(streamed())
                self.assertNotIn(secret, str(caught.exception))
                self.assertEqual(model.calls-before, 4, 'wrapper does not add retries')
        denied = PermissionError('current authority revoked')
        model.error = denied
        with self.assertRaises(PermissionError) as caught:
            model.invoke()
        self.assertIs(caught.exception, denied, 'authorization exceptions retain their original contract')
        model.error = None
        self.assertEqual(model.invoke(), 'unchanged successful response')
        self.assertIsNone(failure_view(secret))
        self.assertIsNone(failure_view('galaxy_conversation_model_failure:unknown:200'))
        self.assertIsNone(failure_view('galaxy_conversation_model_failure:unknown:503 '+secret))

        # Compile the actual pure projection without starting AgentOS or reading settings.
        source = Path(__file__).parents[1]/'src/galaxy_agentos/run_view.py'
        if not source.is_file():
            source = Path('/app/src/galaxy_agentos/run_view.py')
        tree = ast.parse(source.read_text())
        projection = ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in {'run_view','_completed_conversation_content'}], type_ignores=[])
        import math
        from galaxy_agentos.model_failover import failover_view
        from galaxy_agentos.tool_reliability import PREPARED_CARD_IDS
        namespace = {'math':math,'failure_view':failure_view,'failover_view':failover_view, 'PREPARED_CARD_IDS': PREPARED_CARD_IDS}
        exec(compile(projection, str(source), 'exec'), namespace)
        raw = SimpleNamespace(status='ERROR', content='galaxy_conversation_model_failure:rate-limit:429', agent_id='galaxy-conversation-governance', events=[], metrics=None, run_id='bound-run', metadata={'operationId':'bound-turn'}, input=None, created_at=1)
        visible = namespace['run_view'](raw)
        self.assertIsNone(visible['content'])
        self.assertEqual(visible['errorCode'], 'operations_agentos_model_request_failed')
        self.assertEqual(visible['failure'], {'stage':'model-request','category':'rate-limit','reportedStatus':429})
        raw.content = secret
        self.assertEqual(namespace['run_view'](raw)['errorCode'], 'operations_agentos_run_failed', 'old unknown failures are not reclassified')
        raw.content = 'galaxy_conversation_model_failure:rate-limit:429'
        raw.agent_id = 'galaxy-governance'
        self.assertIsNone(namespace['run_view'](raw)['failure'], 'execution/workflow errors keep their existing contract')
        raw.agent_id = 'galaxy-conversation-governance'
        raw.status = 'COMPLETED'
        self.assertEqual(namespace['run_view'](raw)['content'], raw.content)
        self.assertIsNone(namespace['run_view'](raw)['failure'])
        raw.content = '请确认操作。'
        raw.messages = [{'role':'assistant','content':'先前回复'}, {'role':'assistant','tool_calls':[{'id':'prepare'}]}]
        raw.metadata[PREPARED_CARD_IDS] = ['prepared-card-id']
        self.assertEqual(namespace['run_view'](raw)['content'], '请确认操作。')
        raw.metadata.pop(PREPARED_CARD_IDS)
        self.assertEqual(namespace['run_view'](raw)['content'], '先前回复')


if __name__ == '__main__':
    unittest.main()
