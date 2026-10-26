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

@dataclass
class RecoveryModel(Model):
    id: str = "local-retry-only"
    name: str = "LocalOnly"
    provider: str = "Synthetic"
    calls: int = 0
    contexts: list = field(default_factory=list)
    def invoke(self, messages, **kwargs):
        self.calls += 1
        self.contexts.append(messages)
        if self.calls == 1:
            raise ModelProviderError("local failure", status_code=503, model_name=self.name, model_id=self.id)
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
            class Gateway:
                def authorize(self, principal, **kwargs):
                    return {"allowed":True,"execution":{"id":ident,"sessionId":session,"domain":"overview","mode":"conversation"}}
            gateway=Gateway()
            settings=Settings(database_url="postgresql+psycopg://unused.invalid/test",authority_url="http://127.0.0.1:1/",
                service_key="explicit-local-service-not-production-00001",verification_key="explicit-local-signing-not-production-00001")
            model=RecoveryModel()
            agent=conversation_agents(settings=settings,db=db,gateway=gateway,domains={"overview":"总控"},active_domains={"overview"},model_factory=lambda:model)[0]
            auth=RunAuthorization(provider=GalaxyAuthorization(gateway),context=AuthorizationContext(principal_id=user),enforce_tools=False)
            with authorization_scope(lambda:auth):
                failed=agent.run("这条问题只应出现一次。",user_id=user,session_id=session,metadata={"operationId":old_op})
            self.assertEqual(str(getattr(failed.status,"value",failed.status)).upper(),"ERROR")
            native=AgentOS(id="local-retry-http",db=db,agents=[agent],authorization=Authorization(
                verification_keys=[settings.verification_key],algorithm="HS256",verify_audience=True,
                audience=settings.audience,issuer=settings.issuer,authorization_provider=GalaxyAuthorization(gateway)),
                user_isolation=True,tracing=False,telemetry=False)
            app=native.get_app()
            runtime={"os":native,"db":db,"gateway":gateway,"configuredDomains":{"overview"}}
            app.add_middleware(PrivateSurface,settings=settings,runtime=runtime)
            now=int(time.time())
            token=jwt.encode({"sub":user,"iat":now,"exp":now+120,"aud":settings.audience,"iss":settings.issuer},settings.verification_key,algorithm="HS256")
            headers={"Authorization":"Bearer "+token,"Idempotency-Key":new_op}
            data={"regenerate":"true","replace_original":"true","retry_of_operation_id":old_op,"session_id":session,"stream":"false","background":"false"}
            route="/agents/galaxy-conversation-overview/runs/"+failed.run_id+"/continue"
            with TestClient(app) as client:
                for patch in [{"session_id":str(uuid4())},{"message":"重复提问"},{"regenerate":"false"},{"retry_of_operation_id":str(uuid4())}]:
                    self.assertEqual(client.post(route,headers=headers,data={**data,**patch}).status_code,403)
                self.assertEqual(model.calls,1)
                response=client.post(route,headers=headers,data=data)
                self.assertEqual(response.status_code,200,response.text)
            self.assertEqual(model.calls,2)
            self.assertEqual(sum(message.role=="user" and message.content=="这条问题只应出现一次。" for message in model.contexts[-1]),1)
            result=response.json()
            new=db.get_run(run_id=result["run_id"])
            self.assertEqual(new.metadata["operationId"],new_op)
            self.assertEqual(new.metadata["retryOfOperationId"],old_op)
            self.assertEqual(new.regenerated_from,failed.run_id)
            original=db.get_run(run_id=failed.run_id)
            self.assertEqual(original.metadata["operationId"],old_op)
            self.assertIsNotNone(failure_view(original.content))
            self.assertEqual(run_view(original)["errorCode"],"operations_agentos_model_request_failed")
            self.assertEqual(run_view(new)["regeneratedFrom"],failed.run_id)

            with authorization_scope(lambda:auth):
                agent.run("接着说明下一步。",user_id=user,session_id=session,metadata={"operationId":str(uuid4())})
            self.assertEqual(model.calls,3)
            self.assertEqual(sum(message.role=="user" and message.content=="这条问题只应出现一次。" for message in model.contexts[-1]),1)
