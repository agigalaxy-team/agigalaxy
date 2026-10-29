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
        logs, _, rejected = self.inspect(event({'error': {'type': 'PRIVATE_CANARY', 'status': 'PRIVATE_CANARY', 'code': 'PRIVATE_CANARY'}}))
        self.assertTrue(rejected)
        self.assertEqual((logs[0]['errorType'], logs[0]['errorStatus'], logs[0]['errorCode']), ('unknown', 'unknown', 'unknown'))
        self.assertNotIn('PRIVATE_CANARY', repr(logs))


if __name__ == '__main__':
    unittest.main()
