"""Native regeneration keeps one user question and records distinct attempts."""
import json
import tempfile
import time
import unittest
from contextlib import ExitStack
from dataclasses import dataclass, field
from pathlib import Path
from uuid import uuid4
import jwt
from fastapi.testclient import TestClient
from agno.agent import Agent
from agno.db.sqlite import SqliteDb
from agno.models.base import Model
from agno.models.response import ModelResponse
from agno.exceptions import ModelProviderError
from agno.os import AgentOS, Authorization
from agno.os.authz.provider import AuthorizationContext
from agno.run.authorization import RunAuthorization, authorization_scope
from galaxy_agentos.app import PrivateSurface, run_view
from galaxy_agentos.authorization import GalaxyAuthorization
from galaxy_agentos.config import Settings
from galaxy_agentos.conversations import conversation_agents
from galaxy_agentos.conversation_failures import failure_view
from galaxy_agentos.conversation_transport import install_conversation_transport_read

@dataclass
class RecoveryModel(Model):
    id: str = "local-retry-only"
    name: str = "LocalOnly"
    provider: str = "Synthetic"
    calls: int = 0
    failures: int = 1
    failure_status: int = 503
    tool_at: int | None = None
    contexts: list = field(default_factory=list)
    def invoke(self, messages, **kwargs):
        self.calls += 1
        self.contexts.append(messages)
        if self.calls <= self.failures:
            raise ModelProviderError("local failure", status_code=self.failure_status, model_name=self.name, model_id=self.id)
        if self.calls == self.tool_at:
            return ModelResponse(role="assistant", tool_calls=[{"id":"synthetic-retry-summary", "type":"function",
                "function":{"name":"current_summary", "arguments":"{}"}}])
        return ModelResponse(role="assistant", content="已恢复这条原提问。")
    async def ainvoke(self, *a, **k): return self.invoke(*a, **k)
    def invoke_stream(self, *a, **k): yield self.invoke(*a, **k)
    async def ainvoke_stream(self, *a, **k): yield self.invoke(*a, **k)
    def _parse_provider_response(self, value, **kwargs): return value
    def _parse_provider_response_delta(self, value): return value

class ConversationRetry(unittest.TestCase):
    def test_native_http_retry_reuses_question_checks_owner_and_preserves_failure(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as cleanup:
            db = SqliteDb(db_file=str(Path(directory)/"retry.db"), id="local-retry")
            cleanup.callback(db.db_engine.dispose)
            ident, session, old_op, new_op = (str(uuid4()) for _ in range(4))
            user = "conversation:"+ident
            tool_bindings = []
            class Gateway:
                def authorize(self, principal, **kwargs):
                    return {"allowed":True,"execution":{"id":ident,"sessionId":session,"domain":"overview","mode":"conversation"}}
                def conversation_summary(self, principal, **binding):
                    tool_bindings.append({"user_id":principal, **binding})
                    return {"domain":"overview", "counts":{}, "availability":{}}
            gateway=Gateway()
            settings=Settings(database_url="postgresql+psycopg://unused.invalid/test",authority_url="http://127.0.0.1:1/",
                service_key="explicit-local-service-not-production-00001",verification_key="explicit-local-signing-not-production-00001")
            model=RecoveryModel(tool_at=2)
            agent=conversation_agents(settings=settings,db=db,gateway=gateway,domains={"overview":"总控"},active_domains={"overview"},model_factory=lambda:model)[0]
            auth=RunAuthorization(provider=GalaxyAuthorization(gateway),context=AuthorizationContext(principal_id=user),enforce_tools=False)
            with authorization_scope(lambda:auth):
                failed=agent.run("这条问题只应出现一次。",user_id=user,session_id=session,metadata={"operationId":old_op})
            self.assertEqual(str(getattr(failed.status,"value",failed.status)).upper(),"ERROR")
            failed_id = failed.run_id
            failed_snapshot = db.get_run(run_id=failed_id).to_dict()
            native=AgentOS(id="local-retry-http",db=db,agents=[agent],authorization=Authorization(
                verification_keys=[settings.verification_key],algorithm="HS256",verify_audience=True,
                audience=settings.audience,issuer=settings.issuer,authorization_provider=GalaxyAuthorization(gateway)),
                user_isolation=True,tracing=False,telemetry=False)
            app=native.get_app()
            runtime={"os":native,"db":db,"gateway":gateway,"configuredDomains":{"overview"}}
            install_conversation_transport_read(app, runtime, run_view)
            app.add_middleware(PrivateSurface,settings=settings,runtime=runtime)
            now=int(time.time())
            token=jwt.encode({"sub":user,"iat":now,"exp":now+120,"aud":settings.audience,"iss":settings.issuer},settings.verification_key,algorithm="HS256")
            headers={"Authorization":"Bearer "+token,"Idempotency-Key":new_op}
            data={"regenerate":"true","replace_original":"true","retry_of_operation_id":old_op,"session_id":session,"stream":"true","background":"true"}
            route="/agents/galaxy-conversation-overview/runs/"+failed_id+"/continue"
            with TestClient(app) as client:
                for patch in [{"session_id":str(uuid4())},{"message":"重复提问"},{"regenerate":"false"},{"retry_of_operation_id":str(uuid4())}]:
                    self.assertEqual(client.post(route,headers=headers,data={**data,**patch}).status_code,403)
                self.assertEqual(model.calls,1)
                response=client.post(route,headers=headers,data=data)
                self.assertEqual(response.status_code,200,response.text)
                frames=[json.loads(line[5:].strip()) for line in response.text.splitlines() if line.startswith('data:')]
                result={'run_id':next(frame['run_id'] for frame in frames if frame.get('run_id') and frame['run_id']!=failed_id)}
                self.assertTrue(frames)
                self.assertTrue(all(frame.get('run_id') == result['run_id'] for frame in frames if frame.get('run_id')))
                self.assertEqual(len(tool_bindings), 1, 'The retry must execute a real native tool call')
                self.assertEqual(tool_bindings[0]['run_id'], result['run_id'])
                self.assertEqual(tool_bindings[0]['turn_id'], new_op)
                self.assertEqual(tool_bindings[0]['session_id'], session)
                self.assertEqual(tool_bindings[0]['user_id'], user)
                self.assertEqual(model.calls, 3)
                for context in model.contexts[1:3]:
                    self.assertEqual(sum(message.role == 'user' and message.content == '这条问题只应出现一次。'
                        for message in context), 1, 'Retry must not append the original question again')
                self.assertEqual(db.get_run(run_id=failed_id).to_dict(), failed_snapshot,
                    'Background retry must preserve the persisted original failure')
                class ExactRunLookup:
                    def get_run(self, **kwargs): return db.get_run(**kwargs)
                    def _get_table(self, **kwargs): raise AssertionError('Acknowledged detached run must not query a ticket')
                    def get_runs(self, **kwargs): raise AssertionError('Exact locator must not scan history')
                runtime['db']=ExactRunLookup()
                original_path='/galaxy/conversations/'+ident+'/operations/'+new_op
                locator={'runId':result['run_id'],'retryOfOperationId':old_op,'retryOfRunId':failed_id}
                read=client.get(original_path,headers=headers,params=locator)
                self.assertEqual(read.status_code,200,read.text)
                self.assertEqual(read.json()['state'],'COMPLETED')
                self.assertEqual(read.json()['native']['runId'],result['run_id'])
                self.assertEqual(read.json()['native']['operationId'],new_op)
                self.assertEqual(read.json()['conversationId'],ident)
                self.assertEqual(read.json()['sessionId'],session)
                for patch,status in [({'runId':failed_id},403),({'retryOfOperationId':str(uuid4())},403),
                        ({'retryOfRunId':str(uuid4())},403),({'retryOfRunId':''},400),({'runId':'bad/run'},400),({'extra':'forbidden'},400)]:
                    refused=client.get(original_path,headers=headers,params={**locator,**patch})
                    self.assertEqual(refused.status_code,status,refused.text)
                    self.assertNotIn('这条问题只应出现一次',refused.text)
                self.assertEqual(client.get(original_path,headers=headers,params={'runId':result['run_id']}).status_code,403)
                pending_id=str(uuid4())
                pending=client.get(original_path,headers=headers,params={**locator,'runId':pending_id})
                self.assertEqual(pending.status_code,200,pending.text)
                self.assertEqual(pending.json()['state'],'unknown')
                self.assertEqual(pending.json()['runId'],pending_id)
                self.assertIsNone(pending.json()['native'])
                self.assertEqual(model.calls,3,'Exact lookup must not dispatch or repeat the model')

                # A detached regeneration can itself fail before any tool call.
                # Its exact owned run remains a readable terminal, without a
                # durable ticket or an unsafe whole-session history fallback.
                model.failures,model.failure_status=model.calls+2,502
                parent_op,retry_op=str(uuid4()),str(uuid4())
                with authorization_scope(lambda:auth):
                    parent=agent.run('合成的第二次失败重试。',user_id=user,session_id=session,metadata={'operationId':parent_op})
                parent_id = parent.run_id
                parent_snapshot = db.get_run(run_id=parent_id).to_dict()
                runtime['db']=db
                rejected=client.post('/agents/galaxy-conversation-overview/runs/'+parent_id+'/continue',
                    headers={**headers,'Idempotency-Key':retry_op},data={**data,'retry_of_operation_id':parent_op})
                self.assertEqual(rejected.status_code,200,rejected.text)
                errors=[json.loads(line[5:].strip()) for line in rejected.text.splitlines() if line.startswith('data:')]
                error_run=next(frame['run_id'] for frame in errors if frame.get('run_id') and frame['run_id']!=parent_id)
                self.assertTrue(all(frame.get('run_id') == error_run for frame in errors if frame.get('run_id')))
                runtime['db']=ExactRunLookup()
                failure=client.get('/galaxy/conversations/'+ident+'/operations/'+retry_op,headers=headers,
                    params={'runId':error_run,'retryOfOperationId':parent_op,'retryOfRunId':parent_id})
                self.assertEqual(failure.status_code,200,failure.text)
                self.assertEqual(failure.json()['state'],'ERROR')
                self.assertEqual(failure.json()['native']['failure']['category'],'service-unavailable')
                self.assertEqual(failure.json()['native']['failure']['reportedStatus'],502)
                self.assertEqual(model.calls,5)
                self.assertEqual(db.get_run(run_id=parent_id).to_dict(), parent_snapshot,
                    'A failed retry must not overwrite its original failed run either')
                runtime['db']=db
            self.assertEqual(model.calls,5)
            self.assertEqual(sum(message.role=="user" and message.content=="这条问题只应出现一次。" for message in model.contexts[-1]),1)
            new=db.get_run(run_id=result["run_id"])
            self.assertEqual(new.metadata["operationId"],new_op)
            self.assertEqual(new.metadata["retryOfOperationId"],old_op)
            self.assertEqual(new.regenerated_from,failed_id)
            self.assertEqual(new.forked_from_run_id,failed_id)
            original=db.get_run(run_id=failed_id)
            self.assertEqual(original.to_dict(),failed_snapshot)
            self.assertEqual(original.metadata["operationId"],old_op)
            self.assertIsNotNone(failure_view(original.content))
            self.assertEqual(run_view(original)["errorCode"],"operations_agentos_model_request_failed")
            self.assertEqual(run_view(new)["regeneratedFrom"],failed_id)

            with authorization_scope(lambda:auth):
                agent.run("接着说明下一步。",user_id=user,session_id=session,metadata={"operationId":str(uuid4())})
            self.assertEqual(model.calls,6)
            self.assertEqual(db.get_run(run_id=failed_id).to_dict(),failed_snapshot,
                'A later ordinary turn must not mutate an earlier failed attempt')
            self.assertEqual(sum(message.role=="user" and message.content=="这条问题只应出现一次。" for message in model.contexts[-1]),1)
