"""Actual Agno agent/history/auth routes; synthetic local model and authority.

SQLite here proves the new agent/session surface, not production durable queue
acceptance. Node's real PG leaf separately proves at-most-one dispatch.
"""
import json
import tempfile
from contextlib import ExitStack
import time
import unittest
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4
import jwt
from fastapi.testclient import TestClient
from agno.db.sqlite import SqliteDb
from agno.models.base import Model
from agno.models.response import ModelResponse
from agno.os import AgentOS, Authorization
from galaxy_agentos.authorization import GalaxyAuthorization
from galaxy_agentos.app import PrivateSurface, run_view
from galaxy_agentos.config import Settings
from galaxy_agentos.conversations import conversation_agents, install_conversation_read
from galaxy_agentos.gateway import AuthorityDenied


@dataclass
class LocalModel(Model):
    id: str = "local-conversation-fixture"
    name: str = "LocalOnly"
    provider: str = "ExplicitSynthetic"
    calls: int = 0
    observed_summary: bool = False
    def invoke(self, *args, **kwargs):
        self.calls += 1
        if self.calls == 1:
            return ModelResponse(role="assistant", tool_calls=[{"id": "summary", "type": "function",
                "function": {"name": "current_summary", "arguments": "{}"}}])
        messages = args[0] if args else kwargs.get("messages", [])
        self.observed_summary = self.observed_summary or any(message.role == "tool" and '"pending": 0' in str(message.content) for message in messages)
        if self.calls == 2:
            return ModelResponse(role="assistant", tool_calls=[{"id":"assess", "type":"function", "function":{"name":"assess_turn", "arguments":json.dumps({"disposition":"completed", "reason":"摘要已核对", "remaining":[]})}}])
        return ModelResponse(role="assistant", content="当前摘要没有待处理事项；这是本地合成回复。")
    async def ainvoke(self, *args, **kwargs): return self.invoke(*args, **kwargs)
    def invoke_stream(self, *args, **kwargs): yield self.invoke(*args, **kwargs)
    async def ainvoke_stream(self, *args, **kwargs): yield self.invoke(*args, **kwargs)
    def _parse_provider_response(self, response, **kwargs): return response
    def _parse_provider_response_delta(self, response): return response


class CurrentReader:
    def __init__(self, row): self.row, self.revoked, self.summary_calls = row, False, 0
    def authorize(self, user_id, **kwargs):
        if self.revoked or user_id != "conversation:" + self.row["id"]:
            raise AuthorityDenied("synthetic_current_reader_denied")
        if kwargs.get("resource_type") not in {None, "agents"} or kwargs.get("resource_id") not in {None, "galaxy-conversation-overview"}:
            raise AuthorityDenied("synthetic_scope_denied")
        return {"allowed": True, "execution": self.row, "resourceIds": ["galaxy-conversation-overview"], "readExpiresAt": int(time.time()) + 30}
    def conversation_tool(self, user_id, tool, arguments, **binding):
        self.authorize(user_id)
        if tool != "assess-conversation-task" or binding.get("session_id") != self.row["sessionId"] or not binding.get("turn_id"):
            raise AuthorityDenied("synthetic_scope_denied")
        if arguments != {"disposition":"completed", "reason":"摘要已核对", "remaining":[]}:
            raise AuthorityDenied("synthetic_scope_denied")
        return {"state":"recorded", "taskProgress":{"phase":"completed", "remaining":[]}}
    def conversation_summary(self, user_id, **kwargs):
        self.authorize(user_id); self.summary_calls += 1
        return {"domain": "overview", "counts": {"communityReports": {"pending": 0}}, "availability": {"communityReports": "available"}}


class ConversationNativeTest(unittest.TestCase):
    def test_native_reader_without_grant_uses_only_current_summary_and_owned_session_and_rejects_business_workflow_and_revocation(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as resources:
            db = SqliteDb(db_file=str(Path(directory) / "native.db"), id="conversation-check")
            resources.callback(db.db_engine.dispose)
            settings = Settings(database_url="postgresql+psycopg://not-connected.invalid/check",
                authority_url="http://127.0.0.1:1/v1/internal/agentos/",
                service_key="explicit-synthetic-service-key-not-production",
                verification_key="explicit-synthetic-signing-key-not-production")
            row = {"id": str(uuid4()), "sessionId": str(uuid4()), "domain": "overview", "mode": "conversation", "actions": [], "resourceIds": []}
            gateway = CurrentReader(row)
            agents = conversation_agents(settings=settings, db=db, gateway=gateway,
                domains={"overview": "运营概览"}, active_domains={"overview"}, model_factory=LocalModel)
            self.assertEqual([tool.name for tool in agents[0].tools], ["current_summary", "query_operations", "read_operation_object", "list_authorized_work", "run_authorized_work", "read_task_operation", "read_ai_delegation", "plan_turn", "assess_turn", "prepare_operation"])
            native = AgentOS(id="conversation-native-check", db=db, agents=agents, user_isolation=True,
                authorization=Authorization(verification_keys=[settings.verification_key], algorithm="HS256",
                    verify_audience=True, audience=settings.audience, issuer=settings.issuer,
                    authorization_provider=GalaxyAuthorization(gateway)), telemetry=False)
            app = native.get_app()
            runtime = {"os": native, "db": db, "gateway": gateway, "configuredDomains": {"overview"}}
            install_conversation_read(app, runtime, run_view)
            app.add_middleware(PrivateSurface, settings=settings, runtime=runtime)
            now = int(time.time())
            token = jwt.encode({"sub": "conversation:" + row["id"], "iat": now, "exp": now + 120,
                "aud": settings.audience, "iss": settings.issuer}, settings.verification_key, algorithm="HS256")
            headers = {"Authorization": "Bearer " + token}
            with TestClient(app) as client:
                empty = client.get("/galaxy/conversations/" + row["id"], headers=headers)
                self.assertEqual(empty.status_code, 200, empty.text)
                self.assertEqual(empty.json()["runs"], [])
                op = str(uuid4())
                response = client.post("/agents/galaxy-conversation-overview/runs", headers={**headers, "Idempotency-Key": op},
                    data={"message": "今天有什么变化？", "stream": "false", "background": "false", "session_id": row["sessionId"]})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertGreater(gateway.summary_calls, 0)
                self.assertTrue(agents[0].model.observed_summary)
                history = client.get("/galaxy/conversations/" + row["id"], headers=headers)
                self.assertEqual(history.status_code, 200, history.text)
                self.assertEqual(history.json()["runs"][0]["operationId"], op)
                self.assertIn("本地合成回复", history.json()["runs"][0]["content"])
                for path in ["/galaxy/conversations/" + str(uuid4()), "/agents/galaxy-governance/runs", "/workflows/galaxy-prepared-review/runs"]:
                    refused = client.post(path, headers=headers, data={"message": "不得执行", "session_id": row["sessionId"]}) if path.endswith("/runs") else client.get(path, headers=headers)
                    self.assertEqual(refused.status_code, 403)
                gateway.revoked = True
                self.assertEqual(client.get("/galaxy/conversations/" + row["id"], headers=headers).status_code, 403)


if __name__ == "__main__": unittest.main()
