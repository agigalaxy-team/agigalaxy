import time
import unittest
from uuid import uuid4
import jwt
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Column, JSON, MetaData, String, Table, create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from galaxy_agentos.config import Settings
from galaxy_agentos.conversation_transport import install_conversation_transport_read
from galaxy_agentos.surface import PrivateSurface

class HistoryTextTest(unittest.TestCase):
    def test_scoped_signature_one_owned_select_and_saved_text_only(self):
        settings=Settings(database_url='postgresql+psycopg://unused.invalid/test',authority_url='http://127.0.0.1:1/',service_key='local-service-key-not-production',verification_key='local-synthetic-signing-key-not-production')
        ident,sid,run1,run2,foreign,other_session,other_domain,missing=[str(uuid4()) for _ in range(8)]
        principal='conversation:'+ident; engine=create_engine('sqlite://',connect_args={'check_same_thread':False},poolclass=StaticPool)
        self.addCleanup(engine.dispose); metadata=MetaData()
        table=Table('runs',metadata,Column('run_id',String,primary_key=True),Column('user_id',String),Column('session_id',String),Column('agent_id',String),Column('status',String),Column('run_data',JSON))
        metadata.create_all(engine)
        def row(run_id,user=principal,session=sid,agent='galaxy-conversation-overview',status='COMPLETED',**data):
            return {'run_id':run_id,'user_id':user,'session_id':session,'agent_id':agent,'status':status,'run_data':data}
        with engine.begin() as conn:
            conn.execute(table.insert(),[row(run1,input={'input_content':'原始问题'},content='已保存答复',created_at=100,events=[{'event':'RunCompleted','run_id':run1,'created_at':120}],messages=[{'role':'assistant','content':'不应替换保存正文'}]),
                row(run2,status='ERROR',input={'input_content':'失败前提问'},content='PROVIDER SECRET ERROR',created_at=200),
                row(foreign,user='conversation:'+str(uuid4()),input={'input_content':'FOREIGN SECRET'}),
                row(other_session,session=str(uuid4()),input={'input_content':'OTHER SESSION SECRET'}),
                row(other_domain,agent='galaxy-conversation-governance',input={'input_content':'OTHER DOMAIN SECRET'})])
        selects=[]
        @event.listens_for(engine,'before_cursor_execute')
        def count(conn,cursor,statement,parameters,context,executemany):
            if statement.lstrip().upper().startswith('SELECT'): selects.append(statement)
        class DB:
            Session=sessionmaker(bind=engine)
            def _get_table(self,table_type,create_table_if_not_found=False):
                self.assert_table=table_type; return table
            def get_run(self,**kwargs): raise AssertionError('exact operation reader forbidden')
            def get_runs(self,**kwargs): raise AssertionError('history scan forbidden')
        class Gateway:
            def authorize(self,*args,**kwargs): raise AssertionError('history must not contact gateway')
        app=FastAPI(); runtime={'db':DB(),'gateway':Gateway()}; install_conversation_transport_read(app,runtime,lambda _:None)
        app.add_middleware(PrivateSurface,settings=settings,runtime=runtime)
        now=int(time.time()); claims={'sub':principal,'iss':settings.issuer,'aud':settings.audience,'iat':now,'exp':now+120,'scope':'history-text','sid':sid,'domain':'overview'}
        def token(values,key=None): return jwt.encode(values,key or settings.verification_key,algorithm='HS256')
        headers={'Authorization':'Bearer '+token(claims)}; path='/galaxy/conversations/'+ident+'/history'
        with TestClient(app,raise_server_exceptions=False) as client:
            response=client.get(path,headers=headers,params=[('runId',v) for v in (run1,run2,foreign,other_session,other_domain,missing)])
            self.assertEqual(response.status_code,200,response.text); self.assertEqual(len(selects),1)
            body=response.json(); self.assertEqual((body['conversationId'],body['sessionId']),(ident,sid)); items={v['runId']:v for v in body['items']}; self.assertEqual(set(items),{run1,run2})
            self.assertEqual(items[run1],{'runId':run1,'userInput':'原始问题','content':'已保存答复','createdAt':100,'completedAt':120})
            self.assertEqual(items[run2]['userInput'],'失败前提问'); self.assertIsNone(items[run2]['content']); self.assertNotIn('SECRET',response.text)
            for patch in ({'sid':'not-uuid'},{'domain':'other'},{'sub':'conversation:'+str(uuid4())},{'exp':now-1}):
                self.assertEqual(client.get(path,headers={'Authorization':'Bearer '+token({**claims,**patch})},params={'runId':run1}).status_code,403)
            self.assertEqual(client.get(path,headers={'Authorization':'Bearer '+token(claims,'wrong-secret-at-least-32-bytes-long')},params={'runId':run1}).status_code,403)
            self.assertEqual(client.get(path,headers={'Authorization':'Bearer '+token({k:v for k,v in claims.items() if k not in {'scope','sid','domain'}})},params={'runId':run1}).status_code,403)
            for target,method in [(path,'post'),('/galaxy/conversations/'+ident,'get'),('/health','get'),('/galaxy/conversations/'+ident+'/operations/'+str(uuid4()),'get')]:
                self.assertEqual(getattr(client,method)(target,headers=headers).status_code,403)
            for params in ([],[('runId','bad/id')],[('runId',str(uuid4()))]*51,[('runId',run1),('other','x')]):
                self.assertEqual(client.get(path,headers=headers,params=params).status_code,400)

if __name__=='__main__': unittest.main()
