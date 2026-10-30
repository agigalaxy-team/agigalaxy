import asyncio
import unittest
from dataclasses import dataclass, field
from types import SimpleNamespace
from unittest.mock import patch

from agno.exceptions import ModelProviderError
from agno.models.message import Message
from agno.models.response import ModelResponse
from agno.agent import Agent
from agno.metrics import MessageMetrics
from agno.models.openai.chat import OpenAIChat
from agno.run.agent import RunOutput

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

def gateway_malformed(**changes):
    error = gateway_empty()
    error.__cause__.body['error'].update(code='model_gateway_malformed_tool_call', category='malformed-tool-call', **changes)
    return error

def gateway_malformed_response():
    error = gateway_empty()
    error.__cause__.body['error'].update(code='model_gateway_malformed_response', category='malformed-response')
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
    def test_native_async_stream_malformed_recovers_nonstream_tool_once_and_usage(self):
        @dataclass
        class Native(OpenAIChat):
            id: str = 'synthetic-native'
            stream_calls: int = 0
            full_calls: int = 0
            seen: list = field(default_factory=list)
            async def ainvoke_stream(self, messages, assistant_message, **kwargs):
                self.stream_calls += 1
                if self.stream_calls == 1:
                    assistant_message.content = 'discarded partial'
                    raise gateway_malformed_response()
                yield ModelResponse(content='完成')
            async def ainvoke(self, messages, assistant_message, **kwargs):
                self.full_calls += 1
                self.seen = list(messages)
                if assistant_message.content is not None:
                    raise AssertionError('failed assistant was not restored')
                return ModelResponse(role='assistant', tool_calls=[{'id':'call__thought__opaque', 'type':'function',
                    'function':{'name':'read_once', 'arguments':'{}'}}],
                    response_usage=MessageMetrics(input_tokens=17, output_tokens=5, total_tokens=22))
        calls = []
        def read_once() -> str:
            """Read once."""
            calls.append('read')
            return 'actual result'
        async def run():
            model = with_provider_retry(Native())
            agent = Agent(model=model, tools=[read_once], instructions=['原系统'], telemetry=False)
            events = [event async for event in agent.arun('原任务', stream=True, yield_run_output=True)]
            result = next(event for event in events if isinstance(event, RunOutput))
            self.assertEqual(result.status.value, 'COMPLETED')
            self.assertEqual(calls, ['read'])
            self.assertEqual((model.stream_calls, model.full_calls), (2, 1))
            self.assertTrue(any('正常文本或合法的必要工具调用' in str(m.content) for m in model.seen if m.role == 'system'))
            self.assertEqual(result.metrics.input_tokens, 17)
            self.assertEqual(result.metrics.output_tokens, 5)
            assistant = next(m for m in result.messages if m.role == 'assistant' and m.tool_calls)
            tool = next(m for m in result.messages if m.role == 'tool')
            self.assertEqual(assistant.tool_calls[0]['id'], 'call__thought__opaque')
            self.assertEqual(tool.tool_call_id, assistant.tool_calls[0]['id'])
        asyncio.run(run())

    @patch('galaxy_agentos.provider_retry.time.sleep')
    def test_malformed_retry_guidance_keeps_messages_and_never_replays_partial(self, _sleep):
        class Capture(Model):
            def __init__(self, results): super().__init__(results); self.seen=[]
            def invoke(self, *args, **kwargs):
                self.seen.append(kwargs['messages'])
                return super().invoke(*args, **kwargs)
        async def astream(model, messages): return [item async for item in model.ainvoke_stream(messages=messages)]
        for mode in ('invoke','ainvoke','invoke_stream','ainvoke_stream'):
            messages = [Message(role='system',content='原系统'), Message(role='user',content='原任务'),
                Message(role='assistant',tool_calls=[{'id':'prior', 'type':'function', 'function':{'name':'read', 'arguments':'{}'}}]),
                Message(role='tool',tool_call_id='prior',content='原结果')]
            model = with_provider_retry(Capture([gateway_malformed(), ModelResponse(content='ok') if 'stream' in mode else 'ok']))
            if mode == 'invoke': result = model.invoke(messages=messages)
            elif mode == 'ainvoke': result = asyncio.run(model.ainvoke(messages=messages))
            elif mode == 'invoke_stream': result = list(model.invoke_stream(messages=messages))
            else: result = asyncio.run(astream(model, messages))
            self.assertEqual(result[0].content if 'stream' in mode else result, 'ok')
            self.assertEqual(model.calls, 2)
            self.assertIn('工具名及参数', model.seen[1][0].content)
            self.assertEqual(messages[0].content, '原系统')
            self.assertEqual([m.role for m in model.seen[1]], ['system','user','assistant','tool'])
            self.assertEqual(model.seen[1][2].tool_calls[0]['id'], model.seen[1][3].tool_call_id)
            other = with_provider_retry(Capture([gateway_malformed_response(), ModelResponse(content='ok') if 'stream' in mode else 'ok']))
            if mode == 'invoke': result = other.invoke(messages=messages)
            elif mode == 'ainvoke': result = asyncio.run(other.ainvoke(messages=messages))
            elif mode == 'invoke_stream': result = list(other.invoke_stream(messages=messages))
            else: result = asyncio.run(astream(other, messages))
            self.assertEqual(result[0].content if 'stream' in mode else result, 'ok')
            self.assertIn('正常文本或合法的必要工具调用', other.seen[1][0].content)
            self.assertEqual(messages[0].content, '原系统')
            self.assertEqual([m.role for m in other.seen[1]], ['system','user','assistant','tool'])
            self.assertEqual(other.seen[1][2].tool_calls[0]['id'], other.seen[1][3].tool_call_id)
        model = with_provider_retry(Model([['partial', gateway_malformed()], ['unexpected']]))
        stream = model.invoke_stream(messages=[])
        self.assertEqual(next(stream), 'partial')
        with self.assertRaises(ModelProviderError): next(stream)
        self.assertEqual(model.calls, 1)
        model = with_provider_retry(Model([gateway_malformed(outputStarted=True)]))
        with self.assertRaises(ModelProviderError): model.invoke(messages=[])
        self.assertEqual(model.calls, 1)

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
