"""Actual Agno loop and native adapters: provider failover after a tool effect."""
import json
import unittest
import httpx
from agno.agent import Agent
from galaxy_agentos.model_profiles import native_model,load_runtime_profile
from galaxy_agentos.model_failover import with_model_failover


def model(alias,api_format,transport):
    profile=load_runtime_profile({'apiFormat':api_format,'contextWindow':8192,'maxOutputTokens':512,'reasoningEffort':None,'timeoutSeconds':10,'toolCalling':True,'structuredOutput':True})
    value=native_model(profile,alias=alias,base_url='http://127.0.0.1:1/v1',api_key='explicit-local-test-only',headers={})
    value.http_client=httpx.Client(transport=httpx.MockTransport(transport))
    return value


def chat(message):
    return {'id':'chatcmpl-local','object':'chat.completion','created':1,'model':'local','choices':[{'index':0,'finish_reason':'tool_calls' if message.get('tool_calls') else 'stop','message':message}],'usage':{'prompt_tokens':5,'completion_tokens':4,'total_tokens':9}}


class NativeAgentFailover(unittest.TestCase):
    def test_streamed_provider_error_after_a_completed_tool_discards_only_the_failed_prefix(self):
        effects=[];primary_calls=[];backup_calls=[]
        def record_test()->str:
            """Record one isolated local effect and return its immutable receipt."""
            effects.append('one');return 'LOCAL-RECEIPT-73'
        def frame(delta,finish=None):return 'data: '+json.dumps({'id':'chatcmpl-local','object':'chat.completion.chunk','created':1,'model':'local','choices':[{'index':0,'delta':delta,'finish_reason':finish}]})+'\n\n'
        def transport(request):
            primary_calls.append(json.loads(request.content))
            if len(primary_calls)==1:
                data=frame({'role':'assistant','tool_calls':[{'index':0,'id':'call_stream_once','type':'function','function':{'name':'record_test','arguments':'{}'}}]})+frame({},'tool_calls')+'data: [DONE]\n\n'
            else:
                data=frame({'role':'assistant','content':'DISCARD_FAILED_PREFIX'})+'data: '+json.dumps({'error':{'code':'model_gateway_request_failed','source':'provider','status':503}})+'\n\n'
            return httpx.Response(200,headers={'content-type':'text/event-stream'},content=data.encode())
        def backup_transport(request):
            backup_calls.append(json.loads(request.content))
            data=frame({'role':'assistant','content':'LOCAL-RECEIPT-73 已核实'})+frame({},'stop')+'data: [DONE]\n\n'
            return httpx.Response(200,headers={'content-type':'text/event-stream'},content=data.encode())
        primary=model('galaxy-local-primary','openai-chat',transport);backup=model('galaxy-local-backup','openai-chat',backup_transport)
        self.addCleanup(primary.http_client.close);self.addCleanup(backup.http_client.close)
        events=list(Agent(model=with_model_failover(primary,[backup]),tools=[record_test],telemetry=False,debug_mode=False).run('Record once and inspect.',stream=True,stream_events=True))
        done=next(event for event in events if event.event=='RunCompleted')
        self.assertIn('LOCAL-RECEIPT-73',done.content);self.assertNotIn('DISCARD_FAILED_PREFIX',done.content)
        self.assertEqual(len(effects),1);self.assertEqual(len(primary_calls),2);self.assertEqual(len(backup_calls),1)
        self.assertIn('LOCAL-RECEIPT-73',json.dumps(backup_calls[0]))

    def test_tool_executes_once_and_fallback_continues_the_original_results(self):
        for target in ['openai-chat','openai-responses']:
            with self.subTest(target=target):
                effects=[];primary_calls=[];backup_calls=[]
                def record_test()->str:
                    """Record one isolated local effect and return its immutable receipt."""
                    effects.append('one');return 'LOCAL-RECEIPT-73'
                def primary_transport(request):
                    primary_calls.append(json.loads(request.content))
                    if len(primary_calls)==1:return httpx.Response(200,json=chat({'role':'assistant','content':None,'tool_calls':[{'id':'call_local_once','type':'function','function':{'name':'record_test','arguments':'{}'}}]}))
                    return httpx.Response(503,json={'error':{'code':'model_gateway_request_failed','source':'provider'}})
                def backup_transport(request):
                    payload=json.loads(request.content);backup_calls.append(payload)
                    if target=='openai-chat':return httpx.Response(200,json=chat({'role':'assistant','content':'LOCAL-RECEIPT-73 已核实'}))
                    return httpx.Response(200,json={'id':'resp_local','object':'response','created_at':1,'status':'completed','model':'local','output':[{'id':'msg_local','type':'message','status':'completed','role':'assistant','content':[{'type':'output_text','text':'LOCAL-RECEIPT-73 已核实','annotations':[]}]}],'usage':{'input_tokens':5,'output_tokens':4,'total_tokens':9}})
                primary=model('galaxy-local-primary','openai-chat',primary_transport)
                backup=model('galaxy-local-backup',target,backup_transport)
                self.addCleanup(primary.http_client.close);self.addCleanup(backup.http_client.close)
                result=Agent(model=with_model_failover(primary,[backup]),tools=[record_test],telemetry=False,debug_mode=False).run('Run record_test once and inspect its receipt.')
                self.assertIn('LOCAL-RECEIPT-73',result.content)
                self.assertEqual(len(effects),1);self.assertEqual(len(primary_calls),2);self.assertEqual(len(backup_calls),1)
                serialized=json.dumps(backup_calls[0]);self.assertIn('LOCAL-RECEIPT-73',serialized)
                if target=='openai-chat':self.assertIn('call_local_once',serialized)
                else:
                    # Native Responses assigns its own paired call IDs; the
                    # immutable business receipt stays in the tool result.
                    inputs=backup_calls[0]['input'];call=next(x for x in inputs if x.get('type')=='function_call');output=next(x for x in inputs if x.get('type')=='function_call_output')
                    self.assertEqual(call['call_id'],output['call_id'])
                self.assertEqual(result.metadata['activeModelFallbackAlias'],'galaxy-local-backup')


if __name__=='__main__':unittest.main()
