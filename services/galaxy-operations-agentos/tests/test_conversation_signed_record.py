import time
import unittest
from uuid import uuid4
import jwt
from fastapi import FastAPI
from fastapi.testclient import TestClient
from agno.run.agent import RunOutput
from agno.run.base import RunStatus
from galaxy_agentos.config import Settings
from galaxy_agentos.conversation_transport import install_conversation_transport_read
from galaxy_agentos.run_view import run_view
from galaxy_agentos.surface import PrivateSurface

class SignedRecordReadTest(unittest.TestCase):
    def test_signed_original_binding_is_read_once_without_gateway(self):
        settings=Settings(database_url='postgresql+psycopg://unused.invalid/test',authority_url='http://127.0.0.1:1/',service_key='local-service-key-not-production',verification_key='local-synthetic-signing-key-not-production')
        ident,sid,op,runid,parent,parent_run=[str(uuid4()) for _ in range(6)]; user='conversation:'+ident
        run=RunOutput(run_id=runid,agent_id='galaxy-conversation-overview',session_id=sid,user_id=user,status=RunStatus.error,content='synthetic-failure',metadata={'operationId':op,'retryOfOperationId':parent,'retryOfRunId':parent_run},regenerated_from=parent_run,forked_from_run_id=parent_run)
        class DB:
            reads=0
            override=None
            def get_run(self,*,run_id,deserialize=False):
                self.reads+=1
                if run_id != runid: return None
                if self.override is not None: return self.override
                return {'user_id':user,'session_id':sid,'agent_id':'galaxy-conversation-overview','run_data':run.to_dict()}
            def _get_table(self,**kwargs): raise AssertionError('unexpected history scan')
        class Gateway:
            def authorize(self,*args,**kwargs): raise AssertionError('no gateway during scoped record lookup')
        db=DB(); app=FastAPI(); runtime={'db':db,'gateway':Gateway()}
        install_conversation_transport_read(app,runtime,run_view); app.add_middleware(PrivateSurface,settings=settings,runtime=runtime)
        now=int(time.time()); locator={'runId':runid,'retryOfOperationId':parent,'retryOfRunId':parent_run}
        claims={'sub':user,'iss':settings.issuer,'aud':settings.audience,'iat':now,'exp':now+120,'scope':'conversation-record','sid':sid,'domain':'overview','operationId':op,'locator':locator}
        def token(patch=None,key=None):return jwt.encode({**claims,**(patch or {})},key or settings.verification_key,algorithm='HS256')
        path='/galaxy/conversations/'+ident+'/operations/'+op; headers={'Authorization':'Bearer '+token()}
        with TestClient(app,raise_server_exceptions=False) as client:
            response=client.get(path,headers=headers,params=locator)
            self.assertEqual(response.status_code,200,response.text); self.assertEqual(db.reads,1)
            self.assertEqual(response.json()['state'],'ERROR'); self.assertEqual(response.json()['operationId'],op); self.assertEqual(response.json()['runId'],runid); self.assertEqual(response.json()['readExpiresAt'],claims['exp'])
            self.assertIsNone(response.json()['native']['content'])
            pending = RunOutput(run_id=runid,agent_id='galaxy-conversation-overview',session_id=sid,user_id=user,status=RunStatus.pending).to_dict()
            db.override = {'user_id':user,'session_id':sid,'agent_id':'galaxy-conversation-overview','status':'PENDING','run_data':pending}
            result = client.get(path,headers=headers,params=locator)
            self.assertEqual(result.status_code,200,result.text)
            self.assertEqual((result.json()['runId'],result.json()['state'],result.json()['native']),(runid,'unknown',None))
            db.override['user_id'] = str(uuid4())
            self.assertEqual(client.get(path,headers=headers,params=locator).status_code,403)
            db.override['user_id'] = None
            self.assertEqual(client.get(path,headers=headers,params=locator).json()['state'],'unknown')
            db.override['status'] = 'ERROR'
            self.assertEqual(client.get(path,headers=headers,params=locator).status_code,503)
            db.override = None
            self.assertEqual(client.get(path,headers=headers,params=locator).json()['state'],'ERROR')
            for target,method,params in [(path.replace(op,str(uuid4())),'get',locator),(path,'get',{**locator,'runId':str(uuid4())}),(path,'get',{'runId':runid}),(path,'post',{}),('/health','get',{})]:
                denied=getattr(client,method)(target,headers=headers,params=params); self.assertEqual(denied.status_code,403,denied.text)
            for patch in ({'sid':str(uuid4())},{'domain':'other'},{'sub':'conversation:'+str(uuid4())},{'operationId':str(uuid4())},{'locator':{**locator,'extra':'x'}},{'exp':now-1}):
                denied=client.get(path,headers={'Authorization':'Bearer '+token(patch)},params=locator)
                self.assertEqual(denied.status_code,403,denied.text)
            self.assertEqual(client.get(path,headers={'Authorization':'Bearer '+token(key='wrong-key-longer-than-thirty-two-bytes')},params=locator).status_code,403)
            self.assertEqual(client.get('/health',headers=[('Authorization','Bearer '+token()),('Authorization','Bearer '+token())]).status_code,403)

if __name__=='__main__':unittest.main()
