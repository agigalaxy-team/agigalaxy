"""The closed proxy error envelope must retain typed timeout/rate-limit status."""
import asyncio
import json
import unittest
from galaxy_model_gateway.surface import PrivateSurface
from galaxy_model_gateway.policy import Settings

class FailureStatusSurfaceTest(unittest.TestCase):
    def test_timeout_and_rate_limit_survive_without_provider_content(self):
        key='isolated-protocol-service-key-00000000000'
        settings=Settings(service_key=key,config_version='isolated-v1')
        models=[{'model_name':'galaxy-isolated','litellm_params':{'model':'openai/not-called'}}]
        async def exchange(status):
            async def native(scope,receive,send):
                await receive()
                await send({'type':'http.response.start','status':status,'headers':[(b'x-provider-debug',b'PRIVATE_PROVIDER_CANARY')]})
                await send({'type':'http.response.body','body':b'PRIVATE_PROVIDER_CANARY','more_body':False})
            app=PrivateSurface(native,settings,models)
            messages=[]
            async def receive():
                return {'type':'http.request','body':json.dumps({'model':'galaxy-isolated','messages':[]}).encode(),'more_body':False}
            async def send(message):messages.append(message)
            await app({'type':'http','method':'POST','path':'/v1/chat/completions','query_string':b'','headers':[(b'authorization',('Bearer '+key).encode()),(b'x-galaxy-model-scenario',b'governance'),(b'x-galaxy-model-config-version',b'isolated-v1')]},receive,send)
            return messages
        for status in [408,429,529,504,503,401,418]:
            with self.subTest(status=status):
                messages=asyncio.run(exchange(status))
                self.assertEqual(messages[0]['status'],502 if status==418 else status)
                body=b''.join(message.get('body',b'') for message in messages[1:])
                categories = {408: 'timeout', 429: 'rate-limit', 529: 'rate-limit',
                              504: 'timeout', 503: 'service-unavailable'}
                expected = ({'code': 'model_gateway_transient_failure', 'source': 'model-gateway',
                             'status': status, 'category': categories[status], 'outputStarted': False}
                            if status in categories else
                            {'code': 'model_gateway_request_failed', 'source': 'model-gateway'})
                self.assertEqual(json.loads(body), {'error': expected})
                self.assertNotIn('PRIVATE_PROVIDER_CANARY',repr(messages))

if __name__=='__main__':unittest.main()
