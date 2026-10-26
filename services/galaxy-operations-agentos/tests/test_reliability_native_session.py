"""Actual Agno session/tool/stream machinery with explicit local model/authority.

No provider calls, production identities, private data or business mutations.
"""
import json
import tempfile
from contextlib import ExitStack
from galaxy_agentos.tool_call_ids import conversation_call_reference
import unittest
from dataclasses import dataclass, field
from pathlib import Path
from uuid import uuid4
from agno.db.sqlite import SqliteDb
from agno.models.base import Model
from agno.models.response import ModelResponse
from galaxy_agentos.config import Settings
from galaxy_agentos.conversations import conversation_agents
from agno.os.authz.provider import AuthorizationContext
from agno.run.authorization import RunAuthorization, authorization_scope
from galaxy_agentos.authorization import GalaxyAuthorization


@dataclass
class LocalSequence(Model):
    id: str = 'explicit-local-reliability-model'
    name: str = 'LocalOnly'
    provider: str = 'ExplicitSynthetic'
    calls: int = 0
    observed: list = field(default_factory=list)
    def invoke(self, messages, **kwargs):
        self.calls+=1
        self.observed.extend(message for message in messages if message.role=='tool')
        plan=[('current_summary',{}),('query_operations',{'module':'not-a-module','view':'overview'}),
            ('query_operations',{'module':'search','view':'overview','days':'30'})]
        if self.calls<=len(plan):
            name,args=plan[self.calls-1]
            return ModelResponse(role='assistant',tool_calls=[{'id':'call_native_'+str(self.calls)+'__thought__'+'aB1+/_='*100,
                'type':'function','function':{'name':name,'arguments':json.dumps(args)}}])
        return ModelResponse(role='assistant',content='|事项|状态|\n|---|---|\n|只读查询|已核实|')
    async def ainvoke(self,*args,**kwargs):return self.invoke(*args,**kwargs)
    def invoke_stream(self,*args,**kwargs):yield self.invoke(*args,**kwargs)
    async def ainvoke_stream(self,*args,**kwargs):yield self.invoke(*args,**kwargs)
    def _parse_provider_response(self,response,**kwargs):return response
    def _parse_provider_response_delta(self,response):return response


class NativeReliability(unittest.TestCase):
    def test_signed_tool_continuation_argument_recovery_history_and_storage_projection(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as resources:
            db=SqliteDb(db_file=str(Path(directory)/'session.db'),id='explicit-local-reliability')
            resources.callback(db.db_engine.dispose)
            session=str(uuid4());conversation=str(uuid4());calls=[]
            class Gateway:
                def authorize(self,user,**kwargs):
                    return {'allowed':True,'execution':{'id':conversation,'sessionId':session,'domain':'overview','mode':'conversation'}}
                def conversation_summary(self,user,**binding):
                    calls.append(('summary',{},binding));return {'availability':'available','counts':{}}
                def conversation_tool(self,user,tool,arguments,**binding):
                    calls.append((tool,arguments,binding));return {'availability':'available','data':{'observed':True}}
            settings=Settings(database_url='postgresql+psycopg://unused.invalid/check',authority_url='http://127.0.0.1:1/',
                service_key='explicit-local-service-key-not-production',verification_key='explicit-local-signing-key-not-production')
            model=LocalSequence()
            gateway=Gateway()
            agent=conversation_agents(settings=settings,db=db,gateway=gateway,domains={'overview':'总控'},active_domains={'overview'},model_factory=lambda:model)[0]
            authorization=RunAuthorization(provider=GalaxyAuthorization(gateway),context=AuthorizationContext(principal_id='conversation:'+conversation),enforce_tools=False)
            with authorization_scope(lambda:authorization):
                run=agent.run('核对当前摘要和最近30天搜索概况。',user_id='conversation:'+conversation,session_id=session,metadata={'operationId':str(uuid4())})
            self.assertEqual([item[0] for item in calls],['summary','query-operations'])
            self.assertEqual(calls[-1][1],{'module':'search','view':'overview','filters':{'days':30}})
            self.assertTrue(any('invalid-request' in str(message.content) for message in model.observed))
            self.assertTrue(all('__thought__' in message.tool_call_id for message in model.observed))
            stored=db.get_run(run_id=run.run_id,deserialize=False)['run_data']
            self.assertNotIn('__thought__',json.dumps(stored));self.assertEqual(len(stored['tools']),3)
            self.assertEqual({item['tool_call_id'] for item in stored['tools']}, {conversation_call_reference(run.run_id, 'call_native_'+str(i)+'__thought__'+'aB1+/_='*100) for i in range(1,4)})
            # Streaming completion uses the same native adapter, history and
            # account binding, without activating any durable queue.
            with authorization_scope(lambda:authorization):
                events=list(agent.run('继续，保留表格。',user_id='conversation:'+conversation,session_id=session,
                    metadata={'operationId':str(uuid4())},stream=True,stream_events=True))
            self.assertTrue(any(event.event=='RunCompleted' for event in events))


if __name__=='__main__':unittest.main()
