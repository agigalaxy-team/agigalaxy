"""Real Agno/OpenAI SSE, current contract transport and native SQLite; no provider."""
import base64
import copy
from dataclasses import dataclass
import hashlib
import inspect
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from uuid import UUID, uuid4

from agno.agent import Agent
from agno.db.sqlite import SqliteDb
from agno.models.base import Model
from agno.models.message import Message
from agno.models.openai.chat import OpenAIChat
from agno.models.response import ToolExecution
from agno.run.agent import RunOutput
from agno.run.base import RunStatus
from agno.run.requirement import RunRequirement
from agno.session.agent import AgentSession
from openai.types.chat.chat_completion_chunk import ChoiceDeltaToolCall
import httpx

from galaxy_agentos.conversation_storage import conversation_database, conversation_storage_fields
from galaxy_agentos.conversations import conversation_agents
from galaxy_agentos.duty_continuation import call_reference, continuation_tools, rehydrate_paused
from galaxy_agentos.duty_storage import duty_database
from galaxy_agentos.gateway import GalaxyGateway, AuthorityDenied
from galaxy_agentos.model_profiles import RuntimeProfile, native_model
from galaxy_agentos.read_model import metadata, run_detail
from galaxy_agentos.tool_call_ids import conversation_call_reference, valid_provider_tool_call_id


@dataclass
class NeverInvokedModel(Model):
    id: str = 'explicit-synthetic-no-run'
    def invoke(self,*args,**kwargs): raise AssertionError('fixture construction only')
    async def ainvoke(self,*args,**kwargs): return self.invoke(*args,**kwargs)
    def invoke_stream(self,*args,**kwargs):
        self.invoke(*args,**kwargs);yield
    async def ainvoke_stream(self,*args,**kwargs):
        self.invoke(*args,**kwargs);yield
    def _parse_provider_response(self,response,**kwargs): return response
    def _parse_provider_response_delta(self,response): return response


def signature_id(length):
    size={1139:837,4423:3300}[length]
    signature=base64.b64encode(bytes(index%251 for index in range(size))).decode()
    value='call_1234567__thought__'+signature
    assert len(value)==length
    return value,signature


def sse(delta,finish=None):
    return b'data: '+json.dumps({'id':'chatcmpl-explicit-local','object':'chat.completion.chunk','created':1,
        'model':'explicit-local','choices':[{'index':0,'delta':delta,'finish_reason':finish}]}).encode()+b'\n\n'


class ProviderReferenceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        node=os.environ.get('GALAXY_NODE_BINARY','node')
        cls.node=subprocess.Popen([node,str(Path(__file__).with_name('node_provider_reference_fixture.mjs'))],
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,creationflags=0x08000000 if os.name=='nt'else 0)
        first=cls.node.stdout.readline()
        if not first:
            raise AssertionError('Node fixture did not start: '+cls.node.stderr.read()[:2000])
        cls.node_info=json.loads(first);cls.url='http://127.0.0.1:'+str(cls.node_info['port'])+'/'
    @classmethod
    def tearDownClass(cls):
        cls.node.terminate();cls.node.wait(timeout=15)
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.db=SqliteDb(db_file=str(Path(self.temp.name)/'sdk.db'),id='provider-reference-fixture')
        self.addCleanup(self.db.db_engine.dispose)
        self.gateway=GalaxyGateway(SimpleNamespace(authority_url=self.url,service_key='explicit-local-synthetic-key'))
        self.addCleanup(self.gateway.close)
    def inspect_node(self):
        with httpx.Client(trust_env=False)as client:return client.get(self.url+'inspection').json()
    def test_reference_is_deterministic_run_bound_and_never_trusts_uuid_or_extra_marker(self):
        raw,_=signature_id(1139);run=str(uuid4());other=str(uuid4())
        first=conversation_call_reference(run,raw)
        self.assertEqual(str(UUID(first)),first)
        self.assertEqual(first,conversation_call_reference(run,raw))
        self.assertNotEqual(first,conversation_call_reference(other,raw))
        self.assertNotEqual(first,conversation_call_reference(run,raw+'x'))
        self.assertNotEqual(first,conversation_call_reference(run,first))
        self.assertIsNone(conversation_call_reference(None,raw))
        self.assertTrue(valid_provider_tool_call_id('x'*16384))
        for invalid in ('x'*16385,'x y','x\n','银河',None):self.assertFalse(valid_provider_tool_call_id(invalid))
        forged={'run_id':run,'tools':[{'tool_call_id':first,'tool_name':'current_summary','call_reference_kind':'galaxy-conversation-reference-v1'}]}
        self.assertIsNone(conversation_storage_fields(forged,reference_ids=True)['tools'][0]['tool_call_id'])
        missing=conversation_storage_fields({'tools':[{'tool_call_id':raw,'tool_name':'current_summary'}]},reference_ids=True)
        self.assertIsNone(missing['tools'][0]['tool_call_id'])
    def test_repeated_sse_id_delta_is_not_accumulated_by_actual_sdk(self):
        # Fixed installed SDK source was hash-matched to the running image.
        self.assertEqual(hashlib.sha256(inspect.getsource(OpenAIChat._format_all_messages).encode()).hexdigest(),
            'ab0499e7c3ade277b3bf318efd6ffd263cbdabb76658529b966794dbc588afb7')
        raw='call_123456'
        deltas=[ChoiceDeltaToolCall(index=0,id=raw,type='function',function={'name':'current_summary','arguments':'{}'})]
        deltas.extend(ChoiceDeltaToolCall(index=0,id=raw,function={'arguments':''})for _ in range(103))
        parsed=OpenAIChat.parse_tool_calls(deltas)
        self.assertEqual(parsed[0]['id'],raw)
        self.assertEqual(len(parsed[0]['id']),11)
        self.assertEqual(parsed[0]['function']['arguments'],'{}')
    def test_real_sdk_two_http_requests_echo_complete_signature_gateway_sends_short_ref_and_reload_is_idempotent(self):
        for length in (1139,4423):
            with self.subTest(length=length):
                raw,signature=signature_id(length);requests=[]
                def provider(request):
                    payload=json.loads(request.content);requests.append(payload)
                    if len(requests)==1:
                        body=sse({'role':'assistant','tool_calls':[{'index':0,'id':raw,'type':'function','function':{'name':'current_summary','arguments':'{}'}}]})
                        body+=sse({'tool_calls':[{'index':0,'id':raw,'function':{'arguments':''}}]})
                        body+=sse({},'tool_calls')+b'data: [DONE]\n\n'
                    else:body=sse({'role':'assistant','content':'explicit local complete'})+sse({},'stop')+b'data: [DONE]\n\n'
                    return httpx.Response(200,headers={'content-type':'text/event-stream'},content=body)
                profile=RuntimeProfile('gemini',100000,1000,None,30,True,False)
                model=native_model(profile,alias='explicit-local',base_url='http://127.0.0.1:1/v1',api_key='synthetic',headers={})
                model.http_client=httpx.Client(transport=httpx.MockTransport(provider),trust_env=False)
                self.addCleanup(model.http_client.close)
                factory=conversation_agents(settings=SimpleNamespace(),db=self.db,gateway=self.gateway,
                    domains={'overview':'synthetic'},active_domains={'overview'},model_factory=NeverInvokedModel)[0]
                adapter=conversation_database(self.db)
                agent=Agent(id='galaxy-conversation-overview',model=model,tools=[factory.tools[0]],db=adapter,
                    store_events=True,store_tool_messages=False,markdown=False)
                session,conversation,operation=[str(uuid4())for _ in range(3)]
                list(agent.run('explicit local summary fixture',user_id='conversation:'+conversation,session_id=session,
                    metadata={'operationId':operation},stream=True,stream_intermediate_steps=True))
                self.assertEqual(len(requests),2)
                outgoing=requests[1]['messages']
                assistant=next(item for item in outgoing if item.get('tool_calls'))
                result=next(item for item in outgoing if item.get('role')=='tool')
                self.assertEqual(assistant['tool_calls'][0]['id'],raw)
                self.assertEqual(result['tool_call_id'],raw)
                self.assertEqual(raw.split('__thought__',1)[1],signature)
                node=self.inspect_node();row=next(item for item in reversed(node['rows'])if item['native_run_id']not in getattr(self,'previous_runs',set()))
                run=row['native_run_id'];ref=conversation_call_reference(run,raw)
                self.assertEqual(row['call_id'],ref);self.assertEqual(row['id_length'],36)
                original=self.db.get_run(run_id=run,deserialize=False)
                self.assertEqual(original['run_data']['tools'][0]['tool_call_id'],ref)
                self.assertNotIn(raw,json.dumps(original));self.assertNotIn(signature,json.dumps(original))
                for event in original['run_data'].get('events')or[]:
                    if event.get('tool'):self.assertEqual(event['tool']['tool_call_id'],ref)
                restored=RunOutput.from_dict(copy.deepcopy(original['run_data']));adapter.upsert_run(restored,session_id=session,user_id='conversation:'+conversation)
                again=self.db.get_run(run_id=run,deserialize=False)
                self.assertEqual(again['run_data']['tools'][0]['tool_call_id'],ref)
                projected=conversation_storage_fields(original['run_data'],reference_ids=True)
                self.assertIsNone(projected['tools'][0]['tool_call_id'])
                # Retrying sends the same bounded reference. The current Go conversation
                # tests own durable bind/ledger replay; this fixture records transport only.
                self.gateway.conversation_summary('conversation:'+conversation,run_id=run,call_id=raw,session_id=session,turn_id=operation)
                after=self.inspect_node();retried=[item for item in after['rows'] if item['native_run_id']==run]
                self.assertEqual(len(retried),2)
                self.assertEqual([item['call_id'] for item in retried],[ref,ref])
                self.assertEqual(after['boundary'],'current-shared-call-id-schema; durable-ledger-owned-by-Go')
                self.assertLessEqual(after['maxLength'],200)
                self.previous_runs={item['native_run_id']for item in after['rows']}
    def test_duty_private_sdk_pause_and_continuation_keep_original_coordinate_public_views_do_not(self):
        for length in (1139,4423):
            raw,_=signature_id(length);task,session,run,operation=[str(uuid4())for _ in range(4)]
            execution=ToolExecution(tool_name='execute_operation',tool_call_id=raw,tool_args={'private':'discard'},external_execution_required=True)
            paused=RunOutput(run_id=run,agent_id='galaxy-duty',session_id=session,user_id='autonomy:'+task,
                status=RunStatus.paused,tools=[execution],requirements=[RunRequirement(tool_execution=execution)],metadata={'taskId':task})
            self.db.upsert_session(AgentSession(session_id=session,agent_id='galaxy-duty',user_id='autonomy:'+task))
            duty=duty_database(self.db,SimpleNamespace(duty_report=lambda *args,**kwargs:None))
            duty.upsert_run(paused,session_id=session,user_id='autonomy:'+task)
            stored=self.db.get_run(run_id=run,deserialize=False)
            self.assertEqual(stored['run_data']['tools'][0]['tool_call_id'],raw)
            self.assertEqual(stored['run_data']['requirements'][0]['tool_execution']['tool_call_id'],raw)
            restored=RunOutput.from_dict(stored['run_data'])
            reference=call_reference(task,run,raw)
            fact={'taskId':task,'sessionId':session,'continuation':{'allowed':True,'decisions':[{'callId':reference,
                'operationId':operation,'state':'completed','basis':'persisted-domain-operation-receipt'}]}}
            resolved=continuation_tools(fact,restored)
            self.assertEqual(resolved[0]['tool_call_id'],raw)
            continued=rehydrate_paused(restored,task=fact,instructions=['explicit local'],tools=resolved)
            self.assertEqual(continued.requirements[0].tool_execution.tool_call_id,raw)
            self.assertEqual(continued.messages[-1].tool_calls[0]['id'],raw)
            self.assertEqual(call_reference(task,run,raw),reference)
            self.assertNotIn(raw,json.dumps(metadata(stored)))
            self.assertNotIn(raw,json.dumps(run_detail(self.db,run)))
    def test_db_cas_run_context_and_historical_short_rows_are_not_guessed_or_migrated(self):
        class FakeDb:
            id='explicit-db-spy'
            def get_run(self,**kwargs):return None
            def update_run_in_session(self,*args,fields,**kwargs):self.saved=fields;return True
            def upsert_run(self,*args,**kwargs):pass
            def append_run_to_session_if_absent(self,*args,run_dict,**kwargs):self.saved=run_dict;return True
        db=FakeDb();adapter=conversation_database(db);run=str(uuid4());raw,_=signature_id(1139)
        fields={'tools':[{'tool_call_id':raw,'tool_name':'current_summary'}]}
        adapter.update_run_in_session(str(uuid4()),run,fields=fields)
        self.assertEqual(db.saved['tools'][0]['tool_call_id'],conversation_call_reference(run,raw))
        adapter.update_run_in_session(session_id=str(uuid4()),run_id=run,fields=fields)
        self.assertEqual(db.saved['tools'][0]['tool_call_id'],conversation_call_reference(run,raw))
        adapter.update_run_in_session(fields=fields)
        self.assertIsNone(db.saved['tools'][0]['tool_call_id'])
        old={'run_id':str(uuid4()),'agent_id':'galaxy-conversation-overview','session_id':str(uuid4()),'status':'COMPLETED',
            'tools':[{'tool_call_id':'call_historical_short','tool_name':'current_summary'}]}
        self.db.upsert_session(AgentSession(session_id=old['session_id'],agent_id=old['agent_id']))
        self.db.upsert_run(old,session_id=old['session_id']);before=self.db.get_run(run_id=old['run_id'],deserialize=False)
        conversation_database(self.db)
        self.assertEqual(self.db.get_run(run_id=old['run_id'],deserialize=False),before)


if __name__=='__main__':unittest.main()
