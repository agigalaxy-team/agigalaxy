"""Native regeneration keeps one user question and records distinct attempts."""
import json
import tempfile
import time
import unittest
from contextlib import ExitStack
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from uuid import uuid4
import jwt
from fastapi.testclient import TestClient
from sqlalchemy import Column, MetaData, Table, Text
from agno.agent import Agent
from agno.db.sqlite import SqliteDb
from agno.models.base import Model
from agno.models.message import Message
from agno.models.response import ModelResponse
from agno.exceptions import ModelProviderError
from agno.os import AgentOS, Authorization
from agno.os.authz.provider import AuthorizationContext
from agno.run.authorization import RunAuthorization, authorization_scope
from agno.run.agent import RunErrorEvent, RunOutput
from agno.run.base import RunStatus
from galaxy_agentos.app import PrivateSurface, run_view
from galaxy_agentos.authorization import GalaxyAuthorization
from galaxy_agentos.config import Settings
from galaxy_agentos.conversations import conversation_agents
from galaxy_agentos.conversation_failures import failure_view
from galaxy_agentos.conversation_retry import ConversationAgent
from galaxy_agentos.conversation_transport import install_conversation_transport_read
from galaxy_agentos.gateway import AuthorityDenied, AuthorityUnavailable
from galaxy_agentos.model_gate import with_current_authority

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
    def assert_historical_question_once(self, messages, expected):
        historical = [json.loads(m.content) for m in messages if m.role == "user" and m.from_history and isinstance(m.content, str)]
        self.assertEqual(sum(item.get("contextType") == "historical-conversation-record" and item.get("content") == expected for item in historical), 1)

    def test_retry_discards_prior_authority_events_without_bypassing_current_authority(self):
        user, session, old_op, new_op, old_run = (str(uuid4()) for _ in range(5))
        user = 'conversation:' + user
        agent = ConversationAgent(id='galaxy-conversation-overview')
        for kind, code in [('AuthorityUnavailable', 'operations_authorization_unavailable'),
                ('AuthorityDenied', 'operations_agentos_authority_changed')]:
            with self.subTest(kind=kind):
                original = RunOutput(run_id=old_run, user_id=user, session_id=session, agent_id=agent.id,
                    status=RunStatus.error, content='galaxy_conversation_model_failure:service-unavailable:502',
                    messages=[Message(role='user', content='合成原提问。')],
                    metadata={'operationId':old_op, 'domain':'overview',
                        'userPublicReferences':{'items':[], 'complete':True}},
                    events=[RunErrorEvent(run_id=old_run, session_id=session, agent_id=agent.id, error_type=kind)])
                before = original.to_dict()
                self.assertEqual(run_view(original)['errorCode'], code)
                self.assertIsNone(run_view(original)['failure'])
                self.assertEqual(failure_view(original.content)['reportedStatus'], 502)
                selected = agent._retry_source(original, {'regenerate':True, 'run_id':old_run,
                    'user_id':user, 'session_id':session, 'metadata':{'operationId':new_op,
                        'retryOfOperationId':old_op, 'retryOfRunId':old_run}})
                self.assertIsNone(selected.events, 'Prior attempt authorization observations must not enter the new attempt')
                self.assertEqual(original.to_dict(), before)
                self.assertEqual(selected.metadata['userPublicReferences'], original.metadata['userPublicReferences'])
                self.assertNotEqual(selected.run_id, old_run)

        class Gateway:
            checks = 0
            error = None
            def authorize(self, principal, **kwargs):
                self.checks += 1
                raise self.error
        gateway, model = Gateway(), RecoveryModel(failures=0)
        guarded = with_current_authority(model, gateway)
        auth = RunAuthorization(provider=GalaxyAuthorization(gateway),
            context=AuthorizationContext(principal_id=user), enforce_tools=False)
        for error in [AuthorityUnavailable('agentos_authority_unavailable'), AuthorityDenied('agentos_current_authority_denied')]:
            gateway.error = error
            with authorization_scope(lambda:auth), self.assertRaises(type(error)) as caught:
                guarded.invoke(messages=[])
            self.assertIs(caught.exception, error)
        self.assertEqual(gateway.checks, 2)
        self.assertEqual(model.calls, 0, 'Discarding old observations must not bypass a current authority failure')

    def test_native_http_retry_reuses_question_checks_owner_and_preserves_failure(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as cleanup:
            db = SqliteDb(db_file=str(Path(directory)/"retry.db"), id="local-retry")
            cleanup.callback(db.db_engine.dispose)
            # SQLite has no native jobs table. Supply the existing seven-field
            # queue metadata fixture; detached retries leave it genuinely empty.
            queue_metadata = MetaData()
            jobs = Table('synthetic_queue_metadata', queue_metadata, *(Column(name, Text, primary_key=name == 'id') for name in
                ['id', 'idempotency_key', 'user_id', 'session_id', 'component_type', 'component_id', 'status']))
            with db.Session() as connection:
                queue_metadata.create_all(bind=connection.get_bind())
            class AckLostLookup:
                Session = db.Session
                def _get_table(self, table_type, create_table_if_not_found=False):
                    return jobs if table_type == 'jobs' else db._get_table(table_type, create_table_if_not_found)
                def get_run(self, **kwargs): return db.get_run(**kwargs)
                def get_runs(self, **kwargs): raise AssertionError('ACK recovery must not read session history')
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

                # Lose the SSE acknowledgement: no command NativeRunID and no
                # job ticket, but the native detached attempt already exists.
                runtime['db'] = AckLostLookup()
                parent_locator = {key:value for key,value in locator.items() if key != 'runId'}
                recovered = client.get(original_path, headers=headers, params=parent_locator)
                self.assertEqual(recovered.status_code, 200, recovered.text)
                self.assertEqual(recovered.json()['runId'], result['run_id'])
                self.assertEqual(recovered.json()['state'], 'COMPLETED')
                self.assertEqual(recovered.json()['native']['operationId'], new_op)
                self.assertEqual(recovered.json()['native']['regeneratedFrom'], failed_id)
                for patch in [{'retryOfOperationId':str(uuid4())}, {'retryOfRunId':str(uuid4())}]:
                    refused = client.get(original_path, headers=headers, params={**parent_locator, **patch})
                    self.assertEqual(refused.status_code, 403, refused.text)
                self.assertEqual(client.get(original_path, headers=headers).status_code, 403,
                    'An operation match alone must not bypass retry lineage')
                self.assertEqual(client.get(original_path, headers=headers,
                    params={'retryOfOperationId':old_op}).status_code, 400)
                absent = client.get('/galaxy/conversations/'+ident+'/operations/'+str(uuid4()),
                    headers=headers, params=parent_locator)
                self.assertEqual(absent.status_code, 200, absent.text)
                self.assertEqual(absent.json()['state'], 'unknown')
                self.assertIsNone(absent.json()['runId'])
                self.assertIsNone(absent.json()['native'])

                # The SQL candidate is not authority. Recheck the stored inner
                # identity, and never select one of two matching owned runs.
                temporary_runs = []
                def add_candidate(operation, *, outer_user=user, inner_user=user):
                    candidate = deepcopy(db.get_run(run_id=result['run_id']))
                    candidate.run_id = str(uuid4())
                    candidate.user_id = inner_user
                    candidate.metadata['operationId'] = operation
                    db.upsert_run(run=candidate, session_id=session, user_id=outer_user)
                    temporary_runs.append(candidate.run_id)
                foreign_op, inconsistent_op = str(uuid4()), str(uuid4())
                foreign_user = 'conversation:' + str(uuid4())
                add_candidate(foreign_op, outer_user=foreign_user, inner_user=foreign_user)
                foreign = client.get('/galaxy/conversations/'+ident+'/operations/'+foreign_op,
                    headers=headers, params=parent_locator)
                self.assertEqual(foreign.status_code, 200, foreign.text)
                self.assertEqual(foreign.json()['state'], 'unknown')
                self.assertIsNone(foreign.json()['runId'], 'Another owner must not reveal a candidate locator')
                add_candidate(inconsistent_op, inner_user=foreign_user)
                inconsistent = client.get('/galaxy/conversations/'+ident+'/operations/'+inconsistent_op,
                    headers=headers, params=parent_locator)
                self.assertEqual(inconsistent.status_code, 403, inconsistent.text)
                add_candidate(new_op)
                ambiguous = client.get(original_path, headers=headers, params=parent_locator)
                self.assertEqual(ambiguous.status_code, 503, ambiguous.text)
                self.assertEqual(client.get(original_path, headers=headers, params=locator).status_code, 200,
                    'An acknowledged exact run must not consult other operation candidates')
                with db.Session() as connection:
                    runs = db._get_table(table_type='runs', create_table_if_not_found=False)
                    connection.execute(runs.delete().where(runs.c.run_id.in_(temporary_runs)))
                    connection.commit()
                class MissingNative(AckLostLookup):
                    def get_run(self, **kwargs): return None
                runtime['db'] = MissingNative()
                disappeared = client.get(original_path, headers=headers, params=parent_locator)
                self.assertEqual(disappeared.status_code, 200, disappeared.text)
                self.assertEqual(disappeared.json()['state'], 'unknown')
                self.assertIsNone(disappeared.json()['runId'], 'Do not publish an unverified candidate that disappeared')
                self.assertIsNone(disappeared.json()['native'])
                self.assertEqual(model.calls, 3, 'No ACK recovery path may submit or repeat a model call')

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
            self.assert_historical_question_once(model.contexts[-1], "这条问题只应出现一次。")
            self.assertEqual(sum(message.role == "user" and not message.from_history and message.content == "合成的第二次失败重试。" for message in model.contexts[-1]), 1)
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
            self.assert_historical_question_once(model.contexts[-1], "这条问题只应出现一次。")
            self.assertEqual(sum(message.role == "user" and not message.from_history and message.content == "接着说明下一步。" for message in model.contexts[-1]), 1)
