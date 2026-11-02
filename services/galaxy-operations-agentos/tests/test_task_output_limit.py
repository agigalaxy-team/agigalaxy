"""Native Agno response boundaries preserve output-limit continuation."""
import asyncio
import json
import httpx
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

from agno.agent import Agent
from agno.exceptions import ModelProviderError
from agno.db.sqlite import SqliteDb
from agno.models.base import Model as NativeModel
from agno.models.response import ModelResponse

from galaxy_agentos.conversation_completion import with_conversation_completion
from galaxy_agentos.duty_completion import with_duty_completion


@dataclass
class NativeOutputProvider(NativeModel):
    id: str = 'local-output-limit'
    protocol: str = 'chat'
    truncated: bool = True
    calls: int = 0
    snapshots: list = field(default_factory=list)

    def packet(self, messages):
        self.calls += 1
        self.snapshots.append(list(messages))
        limited = self.truncated and self.calls == 1
        text = '前半。' if limited else '后半。'
        if self.protocol == 'chat':
            return {'text': text, 'choices': [{'finish_reason': 'length' if limited else 'stop'}]}
        return {'text': text, 'status': 'incomplete' if limited else 'completed',
                'incomplete_details': {'reason': 'max_output_tokens'} if limited else None}

    def invoke(self, messages, **kwargs):
        return self._parse_provider_response(self.packet(messages))

    async def ainvoke(self, messages, **kwargs):
        return self._parse_provider_response(self.packet(messages))

    def invoke_stream(self, messages, **kwargs):
        packet = self.packet(messages)
        yield self._parse_provider_response_delta(packet)
        # A usage-only frame cannot erase the earlier finish reason.
        yield self._parse_provider_response_delta({'choices': [], 'text': None})

    async def ainvoke_stream(self, messages, **kwargs):
        packet = self.packet(messages)
        yield self._parse_provider_response_delta(packet)
        yield self._parse_provider_response_delta({'choices': [], 'text': None})

    def _parse_provider_response(self, value, **kwargs):
        return ModelResponse(role='assistant', content=value.get('text'))

    def _parse_provider_response_delta(self, value, **kwargs):
        return ModelResponse(role='assistant', content=value.get('text'))


def provider_error():
    cause = RuntimeError('local fixture')
    cause.body = {'error': {'code': 'model_gateway_request_failed', 'source': 'provider'}}
    error = ModelProviderError('local failure', status_code=503, model_name='local', model_id='local')
    error.__cause__ = cause
    return error


@dataclass
class FailingOutputProvider(NativeOutputProvider):
    id: str = 'galaxy-primary'

    def invoke(self, messages, **kwargs):
        self._parse_provider_response(self.packet(messages))
        raise provider_error()

    async def ainvoke(self, messages, **kwargs):
        self._parse_provider_response(self.packet(messages))
        raise provider_error()

    def invoke_stream(self, messages, **kwargs):
        self._parse_provider_response_delta(self.packet(messages))
        raise provider_error()
        yield

    async def ainvoke_stream(self, messages, **kwargs):
        self._parse_provider_response_delta(self.packet(messages))
        raise provider_error()
        yield


@dataclass
class RetriedOutputProvider(NativeOutputProvider):
    id: str = 'galaxy-retry'

    def result(self, messages, stream=False):
        raw = self.packet(messages)
        value = self._parse_provider_response_delta(raw) if stream else self._parse_provider_response(raw)
        if self.calls == 1:
            raise provider_error()
        return value

    def invoke(self, messages, **kwargs): return self.result(messages)
    async def ainvoke(self, messages, **kwargs): return self.result(messages)
    def invoke_stream(self, messages, **kwargs): yield self.result(messages, stream=True)
    async def ainvoke_stream(self, messages, **kwargs): yield self.result(messages, stream=True)


class OutputLimitTests(unittest.TestCase):
    def test_native_four_paths_chat_and_responses_continue_without_repeating_user(self):
        for protocol in ('chat', 'responses'):
            for mode in ('sync', 'async', 'stream', 'astream'):
                with self.subTest(protocol=protocol, mode=mode), TemporaryDirectory() as directory:
                    records = []
                    class Gateway:
                        def conversation_tool(self, user, name, args, **binding):
                            records.append((name, args, binding))
                            return {'state': 'recorded', 'taskProgress': {'phase': args['disposition'], 'remaining': []}}
                    db = SqliteDb(db_file=str(Path(directory) / 'native.sqlite'))
                    try:
                        provider = NativeOutputProvider(protocol=protocol)
                        with_conversation_completion(provider, gateway=Gateway())
                        agent = Agent(model=provider, db=db, telemetry=False)
                        opts = {'session_id': str(uuid4()), 'user_id': 'conversation:' + str(uuid4()),
                                'metadata': {'operationId': str(uuid4())}}
                        if mode == 'sync':
                            result = agent.run('原问题', **opts); content = result.content
                        elif mode == 'async':
                            result = asyncio.run(agent.arun('原问题', **opts)); content = result.content
                        elif mode == 'stream':
                            content = ''.join(str(event.content or '') for event in agent.run('原问题', stream=True, **opts))
                        else:
                            async def collect():
                                return [event async for event in agent.arun('原问题', stream=True, **opts)]
                            content = ''.join(str(event.content or '') for event in asyncio.run(collect()))
                        self.assertEqual(provider.calls, 2)
                        self.assertIn('前半。', content)
                        self.assertIn('后半。', content)
                        self.assertEqual([entry[1]['disposition'] for entry in records], ['continue', 'completed'])
                        self.assertEqual(records[0][1]['reason'], '继续尚未输出的内容')
                        self.assertNotEqual(records[0][2]['call_id'], records[1][2]['call_id'])
                        continuation = [message for message in provider.snapshots[1] if message.name == 'galaxy_runtime_continuation']
                        self.assertEqual(len(continuation), 1)
                        self.assertIn('接着输出', continuation[0].content)
                        self.assertIn('不重复已经说过', continuation[0].content)
                        saved = db.get_runs(session_id=opts['session_id'], user_id=opts['user_id'])[0]
                        self.assertFalse(any(message.name == 'galaxy_runtime_continuation' for message in saved.messages))
                        self.assertEqual([message.content for message in saved.messages if message.role == 'user'], ['原问题'])
                    finally:
                        db.db_engine.dispose()

    def test_actual_openai_adapters_observe_raw_parser_inputs(self):
        from galaxy_agentos.model_profiles import load_runtime_profile, native_model
        for protocol in ('openai-chat', 'openai-responses'):
            for mode in ('sync', 'async', 'stream', 'astream'):
                with self.subTest(protocol=protocol, mode=mode):
                    requests = []
                    def transport(request):
                        payload = json.loads(request.content)
                        requests.append(payload)
                        limited = len(requests) == 1
                        text = '前半。' if limited else '后半。'
                        if protocol == 'openai-chat':
                            if payload.get('stream'):
                                def frame(delta, reason=None):
                                    return 'data: ' + json.dumps({'id':'chat-local', 'object':'chat.completion.chunk', 'created':1,
                                        'model':'local', 'choices':[{'index':0, 'delta':delta, 'finish_reason':reason}]}) + '\n\n'
                                usage = {'id':'chat-local','object':'chat.completion.chunk','created':1,'model':'local','choices':[],
                                         'usage':{'prompt_tokens':2,'completion_tokens':2,'total_tokens':4}}
                                data = frame({'role':'assistant', 'content':text}) + frame({}, 'length' if limited else 'stop')
                                data += 'data: ' + json.dumps(usage) + '\n\ndata: [DONE]\n\n'
                                return httpx.Response(200, headers={'content-type':'text/event-stream'}, content=data.encode())
                            return httpx.Response(200, json={'id':'chat-local','object':'chat.completion','created':1,'model':'local',
                                'choices':[{'index':0,'finish_reason':'length' if limited else 'stop','message':{'role':'assistant','content':text}}]})
                        response = {'id':'resp_local','object':'response','created_at':1,'status':'incomplete' if limited else 'completed',
                            'incomplete_details':{'reason':'max_output_tokens'} if limited else None, 'model':'local',
                            'output':[{'id':'msg_local','type':'message','status':'completed','role':'assistant',
                                       'content':[{'type':'output_text','text':text,'annotations':[]}]}],
                            'usage':{'input_tokens':2,'output_tokens':2,'total_tokens':4}}
                        if payload.get('stream'):
                            def event(value): return 'data: ' + json.dumps(value) + '\n\n'
                            data = event({'type':'response.output_text.delta','sequence_number':1,'item_id':'msg_local',
                                          'output_index':0,'content_index':0,'delta':text})
                            data += event({'type':'response.incomplete' if limited else 'response.completed',
                                           'sequence_number':2,'response':response}) + 'data: [DONE]\n\n'
                            return httpx.Response(200, headers={'content-type':'text/event-stream'}, content=data.encode())
                        return httpx.Response(200, json=response)
                    profile = load_runtime_profile({'apiFormat':protocol,'contextWindow':8192,'maxOutputTokens':512,
                        'reasoningEffort':None,'timeoutSeconds':10,'toolCalling':True,'structuredOutput':True})
                    provider = native_model(profile, alias='galaxy-local', base_url='http://127.0.0.1:1/v1',
                        api_key='explicit-local-test', headers={})
                    asynchronous = mode in ('async', 'astream')
                    provider.http_client = httpx.AsyncClient(transport=httpx.MockTransport(transport)) if asynchronous else httpx.Client(transport=httpx.MockTransport(transport))
                    with_conversation_completion(provider)
                    agent = Agent(model=provider, telemetry=False)
                    try:
                        if mode == 'sync': content = agent.run('原问题').content
                        elif mode == 'async': content = asyncio.run(agent.arun('原问题')).content
                        elif mode == 'stream': content = ''.join(str(event.content or '') for event in agent.run('原问题', stream=True))
                        else:
                            async def collect(): return [event async for event in agent.arun('原问题', stream=True)]
                            content = ''.join(str(event.content or '') for event in asyncio.run(collect()))
                        self.assertEqual(len(requests), 2)
                        self.assertIn('前半。', content)
                        self.assertIn('后半。', content)
                    finally:
                        if asynchronous: asyncio.run(provider.http_client.aclose())
                        else: provider.http_client.close()

    def test_fallback_uses_only_final_provider_finish_reason_in_all_paths(self):
        from galaxy_agentos.model_failover import with_model_failover
        for mode in ('sync', 'async', 'stream', 'astream'):
            for truncated in (False, True):
                with self.subTest(mode=mode, backup_truncated=truncated):
                    primary = FailingOutputProvider()
                    backup = NativeOutputProvider(id='galaxy-backup', truncated=truncated)
                    model = with_model_failover(primary, [backup])
                    with_conversation_completion(model)
                    agent = Agent(model=model, telemetry=False)
                    opts = {'session_id': str(uuid4()), 'user_id': 'conversation:' + str(uuid4()),
                            'metadata': {'operationId': str(uuid4())}}
                    if mode == 'sync': content = agent.run('原问题', **opts).content
                    elif mode == 'async': content = asyncio.run(agent.arun('原问题', **opts)).content
                    elif mode == 'stream': content = ''.join(str(event.content or '') for event in agent.run('原问题', stream=True, **opts))
                    else:
                        async def collect(): return [event async for event in agent.arun('原问题', stream=True, **opts)]
                        content = ''.join(str(event.content or '') for event in asyncio.run(collect()))
                    self.assertEqual(primary.calls, 1)
                    self.assertEqual(backup.calls, 2 if truncated else 1)
                    self.assertIn('后半。', content)
                    if truncated: self.assertIn('前半。', content)
                    else: self.assertNotIn('前半。', content)

    def test_same_provider_retry_discards_failed_attempt_finish_reason(self):
        from galaxy_agentos.provider_retry import with_provider_retry
        for mode in ('sync', 'async', 'stream', 'astream'):
            with self.subTest(mode=mode):
                provider = RetriedOutputProvider()
                with_provider_retry(provider)
                with_conversation_completion(provider)
                agent = Agent(model=provider, telemetry=False)
                opts = {'session_id': str(uuid4()), 'user_id': 'conversation:' + str(uuid4()),
                        'metadata': {'operationId': str(uuid4())}}
                with patch('galaxy_agentos.provider_retry.time.sleep'), patch('galaxy_agentos.provider_retry.asyncio.sleep', new=unittest.mock.AsyncMock()):
                    if mode == 'sync': content = agent.run('原问题', **opts).content
                    elif mode == 'async': content = asyncio.run(agent.arun('原问题', **opts)).content
                    elif mode == 'stream': content = ''.join(str(event.content or '') for event in agent.run('原问题', stream=True, **opts))
                    else:
                        async def collect(): return [event async for event in agent.arun('原问题', stream=True, **opts)]
                        content = ''.join(str(event.content or '') for event in asyncio.run(collect()))
                self.assertEqual(provider.calls, 2)
                self.assertEqual(content, '后半。')

    def test_duty_native_four_paths_continue_truncated_output(self):
        for mode in ('sync', 'async', 'stream', 'astream'):
            with self.subTest(mode=mode):
                class Gateway:
                    def duty_authorize(self, user, *, operation):
                        return {'task': {'completion': {'disposition': 'completed'}}}
                provider = NativeOutputProvider()
                with_duty_completion(provider, Gateway(), [], 30)
                agent = Agent(model=provider, telemetry=False)
                opts = {'session_id': str(uuid4()), 'user_id': 'autonomy:' + str(uuid4())}
                if mode == 'sync':
                    content = agent.run('原任务', **opts).content
                elif mode == 'async':
                    content = asyncio.run(agent.arun('原任务', **opts)).content
                elif mode == 'stream':
                    content = ''.join(str(event.content or '') for event in agent.run('原任务', stream=True, **opts))
                else:
                    async def collect():
                        return [event async for event in agent.arun('原任务', stream=True, **opts)]
                    content = ''.join(str(event.content or '') for event in asyncio.run(collect()))
                self.assertEqual(provider.calls, 2)
                self.assertIn('前半。', content)
                self.assertIn('后半。', content)
                self.assertTrue(any(message.name == 'galaxy_runtime_continuation' for message in provider.snapshots[1]))

    def test_normal_stop_and_real_waiting_do_not_continue(self):
        for truncated, projected_phase in ((False, 'completed'), (True, 'waiting-confirmation')):
            records = []
            class Gateway:
                def conversation_tool(self, user, name, args, **binding):
                    records.append(args)
                    return {'state': 'recorded', 'taskProgress': {'phase': projected_phase, 'remaining': []}}
            provider = NativeOutputProvider(truncated=truncated)
            with_conversation_completion(provider, gateway=Gateway())
            Agent(model=provider, telemetry=False).run('原问题', user_id='conversation:' + str(uuid4()),
                session_id=str(uuid4()), metadata={'operationId': str(uuid4())})
            self.assertEqual(provider.calls, 1)
            self.assertEqual(records[0]['disposition'], 'continue' if truncated else 'completed')

    def test_only_closed_output_limit_reasons_trigger_continuation(self):
        from galaxy_agentos.task_loop import _RESPONSE_FINISH, _observe_response, response_requires_continuation
        token = _RESPONSE_FINISH.set({'reason': None})
        try:
            for payload in ({'choices': [{'finish_reason': 'stop'}]},
                    {'choices': [{'finish_reason': 'content_filter'}]},
                    {'status': 'incomplete', 'incomplete_details': {'reason': 'content_filter'}},
                    {'status': 'completed', 'incomplete_details': {'reason': 'max_output_tokens'}}):
                _observe_response(payload)
                self.assertFalse(response_requires_continuation())
            _observe_response({'response': {'status': 'incomplete', 'incomplete_details': {'reason': 'max_output_tokens'}}})
            _observe_response({'choices': [], 'usage': {'output_tokens': 4}})
            self.assertTrue(response_requires_continuation())
        finally:
            _RESPONSE_FINISH.reset(token)

    def test_duty_observed_waiting_takes_precedence_over_truncation(self):
        class Gateway:
            def duty_authorize(self, user, *, operation):
                return {'task': {'completion': {'disposition': 'waiting-human'}}}
        with patch('galaxy_agentos.duty_completion.with_task_loop') as loop:
            with_duty_completion(object(), Gateway(), [], 30)
        decide = loop.call_args.kwargs['decide']
        with patch('galaxy_agentos.duty_completion.response_requires_continuation', return_value=True):
            self.assertEqual(decide(SimpleNamespace(user_id='autonomy:test')).state, 'waiting-human')


if __name__ == '__main__':
    unittest.main()
