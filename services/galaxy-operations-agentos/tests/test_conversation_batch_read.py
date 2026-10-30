import base64
import json
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
from galaxy_agentos.gateway import AuthorityDenied
from galaxy_agentos.surface import PrivateSurface

class BatchReadTest(unittest.TestCase):
    def test_batch_exact_binding_validation_and_revocation(self):
        settings=Settings(database_url='postgresql+psycopg://unused.invalid/test',authority_url='http://127.0.0.1:1/',
            service_key='synthetic-service-key-not-production',verification_key='synthetic-signing-key-not-production-at-least-32')
        ident,session,op1,op2,parent,run1,run2=[str(uuid4()) for _ in range(7)]
        principal='conversation:'+ident; row={'id':ident,'sessionId':session,'domain':'overview','mode':'conversation'}
        class Gateway:
            calls=0; revoked=False
            def authorize(self,user,**kwargs):
                self.calls+=1
                if self.revoked or user!=principal: raise AuthorityDenied()
                return {'allowed':True,'execution':row,'readExpiresAt':123456}
        gateway=Gateway()
        def record(ident,operation,**extra):
            result=RunOutput(run_id=ident,user_id=principal,session_id=session,agent_id='galaxy-conversation-overview',
                status=RunStatus.completed,content='owned synthetic response',metadata={'operationId':operation,**extra})
            if extra:
                result.regenerated_from=extra['retryOfRunId']; result.forked_from_run_id=extra['retryOfRunId']
            return {'user_id':principal,'session_id':session,'agent_id':'galaxy-conversation-overview','run_data':result.to_dict()}
        stored={run1:record(run1,op1),run2:record(run2,op2,retryOfOperationId=parent,retryOfRunId=run1)}
        class DB:
            revoke_on=None
            def get_run(self,*,run_id,deserialize=False):
                if run_id==self.revoke_on: gateway.revoked=True
                return stored.get(run_id)
            def _get_table(self,**kwargs): raise AssertionError('exact locators cannot scan')
        db=DB(); app=FastAPI(); runtime={'gateway':gateway,'db':db}
        install_conversation_transport_read(app,runtime,lambda output:{'runId':output.run_id,'content':output.content})
        app.add_middleware(PrivateSurface,settings=settings,runtime=runtime)
        now=int(time.time()); token=jwt.encode({'sub':principal,'iat':now,'exp':now+120,'aud':settings.audience,'iss':settings.issuer},settings.verification_key,algorithm='HS256')
        headers={'Authorization':'Bearer '+token}; path='/galaxy/conversations/'+ident+'/operations'
        def encode(value):return base64.urlsafe_b64encode(json.dumps(value,separators=(',',':')).encode()).decode().rstrip('=')
        good=[{'operationId':op1,'runId':run1},{'operationId':op2,'runId':run2,'retryOfOperationId':parent,'retryOfRunId':run1}]
        with TestClient(app,raise_server_exceptions=False) as client:
            response=client.get(path,headers=headers,params={'requests':encode(good)})
            self.assertEqual(response.status_code,200,response.text); self.assertEqual(gateway.calls,2)
            body=response.json(); self.assertEqual((body['conversationId'],body['sessionId'],body['readExpiresAt']),(ident,session,123456))
            self.assertEqual([item['operationId'] for item in body['items']],[op1,op2]); self.assertTrue(all(item['state']=='COMPLETED' for item in body['items']))
            missing=str(uuid4()); response=client.get(path,headers=headers,params={'requests':encode([{'operationId':str(uuid4()),'runId':missing}])})
            self.assertEqual(response.status_code,200); self.assertEqual(response.json()['items'][0]['state'],'unknown'); self.assertEqual(response.json()['items'][0]['runId'],missing)
            invalid=[[],good+[good[0]], [{'operationId':str(uuid4())} for _ in range(11)], [{'operationId':op1,'unexpected':'x'}], [{'operationId':op1,'retryOfRunId':run1}], [{'operationId':op1,'runId':'bad/id'}], [{'operationId':'bad'}]]
            for entries in invalid:
                with self.subTest(entries=entries): self.assertEqual(client.get(path,headers=headers,params={'requests':encode(entries)}).status_code,400)
            self.assertEqual(client.get(path,headers=headers,params=[('requests',encode(good)),('requests',encode(good))]).status_code,400)
            self.assertEqual(client.get(path,headers=headers,params={'requests':'a'*12001}).status_code,400)
            duplicate=base64.urlsafe_b64encode(('[{"operationId":"'+op1+'","operationId":"'+op2+'"}]').encode()).decode().rstrip('=')
            self.assertEqual(client.get(path,headers=headers,params={'requests':duplicate}).status_code,400)
            for changed in [[good[0],{'operationId':op2,'runId':run1}], [good[0],{'operationId':op2,'runId':run2,'retryOfOperationId':str(uuid4()),'retryOfRunId':run1}]]:
                denied=client.get(path,headers=headers,params={'requests':encode(changed)})
                self.assertEqual(denied.status_code,403); self.assertNotIn('owned synthetic response',denied.text)
            self.assertEqual(client.post(path,headers=headers).status_code,403)
            db.revoke_on=run2; denied=client.get(path,headers=headers,params={'requests':encode(good)})
            self.assertEqual(denied.status_code,403); self.assertNotIn('owned synthetic response',denied.text)

if __name__=='__main__': unittest.main()
