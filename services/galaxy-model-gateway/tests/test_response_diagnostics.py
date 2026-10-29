import asyncio
import json
import unittest
from unittest.mock import patch

from galaxy_model_gateway.response_guard import ResponseGuard


def event(value):
    return b'data: ' + json.dumps(value).encode() + b'\n\n'


async def run(parts):
    sent, rejected = [], []
    async def send(message): sent.append(message)
    async def reject(): rejected.append(True)
    guard = ResponseGuard(send, stream=True, responses=False, version='v1',
        rejected=reject, call_id='fixture-call')
    await guard.send({'type': 'http.response.start', 'status': 200,
        'headers': [(b'content-type', b'text/event-stream')]})
    for index, part in enumerate(parts):
        await guard.send({'type': 'http.response.body', 'body': part, 'more_body': index < len(parts)-1})
    await guard.complete()
    return sent, rejected


class ResponseDiagnostics(unittest.TestCase):
    def inspect(self, body):
        logs = []
        with patch('galaxy_model_gateway.output.emit', side_effect=logs.append):
            sent, rejected = asyncio.run(run([body[:19], body[19:]]))
        return logs, sent, rejected

    def test_fragmented_tool_calls_finish_with_counts_only(self):
        body = event({'choices': [{'delta': {'tool_calls': [{'index': 0, 'function': {'name': 'PRIVATE_NAME'}}]}, 'finish_reason': None}]})
        body += event({'choices': [{'delta': {'tool_calls': [{'index': 0, 'function': {'arguments': 'PRIVATE_ARGUMENT'}}]}, 'finish_reason': None}]})
        body += event({'choices': [{'delta': {}, 'finish_reason': 'tool_calls'}]}) + b'data: [DONE]\n\n'
        logs, sent, rejected = self.inspect(body)
        self.assertFalse(rejected)
        self.assertEqual(b''.join(row.get('body', b'') for row in sent), body)
        self.assertEqual(logs[0]['event'], 'model-response-completed')
        self.assertEqual((logs[0]['frameCount'], logs[0]['choiceCount'], logs[0]['toolDeltaCount']), (4, 3, 2))
        self.assertEqual(logs[0]['chatFinishReason'], 'tool_calls')
        self.assertTrue(logs[0]['sawDone'])
        self.assertNotIn('PRIVATE_', repr(logs))

    def test_missing_finish_and_length_remain_distinct_without_changing_acceptance(self):
        first = event({'choices': [{'delta': {'content': 'PRIVATE_CONTENT'}, 'finish_reason': None}]})
        for reason in (None, 'length'):
            body = first + (event({'choices': [{'delta': {}, 'finish_reason': reason}]}) if reason else b'') + b'data: [DONE]\n\n'
            logs, _, rejected = self.inspect(body)
            self.assertEqual(bool(rejected), reason is None)
            self.assertEqual(logs[0]['event'], 'model-response-rejected' if reason is None else 'model-response-completed')
            self.assertEqual(logs[0]['chatFinishReason'], reason or 'none')
            self.assertTrue(logs[0]['useful'])
            self.assertTrue(logs[0]['sawDone'])
            self.assertEqual(logs[0]['jsonParse'], 'ok')
            self.assertNotIn('PRIVATE_', repr(logs))

    def test_error_frame_exposes_only_closed_metadata(self):
        body = event({'error': {'type': 'rate_limit_error', 'status': 'RESOURCE_EXHAUSTED',
            'code': 429, 'message': 'PRIVATE_CANARY'}})
        logs, _, rejected = self.inspect(body)
        self.assertTrue(rejected)
        self.assertEqual((logs[0]['errorPresent'], logs[0]['errorShape'], logs[0]['errorType'],
            logs[0]['errorStatus'], logs[0]['errorCode']), (True, 'object', 'rate_limit_error', 'RESOURCE_EXHAUSTED', 429))
        self.assertNotIn('PRIVATE_CANARY', repr(logs))

    def test_http_status_normalization_remains_closed_and_rejects_error_frame(self):
        for value, expected in [('503', 503), ('429', 429), (599, 599),
                (True, 'unknown'), (503.0, 'unknown'), (' 503', 'unknown'),
                ('５０３', 'unknown'), ('0503', 'unknown'), ('+503', 'unknown'),
                ('503 PRIVATE_CANARY', 'unknown'), (None, 'unknown')]:
            with self.subTest(value=value):
                logs, _, rejected = self.inspect(event({'error': {'code': value, 'status': value,
                    'message': 'PRIVATE_CANARY'}}))
                self.assertTrue(rejected)
                self.assertEqual(logs[0]['event'], 'model-response-rejected')
                self.assertEqual((logs[0]['errorCode'], logs[0]['errorStatus']), (expected, expected))
                self.assertNotIn('PRIVATE_CANARY', repr(logs))
        logs, _, rejected = self.inspect(event({'error': {'type': 'PRIVATE_CANARY', 'status': 'PRIVATE_CANARY', 'code': 'PRIVATE_CANARY'}}))
        self.assertTrue(rejected)
        self.assertEqual((logs[0]['errorType'], logs[0]['errorStatus'], logs[0]['errorCode']), ('unknown', 'unknown', 'unknown'))
        self.assertNotIn('PRIVATE_CANARY', repr(logs))

    def test_only_empty_503_frame_becomes_gateway_transient(self):
        role = event({'choices':[{'delta':{'role':'assistant'},'finish_reason':None}]})
        failed = event({'error':{'code':'503','message':'PRIVATE_CANARY'}})
        with patch('galaxy_model_gateway.metadata.gateway_failure_for', return_value={'category':'service-unavailable','httpStatus':503,'reportedStatus':503}), patch('galaxy_model_gateway.metadata.provider_failure_for', return_value={}):
            logs, sent, rejected = self.inspect(role + failed)
        self.assertTrue(rejected)
        self.assertEqual(sent[0]['status'], 503)
        body = json.loads(sent[-1]['body'])['error']
        self.assertEqual(body, {'code':'model_gateway_transient_failure','source':'model-gateway','status':503,'category':'service-unavailable','outputStarted':False})
        self.assertNotIn('PRIVATE_CANARY', repr(logs)+repr(sent))
        with patch('galaxy_model_gateway.metadata.gateway_failure_for', return_value={'category':'context-limit','httpStatus':503}), patch('galaxy_model_gateway.metadata.provider_failure_for', return_value={}):
            _, sent, _ = self.inspect(failed)
        self.assertEqual(sent[0]['status'], 502)
        for extra in ({'status':'RESOURCE_EXHAUSTED'}, {'status':'INVALID_ARGUMENT'},
                {'type':'invalid_request_error'}, {'type':'authentication_error'}, {'status':'429'}):
            with patch('galaxy_model_gateway.metadata.gateway_failure_for', return_value={}), patch('galaxy_model_gateway.metadata.provider_failure_for', return_value={}):
                _, sent, _ = self.inspect(event({'error':{'code':'503', **extra}}))
            self.assertEqual(sent[0]['status'], 502)
        for first in [event({'choices':[{'delta':{'content':'PRIVATE_CONTENT'},'finish_reason':None}]}),
                event({'choices':[{'delta':{'tool_calls':[{'index':0}]},'finish_reason':None}]})]:
            with patch('galaxy_model_gateway.metadata.gateway_failure_for', return_value={}), patch('galaxy_model_gateway.metadata.provider_failure_for', return_value={}):
                _, sent, _ = self.inspect(first + failed)
            self.assertEqual(sent[0]['status'], 200)
            self.assertNotIn(b'model_gateway_transient_failure', b''.join(x.get('body',b'') for x in sent))


if __name__ == '__main__':
    unittest.main()
