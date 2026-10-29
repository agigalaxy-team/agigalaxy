import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from agno.exceptions import ModelProviderError
from agno.models.message import Message

from galaxy_agentos.gateway import AuthorityDenied
from galaxy_agentos.model_gate import with_current_authority
from galaxy_agentos.model_failover import with_model_failover
from galaxy_agentos.model_usage import _RUN
from galaxy_agentos.provider_retry import with_provider_retry


def rejected(status, source='provider'):
    cause = RuntimeError('private provider body')
    cause.body = {'error': {'code': 'model_gateway_request_failed', 'source': source}}
    error = ModelProviderError('closed', status_code=status, model_name='test', model_id='test')
    error.__cause__ = cause
    return error


def gateway_rejected(**changes):
    value = {'code':'model_gateway_transient_failure','source':'model-gateway','status':503,
        'category':'service-unavailable','outputStarted':False}
    value.update(changes)
    cause = RuntimeError('private body')
    cause.body = {'error':value}
    error = ModelProviderError('closed', status_code=503, model_name='test', model_id='test')
    error.__cause__ = cause
    return error


def gateway_empty(**changes):
    value = {'code':'model_gateway_empty_completion','source':'model-gateway','status':502,
        'category':'empty-completion','outputStarted':False}
    value.update(changes)
    cause = RuntimeError('private body')
    cause.body = {'error':value}
    error = ModelProviderError('closed', status_code=502, model_name='test', model_id='test')
    error.__cause__ = cause
    return error


class Model:
    def __init__(self, results, name='galaxy-test'):
        self.id, self.results, self.calls = name, list(results), 0
    def invoke(self, *args, **kwargs):
        self.calls += 1
        result = self.results.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result
    async def ainvoke(self, *args, **kwargs):
        return self.invoke(*args, **kwargs)
    def invoke_stream(self, *args, **kwargs):
        value = self.invoke(*args, **kwargs)
        for item in value:
            if isinstance(item, BaseException):
                raise item
            yield item
    async def ainvoke_stream(self, *args, **kwargs):
        for value in self.invoke_stream(*args, **kwargs):
            yield value
    def response(self, *args, **kwargs):
        return self.invoke(*args, **kwargs)
    async def aresponse(self, *args, **kwargs):
        return await self.ainvoke(*args, **kwargs)
    def response_stream(self, *args, **kwargs):
        yield from self.invoke_stream(*args, **kwargs)
    async def aresponse_stream(self, *args, **kwargs):
        async for chunk in self.ainvoke_stream(*args, **kwargs):
            yield chunk


class ProviderRetry(unittest.TestCase):
    @patch('galaxy_agentos.provider_retry.time.sleep')
    def test_gateway_transient_is_one_same_model_retry_only(self, _sleep):
        model = with_provider_retry(Model([gateway_rejected(), 'ok']))
        run = SimpleNamespace(metadata={}, run_id='run')
        self.assertEqual(model.invoke(messages=[], run_response=run), 'ok')
        self.assertEqual(model.calls, 2)
        self.assertEqual(run.metadata['modelProviderRetry']['sources'], ['model-gateway'])
        direct = gateway_rejected()
        direct.__cause__.body = direct.__cause__.body['error']
        model = with_provider_retry(Model([direct, 'ok']))
        self.assertEqual(model.invoke(messages=[]), 'ok')
        self.assertEqual(model.calls, 2)
        second = gateway_rejected()
        model = with_provider_retry(Model([gateway_rejected(), second]))
        with self.assertRaises(ModelProviderError) as caught: model.invoke(messages=[])
        self.assertIs(caught.exception, second)
        self.assertEqual(model.calls, 2)
        for error in [gateway_rejected(category='context-limit'), gateway_rejected(outputStarted=True),
                gateway_rejected(status=502), rejected(500, 'model-gateway')]:
            model = with_provider_retry(Model([error]))
            with self.assertRaises(ModelProviderError): model.invoke(messages=[])
            self.assertEqual(model.calls, 1)
        model = with_provider_retry(Model([['fragment', gateway_rejected()], ['unexpected']]))
        stream = model.invoke_stream(messages=[])
        self.assertEqual(next(stream), 'fragment')
        with self.assertRaises(ModelProviderError): next(stream)
        self.assertEqual(model.calls, 1)

    @patch('galaxy_agentos.provider_retry.time.sleep')
    def test_retry_rechecks_authority_and_counts_real_calls(self, sleep):
        model = Model([rejected(500), 'ok'])
        gateway = SimpleNamespace(authorize=lambda *a, **k: {})
        current = SimpleNamespace(context=SimpleNamespace(principal_id='local'))
        run = SimpleNamespace(metadata={}, run_id='run')
        with patch('galaxy_agentos.model_gate.current_authorization', return_value=current):
            model = with_provider_retry(with_current_authority(model, gateway))
            token = _RUN.set(run)
            try:
                self.assertEqual(model.invoke(messages=[]), 'ok')
            finally:
                _RUN.reset(token)
        self.assertEqual(model.calls, 2)
        self.assertEqual(run.metadata['modelCalls'], 2)
        self.assertEqual(run.metadata['modelProviderRetry'], {'attempts': 2, 'statuses': [500], 'sources': ['provider']})
        sleep.assert_called_once_with(0.25)

    @patch('galaxy_agentos.provider_retry.time.sleep')
    def test_second_failure_is_original_second_request_and_denials_are_not_retried(self, _sleep):
        first, second = rejected(500), rejected(503)
        run = SimpleNamespace(metadata={}, run_id='run')
        model = with_provider_retry(Model([first, second]))
        with self.assertRaises(ModelProviderError) as caught:
            model.invoke(messages=[], run_response=run)
        self.assertIs(caught.exception, second)
        self.assertEqual(run.metadata['modelProviderRetry']['statuses'], [500, 503])
        for error in (rejected(403), rejected(500, 'model-gateway'), AuthorityDenied('closed')):
            model = with_provider_retry(Model([error]))
            with self.assertRaises(type(error)):
                model.invoke(messages=[])
            self.assertEqual(model.calls, 1)

    @patch('galaxy_agentos.provider_retry.time.sleep')
    def test_stream_never_retries_after_any_chunk(self, _sleep):
        model = with_provider_retry(Model([['', rejected(500)], ['unexpected']]))
        stream = model.invoke_stream(messages=[])
        self.assertEqual(next(stream), '')
        with self.assertRaises(ModelProviderError):
            next(stream)
        self.assertEqual(model.calls, 1)
        model = with_provider_retry(Model([rejected(429), ['ok']]))
        self.assertEqual(list(model.invoke_stream(messages=[])), ['ok'])
        self.assertEqual(model.calls, 2)

    def test_async_cancellation_does_not_retry(self):
        async def check():
            model = with_provider_retry(Model([rejected(500), 'unexpected']))
            with patch('galaxy_agentos.provider_retry.asyncio.sleep', side_effect=asyncio.CancelledError):
                with self.assertRaises(asyncio.CancelledError):
                    await model.ainvoke(messages=[])
            self.assertEqual(model.calls, 1)
        asyncio.run(check())

    @patch('galaxy_agentos.provider_retry.time.sleep')
    def test_existing_approved_fallback_order_is_preserved(self, _sleep):
        primary = with_provider_retry(Model([rejected(500), rejected(500)], 'galaxy-primary'))
        backup = with_provider_retry(Model(['ok'], 'galaxy-backup'))
        self.assertEqual(with_model_failover(primary, [backup]).invoke(messages=[]), 'ok')
        self.assertEqual((primary.calls, backup.calls), (2, 1))

    @patch('galaxy_agentos.provider_retry.time.sleep')
    def test_retry_uses_prior_tool_receipt_snapshot_without_reexecuting_tool(self, _sleep):
        class Mutating(Model):
            def invoke(self, *args, **kwargs):
                self.calls += 1
                messages = kwargs['messages']
                assistant = kwargs['assistant_message']
                if self.calls == 1:
                    messages.append({'role': 'assistant', 'content': 'partial'})
                    assistant.tool_calls = [{'id': 'partial'}]
                    raise rejected(500)
                self.observed = messages
                self.assert_clean = assistant.tool_calls is None
                assistant.tool_calls = [{'id': 'final'}]
                return 'ok'
        tool_calls = []
        def tool():
            tool_calls.append(1)
            return {'role': 'tool', 'content': 'original receipt'}
        messages = [tool()]
        assistant = Message(role='assistant')
        model = with_provider_retry(Mutating([]))
        self.assertEqual(model.invoke(messages=messages, assistant_message=assistant), 'ok')
        self.assertEqual(model.observed, [{'role': 'tool', 'content': 'original receipt'}])
        self.assertEqual(messages, [{'role': 'tool', 'content': 'original receipt'}])
        self.assertTrue(model.assert_clean)
        self.assertEqual(assistant.tool_calls, [{'id': 'final'}])
        self.assertEqual(len(tool_calls), 1)

    @patch('galaxy_agentos.provider_retry.time.sleep')
    def test_gateway_empty_only_retries_same_call_once(self, _sleep):
        model = with_provider_retry(Model([gateway_empty(), 'ok']))
        self.assertEqual(model.invoke(messages=[]), 'ok')
        self.assertEqual(model.calls, 2)
        model = with_provider_retry(Model([gateway_empty(), ['ok']]))
        self.assertEqual(list(model.invoke_stream(messages=[])), ['ok'])
        self.assertEqual(model.calls, 2)
        model = with_provider_retry(Model([['fragment', gateway_empty()], ['unexpected']]))
        stream = model.invoke_stream(messages=[])
        self.assertEqual(next(stream), 'fragment')
        with self.assertRaises(ModelProviderError): next(stream)
        self.assertEqual(model.calls, 1)
        first, second = gateway_rejected(), gateway_empty()
        model = with_provider_retry(Model([first, second, 'unexpected']))
        with self.assertRaises(ModelProviderError) as caught: model.invoke(messages=[])
        self.assertIs(caught.exception, second)
        self.assertEqual(model.calls, 2)
        conflict = gateway_empty()
        conflict.status_code = 401
        for error in [gateway_empty(outputStarted=True), gateway_empty(category='other'), gateway_empty(status=503), conflict]:
            model = with_provider_retry(Model([error, 'unexpected']))
            with self.assertRaises(ModelProviderError): model.invoke(messages=[])
            self.assertEqual(model.calls, 1)

    @patch('galaxy_agentos.provider_retry.time.sleep')
    def test_preoutput_http_502_retries_once_without_provider_failover(self, _sleep):
        error=gateway_rejected(status=502,category='service-unavailable')
        error.status_code=502
        model=with_provider_retry(Model([error,'ok']))
        self.assertEqual(model.invoke(messages=[]),'ok');self.assertEqual(model.calls,2)
        first=gateway_rejected(status=502,category='service-unavailable');first.status_code=502
        second=gateway_rejected();model=with_provider_retry(Model([first,second,'unexpected']))
        with self.assertRaises(ModelProviderError) as caught:model.invoke(messages=[])
        self.assertIs(caught.exception,second);self.assertEqual(model.calls,2)
        streamed=gateway_rejected(status=502,category='service-unavailable');streamed.status_code=502
        model=with_provider_retry(Model([['partial',streamed],['unexpected']]))
        stream=model.invoke_stream(messages=[]);self.assertEqual(next(stream),'partial')
        with self.assertRaises(ModelProviderError):next(stream)
        self.assertEqual(model.calls,1)
        mismatch=gateway_rejected(status=502,category='service-unavailable');mismatch.status_code=401
        model=with_provider_retry(Model([mismatch,'unexpected']))
        with self.assertRaises(ModelProviderError):model.invoke(messages=[])
        self.assertEqual(model.calls,1)


if __name__ == '__main__':
    unittest.main()
