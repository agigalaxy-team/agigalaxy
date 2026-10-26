import asyncio
import json
import unittest
from uuid import uuid4
import httpx
from galaxy_model_gateway.metadata import logger,configure_usage
from galaxy_model_gateway.response_guard import ResponseGuard
from galaxy_model_gateway.profiles import admit_profile


class FailureProvenance(unittest.TestCase):
    def test_attested_midstream_failure_keeps_the_status_without_echoing_provider_text(self):
        async def run():
            ident=str(uuid4());events=[]
            async def send(value):events.append(value)
            async def rejected():pass
            guard=ResponseGuard(send,stream=True,responses=False,version='synthetic-v1',rejected=rejected,call_id=ident)
            await guard.send({'type':'http.response.start','status':200,'headers':[(b'content-type',b'text/event-stream')]})
            await guard.send({'type':'http.response.body','body':b'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n','more_body':True})
            logger.record({'event':'model-call','callId':ident,'state':'failed','failure':{'httpStatus':503,'providerConfirmed':True}})
            await guard.send({'type':'http.response.body','body':b'data: {"error":{"message":"PRIVATE_PROVIDER_CANARY"}}\n\n','more_body':False})
            return events
        events=asyncio.run(run());body=b''.join(row.get('body',b'') for row in events)
        self.assertEqual(events[0]['status'],200)
        self.assertIn(b'"source":"provider"',body);self.assertIn(b'"status":503',body)
        self.assertNotIn(b'PRIVATE_PROVIDER_CANARY',body);self.assertFalse(events[-1]['more_body'])

    def test_only_a_matching_native_provider_failure_attests_origin(self):
        configure_usage(None)
        async def run(known):
            ident=str(uuid4());events=[]
            if known:logger.record({'event':'model-call','callId':ident,'state':'failed','failure':{'httpStatus':403,'providerConfirmed':True}})
            async def send(value):events.append(value)
            async def rejected():pass
            guard=ResponseGuard(send,stream=False,responses=False,version='synthetic-v1',rejected=rejected,call_id=ident)
            await guard.send({'type':'http.response.start','status':403,'headers':[]})
            return json.loads(events[-1]['body'])
        self.assertEqual(asyncio.run(run(True))['error']['source'],'provider')
        self.assertEqual(asyncio.run(run(False))['error']['source'],'model-gateway')

    def test_image_and_explicit_parameters_are_admitted_only_for_declared_capabilities(self):
        profile={'apiFormat':'openai-chat','contextWindow':8192,'maxOutputTokens':512,'reasoningEffort':None,'timeoutSeconds':30,'toolCalling':True,'structuredOutput':True,'scenarios':['overview'],'imageUnderstanding':True,'parallelToolCalls':False,'verbosity':'low'}
        payload={'max_tokens':512,'parallel_tool_calls':False,'verbosity':'low','messages':[{'role':'user','content':[{'type':'text','text':'read the picture'},{'type':'image_url','image_url':{'url':'data:image/png;base64,AAAA'}}]}]}
        self.assertIs(admit_profile(dict(payload),profile,responses=False,scene='overview')['max_tokens'],512)
        with self.assertRaises(ValueError):admit_profile(dict(payload),{**profile,'imageUnderstanding':False},responses=False,scene='overview')
        with self.assertRaises(ValueError):admit_profile({**payload,'parallel_tool_calls':True},profile,responses=False,scene='overview')
        with self.assertRaises(ValueError):admit_profile({**payload,'verbosity':'high'},profile,responses=False,scene='overview')


if __name__=='__main__':unittest.main()
