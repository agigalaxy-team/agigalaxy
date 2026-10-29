import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from galaxy_model_gateway.surface import PrivateSurface


class RunCorrelation(unittest.TestCase):
    def test_header_validated_removed_and_logged_only_as_run_id(self):
        async def exercise(extra):
            captured, sent, logs = [], [], []
            async def native(scope, receive, send):
                captured.append((scope['headers'], json.loads((await receive())['body'])))
                await send({'type':'http.response.start','status':200,'headers':[(b'content-type',b'application/json')]})
                await send({'type':'http.response.body','body':b'{"choices":[{"finish_reason":"stop","message":{"content":"ok"}}]}'})
            app = PrivateSurface(native, SimpleNamespace(service_key='k', config_version='v'),
                [{'model_name':'galaxy-test','litellm_params':{'model':'fake'}}])
            headers = [(b'authorization',b'Bearer k'),(b'x-galaxy-model-scenario',b'overview'),
                (b'x-galaxy-model-config-version',b'v')] + extra
            scope = {'type':'http','path':'/v1/chat/completions','method':'POST','query_string':b'', 'headers':headers}
            async def receive():
                return {'type':'http.request','body':b'{"model":"galaxy-test","messages":[]}', 'more_body':False}
            async def send(value): sent.append(value)
            with patch('galaxy_model_gateway.output.emit', side_effect=logs.append):
                await app(scope, receive, send)
            return captured, sent, logs
        captured, sent, logs = asyncio.run(exercise([(b'x-galaxy-native-run-id',b'run_123')]))
        self.assertEqual(sent[0]['status'],200)
        self.assertFalse(any(k.lower()==b'x-galaxy-native-run-id' for k,_ in captured[0][0]))
        self.assertNotIn('run_123',json.dumps(captured[0][1]))
        self.assertEqual([r['nativeRunId'] for r in logs],['run_123','run_123'])
        for bad in [[(b'x-galaxy-native-run-id',b'bad value')], [(b'x-galaxy-native-run-id',b'a'),(b'x-galaxy-native-run-id',b'b')]]:
            captured, sent, _ = asyncio.run(exercise(bad))
            self.assertEqual(sent[0]['status'],400)
            self.assertEqual(captured,[])
        captured, sent, logs = asyncio.run(exercise([]))
        self.assertEqual(sent[0]['status'],200)
        self.assertIsNone(logs[0]['nativeRunId'])
