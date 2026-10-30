"""Native Agno/SQLite contracts; Node transport and model are explicit doubles.

No provider, real business operation, deployment or production data is used.
The durable test invokes Agno's actual worker-owned persistence helper with
an explicit recording atomic primitive; it does not claim PG fencing tests.
"""
from dataclasses import dataclass, field
from contextlib import ExitStack
import json
from galaxy_agentos.conversation_turn_state import turn_state
from pathlib import Path
import tempfile
import time
import unittest
from uuid import uuid4

import httpx
import jwt
from fastapi.testclient import TestClient
from agno.db.sqlite import SqliteDb
from agno.models.base import Model
from agno.models.response import ModelResponse, ToolExecution
from agno.os import AgentOS, Authorization
from agno.session import AgentSession
from agno.run.agent import RunOutput, RunInput, RunErrorEvent, ToolCallCompletedEvent
from agno.run.base import RunContext, RunStatus
from agno.tools.function import Function
from pydantic import TypeAdapter, ValidationError

from galaxy_agentos.app import PrivateSurface, run_view
from galaxy_agentos.authorization import GalaxyAuthorization
from galaxy_agentos.config import Settings
from galaxy_agentos.tool_call_ids import conversation_call_reference
from galaxy_agentos.conversation_storage import conversation_database
from galaxy_agentos.conversation_tools import PreparedOperation, QueryFilters, conversation_tools
from galaxy_agentos.conversations import conversation_agents, install_conversation_read
from galaxy_agentos.gateway import GalaxyGateway, AuthorityDenied, AuthorityUnavailable


PUBLIC_TOOL_BODY = "EXPLICIT_SYNTHETIC_PUBLIC_TOOL_BODY_NOT_FOR_HISTORY"


def settings():
    return Settings(database_url="postgresql+psycopg://not-connected.invalid/contracts",
        authority_url="http://127.0.0.1:1/v1/internal/agentos/",
        service_key="explicit-local-synthetic-service-key-not-live",
        verification_key="explicit-local-synthetic-signing-key-not-live")


class NodeTransport:
    def __init__(self, row):
        self.row, self.calls = row, []
        self.execution_id, self.object_id = str(uuid4()), str(uuid4())
        self.status = 200
        self.error = "SECRET_UPSTREAM_ERROR_PROSE"

    def __call__(self, request):
        value = json.loads(request.content)
        self.calls.append((request.url.path, value))
        if self.status != 200:
            return httpx.Response(self.status, json={"error": self.error})
        if request.url.path.endswith("/authorize"):
            return httpx.Response(200, json={"allowed": True, "execution": dict(self.row),
                "resourceIds": ["galaxy-conversation-overview"], "readExpiresAt": int(time.time()) + 30})
        tool = value["tool"]
        if tool == "assess-conversation-task":
            args=value["arguments"]; phase="waiting-confirmation" if args["disposition"]=="awaiting-confirmation" else args["disposition"]
            return httpx.Response(200,json={"state":"recorded", "taskProgress":{"phase":phase,"remaining":args["remaining"]}})
        if tool in {"query-operations", "read-operation-object"}:
            data = {"count": 2, "publicExcerpt": PUBLIC_TOOL_BODY}
            return httpx.Response(200, json={"tool": tool, "module": "content", "view": "list",
                "availability": "available", "checkedAt": int(time.time()), "readExpiresAt": int(time.time()) + 30,
                "data": data, "pagination": {"next": None, "complete": True},
                "evidenceRefs": [{"kind": "post", "id": self.object_id, "version": 1,
                    "label": "合成公开来源", "href": "/app/community/posts/" + self.object_id,
                    "readExpiresAt": int(time.time()) + 30, "purpose": "public-content"}]})
        if tool == "list-authorized-work":
            return httpx.Response(200, json={"state": "available", "items": [{"executionId": self.execution_id,
                "label": "合成已授权事项", "available": True}]})
        if tool == "run-authorized-work":
            return httpx.Response(200, json={"state": "completed", "applied": True,
                "executionId": value["arguments"]["executionId"]})
        if tool == "prepare-operation":
            return httpx.Response(200, json={"state": "prepared", "card": {
                "id": str(uuid4()), "kind": "feedback-update", "label": "标记合成反馈", "state": "requires-human"}})
        return httpx.Response(200, json={"counts": {}, "availability": {}})


@dataclass
class BusinessToolModel(Model):
    id: str = "explicit-local-model-no-provider"
    name: str = "LocalSynthetic"
    provider: str = "NoNetwork"
    plan: list = field(default_factory=list)
    calls: int = 0
    observed_results: list = field(default_factory=list)
    observed_history: bool = False

    def invoke(self, messages=None, **kwargs):
        self.calls += 1
        for message in messages or []:
            if message.role == "tool" and message.content and message.content not in self.observed_results:
                self.observed_results.append(message.content)
            if message.role == "assistant" and message.from_history and "当前结果" in str(message.content):
                self.observed_history = True
        if self.calls <= len(self.plan):
            name, arguments = self.plan[self.calls - 1]
            return ModelResponse(role="assistant", tool_calls=[{"id": "native-call-" + str(self.calls),
                "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}])
        return ModelResponse(role="assistant", content="## 当前结果\n当前公开条目 2 项。准备卡仍需人工处理；已授权事项按回执完成。")

    async def ainvoke(self, *args, **kwargs): return self.invoke(*args, **kwargs)
    def invoke_stream(self, *args, **kwargs): yield self.invoke(*args, **kwargs)
    async def ainvoke_stream(self, *args, **kwargs): yield self.invoke(*args, **kwargs)
    def _parse_provider_response(self, response, **kwargs): return response
    def _parse_provider_response_delta(self, response): return response


class ConversationBusinessToolsTest(unittest.TestCase):
    def test_rule_cards_are_typed_preparations_without_policy_identity_or_execution_authority(self):
        from agno.tools.function import FunctionCall
        schema = TypeAdapter(PreparedOperation)
        row = {"id": str(uuid4()), "sessionId": str(uuid4()), "domain": "overview", "mode": "conversation"}
        node = NodeTransport(row)
        gateway = GalaxyGateway(settings(), transport=httpx.MockTransport(node))
        self.addCleanup(gateway.close)
        tools = conversation_tools(gateway)
        context = RunContext(run_id=str(uuid4()), session_id=row["sessionId"],
            user_id="conversation:" + row["id"], metadata={"operationId": str(uuid4())})
        commands=[{"kind": "rule-publish", "key": "business-controls", "reason": "发布"},
            {"kind": "rule-restore", "key": "forum-quota", "versionId": str(uuid4()), "reason": "恢复已确认版本"}]
        for index, command in enumerate(commands):
            operation = schema.validate_python(command)
            call = FunctionCall(function=Function.from_callable(tools[-1]), call_id="rule-prepare-" + str(index))
            tools[-1](context, call, operation)
            packet = node.calls[-1][1]
            self.assertEqual(packet["tool"], "prepare-operation")
            self.assertEqual(packet["arguments"], command)
            self.assertEqual(packet["turnId"], context.metadata["operationId"])
        self.assertEqual(len(node.calls), 2)
        invalid=[{**commands[0], "key": "arbitrary-setting"}, {**commands[0], "policy": {}},
            {**commands[0], "operatorId": "forged"}, {**commands[0], "expectedRevision": 2},
            {**commands[0], "reason": "x" * 501}, {**commands[0], "reason": " "},
            {**commands[1], "versionId": "not-a-version-id"},
            {"kind": "rule-delete", "key": "forum-quota", "reason": "not permitted"}]
        for command in invalid:
            with self.assertRaises(ValidationError): schema.validate_python(command)
        self.assertEqual(len(node.calls), 2)

    def test_file_cleanup_approval_is_plan_id_only_human_preparation_without_execution(self):
        from agno.tools.function import FunctionCall
        schema = TypeAdapter(PreparedOperation)
        row = {"id": str(uuid4()), "sessionId": str(uuid4()), "domain": "maintenance", "mode": "conversation"}
        node = NodeTransport(row)
        gateway = GalaxyGateway(settings(), transport=httpx.MockTransport(node))
        self.addCleanup(gateway.close)
        tools = conversation_tools(gateway)
        context = RunContext(run_id=str(uuid4()), session_id=row["sessionId"],
            user_id="conversation:" + row["id"], metadata={"operationId": str(uuid4())})
        command = {"kind": "file-cleanup-approve", "planId": str(uuid4())}
        call = FunctionCall(function=Function.from_callable(tools[-1]), call_id="cleanup-plan-review")
        tools[-1](context, call, schema.validate_python(command))
        path, packet = node.calls[-1]
        self.assertTrue(path.endswith("/tools/execute"))
        self.assertEqual(packet["tool"], "prepare-operation")
        self.assertEqual(packet["arguments"], command)
        self.assertEqual(packet["turnId"], context.metadata["operationId"])
        self.assertEqual(packet["sessionId"], row["sessionId"])
        self.assertEqual(packet["runId"], context.run_id)
        for extra in [{"expectedRevision": 1}, {"items": []}, {"reason": "new scope"},
                {"operatorId": "forged"}, {"executionId": str(uuid4())}, {"approve": True}]:
            with self.assertRaises(ValidationError): schema.validate_python({**command, **extra})
        for invalid in [{"kind": "file-cleanup-approve", "targetId": command["planId"]},
                {"kind": "file-cleanup-delete", "planId": command["planId"]},
                {"kind": "file-cleanup-approve", "planId": "not-a-plan"}]:
            with self.assertRaises(ValidationError): schema.validate_python(invalid)
        self.assertEqual(len(node.calls), 1, "only preparation crosses the Node boundary")
        function = Function.from_callable(tools[-1])
        self.assertNotIn("run_context", function.parameters["properties"])
        self.assertNotIn("fc", function.parameters["properties"])

    def test_file_cleanup_native_tools_only_expose_closed_reads_with_original_context(self):
        from agno.tools.function import FunctionCall
        from galaxy_agentos.conversation_tools import View, ReadKind
        row = {"id": str(uuid4()), "sessionId": str(uuid4()), "domain": "overview", "mode": "conversation"}
        node = NodeTransport(row)
        gateway = GalaxyGateway(settings(), transport=httpx.MockTransport(node))
        self.addCleanup(gateway.close)
        tools = conversation_tools(gateway)
        operation_id, run_id = str(uuid4()), str(uuid4())
        context = RunContext(run_id=run_id, session_id=row["sessionId"],
            user_id="conversation:" + row["id"], metadata={"operationId": operation_id})
        for index, view in enumerate(["cleanup-candidates", "cleanup-plans"]):
            self.assertEqual(TypeAdapter(View).validate_python(view), view)
            call = FunctionCall(function=Function.from_callable(tools[0]), call_id="cleanup-query-" + str(index))
            result = json.loads(tools[0](context, call, module="files", view=view,
                filters=QueryFilters(limit=10)))
            self.assertEqual(result["availability"], "available")
            self.assertEqual(node.calls[-1][1]["arguments"], {"module": "files", "view": view, "filters": {"limit": 10}})
        for index, kind in enumerate(["file-cleanup-plan", "file-cleanup-operation"]):
            self.assertEqual(TypeAdapter(ReadKind).validate_python(kind), kind)
            call = FunctionCall(function=Function.from_callable(tools[1]), call_id="cleanup-read-" + str(index))
            tools[1](context, call, kind=kind, id=node.object_id)
            self.assertEqual(node.calls[-1][1]["arguments"], {"kind": kind, "id": node.object_id})
        self.assertEqual(len(node.calls), 4)
        for path, packet in node.calls:
            self.assertTrue(path.endswith("/tools/execute"))
            self.assertEqual(packet["turnId"], operation_id)
            self.assertEqual(packet["runId"], run_id)
            self.assertEqual(packet["sessionId"], row["sessionId"])
            self.assertIn(packet["tool"], {"query-operations", "read-operation-object"})
            self.assertNotIn("operatorId", packet)
        for invalid in ["file-cleanup-approve", "file-cleanup-delete", "file-cleanup-execute"]:
            with self.assertRaises(ValidationError): TypeAdapter(ReadKind).validate_python(invalid)
            with self.assertRaises(ValidationError): TypeAdapter(PreparedOperation).validate_python({"kind": invalid, "targetId": node.object_id})
        local = json.loads(tools[0](None, None, module="rules", view="cleanup-plans"))
        self.assertEqual(local["state"], "invalid-request")
        self.assertEqual(len(node.calls), 4)
        self.assertIn("never approve", tools[0].__doc__)

    def test_native_agent_invokes_five_business_tools_with_server_context_and_persists_only_tool_metadata(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as cleanup:
            db = SqliteDb(db_file=str(Path(directory) / "native.db"), id="business-tools-local")
            cleanup.callback(db.db_engine.dispose)
            row = {"id": str(uuid4()), "sessionId": str(uuid4()), "domain": "overview",
                "mode": "conversation", "actions": [], "resourceIds": []}
            node = NodeTransport(row)
            gateway = GalaxyGateway(settings(), transport=httpx.MockTransport(node))
            self.addCleanup(gateway.close)
            plan = [("query_operations", {"module": "content", "view": "list", "filters": {"days": 7},
                        "fc": {"call_id": "forged-by-model"}, "run_context": {"user_id": "execution:forged"}}),
                ("read_operation_object", {"kind": "post", "id": node.object_id}),
                ("list_authorized_work", {}),
                ("run_authorized_work", {"execution_id": node.execution_id}),
                ("prepare_operation", {"operation": {"kind": "feedback-update", "targetId": node.object_id,
                    "state": "processing"}}),
                ("assess_turn", {"disposition":"needs-information", "reason":"制卡回执未确认", "remaining":["核对原处理"]})]
            model = BusinessToolModel(plan=plan)
            agents = conversation_agents(settings=settings(), db=db, gateway=gateway,
                domains={"overview": "运营概览"}, active_domains={"overview"}, model_factory=lambda: model)
            names = {tool.name for tool in agents[0].tools}
            self.assertEqual(names, {"current_summary", "read_ai_delegation", "read_task_operation", "plan_turn", "assess_turn", *(name for name, _ in plan)})
            for tool in agents[0].tools:
                function = tool if isinstance(tool, Function) else Function.from_callable(tool)
                self.assertNotIn("run_context", function.parameters["properties"])
                self.assertNotIn("fc", function.parameters["properties"])
            native = AgentOS(id="business-tools-local", db=db, agents=agents, user_isolation=True,
                authorization=Authorization(verification_keys=[settings().verification_key], algorithm="HS256",
                    verify_audience=True, audience=settings().audience, issuer=settings().issuer,
                    authorization_provider=GalaxyAuthorization(gateway)), telemetry=False)
            app = native.get_app()
            runtime = {"os": native, "db": db, "gateway": gateway, "configuredDomains": {"overview"}}
            install_conversation_read(app, runtime, run_view)
            app.add_middleware(PrivateSurface, settings=settings(), runtime=runtime)
            now = int(time.time())
            token = jwt.encode({"sub": "conversation:" + row["id"], "iat": now, "exp": now + 120,
                "aud": settings().audience, "iss": settings().issuer}, settings().verification_key, algorithm="HS256")
            headers = {"Authorization": "Bearer " + token}
            operation_id = str(uuid4())
            with TestClient(app) as client:
                response = client.post("/agents/galaxy-conversation-overview/runs",
                    headers={**headers, "Idempotency-Key": operation_id}, data={"message": "查询并处理已授权事项，准备反馈卡。",
                        "stream": "true", "background": "false", "session_id": row["sessionId"]})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertIn("ToolCallCompleted", response.text)
                packets = [value for path, value in node.calls if path.endswith("/tools/execute")]
                self.assertEqual([value["tool"] for value in packets], ["assess-conversation-task" if name == "assess_turn" else name.replace("_", "-") for name, _ in plan])
                for index, packet in enumerate(packets, 1):
                    self.assertEqual(set(packet), {"conversationId", "sessionId", "turnId", "runId", "callId", "tool", "arguments"})
                    self.assertEqual(packet["conversationId"], row["id"])
                    self.assertEqual(packet["sessionId"], row["sessionId"])
                    self.assertEqual(packet["turnId"], operation_id)
                    from galaxy_agentos.tool_call_ids import conversation_call_reference
                    self.assertEqual(packet["callId"], conversation_call_reference(packet["runId"], "native-call-" + str(index)))
                    self.assertNotIn("role", packet)
                self.assertEqual(packets[3]["arguments"], {"executionId": node.execution_id})
                self.assertNotIn("operationId", packets[4]["arguments"])
                self.assertTrue(any(PUBLIC_TOOL_BODY in value for value in model.observed_results))
                stored = db.get_run(run_id=packets[0]["runId"], deserialize=False)["run_data"]
                self.assertNotIn(PUBLIC_TOOL_BODY, json.dumps(stored))
                self.assertNotIn("forged-by-model", json.dumps(stored))
                self.assertEqual(len(stored["tools"]), 6)
                self.assertTrue(all(item.get("result") is None and item.get("tool_args") is None for item in stored["tools"]))
                self.assertTrue(any(item["event"] == "ToolCallCompleted" for item in stored["events"]))
                history = client.get("/galaxy/conversations/" + row["id"], headers=headers)
                self.assertEqual(history.status_code, 200, history.text)
                self.assertIn("## 当前结果", history.json()["runs"][0]["content"])
                self.assertEqual(stored["metadata"]["promptVersion"], "galaxy-conversation-v2")
                second = client.post("/agents/galaxy-conversation-overview/runs", headers={**headers,
                    "Idempotency-Key": str(uuid4())}, data={"message": "接着解释", "stream": "false",
                        "background": "false", "session_id": row["sessionId"]})
                self.assertEqual(second.status_code, 200, second.text)
                self.assertTrue(model.observed_history)
                # A source invalidation rotating the session during DB work
                # cannot release history fetched from the former context.
                original_get_runs = db.get_runs
                def rotate_on_read(**kwargs):
                    result = original_get_runs(**kwargs)
                    node.row["sessionId"] = str(uuid4())
                    return result
                db.get_runs = rotate_on_read
                stale = client.get("/galaxy/conversations/" + row["id"], headers=headers)
                self.assertEqual(stale.status_code, 403, stale.text)
                self.assertNotIn("当前结果", stale.text)

    def test_prepared_card_stops_native_followup_and_replaces_unconfirmed_content(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as cleanup:
            db = SqliteDb(db_file=str(Path(directory) / "prepared.db"), id="prepared-local")
            cleanup.callback(db.db_engine.dispose)
            row = {"id": str(uuid4()), "sessionId": str(uuid4()), "domain": "overview", "mode": "conversation", "actions": [], "resourceIds": []}
            card_id = str(uuid4())
            class PreparedNode(NodeTransport):
                def __call__(self, request):
                    value = json.loads(request.content)
                    if value.get("tool") == "plan-conversation-turn":
                        self.calls.append((request.url.path, value))
                        return httpx.Response(200, json={"state":"planned", "turnPlan":{**value["arguments"], "preparedCardIds":[]}})
                    if value.get("tool") == "prepare-operation":
                        self.calls.append((request.url.path, value))
                        return httpx.Response(200, json={"state":"prepared", "card":{"cardId":card_id, "state":"prepared"}})
                    return super().__call__(request)
            node = PreparedNode(row)
            gateway = GalaxyGateway(settings(), transport=httpx.MockTransport(node)); cleanup.callback(gateway.close)
            class PreparedModel(BusinessToolModel):
                def invoke(self, messages=None, **kwargs):
                    self.calls += 1
                    if self.calls == 1:
                        return ModelResponse(role="assistant", tool_calls=[{"id":"plan-call", "type":"function", "function":{"name":"plan_turn", "arguments":json.dumps({"intent":"prepare", "proposal_count":1, "alternatives":False, "summary":"处理反馈"})}}])
                    if self.calls == 2:
                        return ModelResponse(role="assistant", tool_calls=[{"id":"prepared-call", "type":"function", "function":{"name":"prepare_operation", "arguments":json.dumps({"operation":{"kind":"feedback-update", "targetId":node.object_id, "state":"processing"}})}}])
                    if self.calls == 3:
                        return ModelResponse(role="assistant", tool_calls=[{"id":"assess-call", "type":"function", "function":{"name":"assess_turn", "arguments":json.dumps({"disposition":"awaiting-confirmation", "reason":"等待确认", "remaining":[]})}}])
                    return ModelResponse(role="assistant", content="已准备确认卡，请人工确认。")
            model = PreparedModel()
            agents = conversation_agents(settings=settings(), db=db, gateway=gateway, domains={"overview":"运营概览"}, active_domains={"overview"}, model_factory=lambda:model)
            native = AgentOS(id="prepared-local", db=db, agents=agents, user_isolation=True, authorization=Authorization(verification_keys=[settings().verification_key], algorithm="HS256", verify_audience=True, audience=settings().audience, issuer=settings().issuer, authorization_provider=GalaxyAuthorization(gateway)), telemetry=False)
            app = native.get_app(); install_conversation_read(app, {"os":native,"db":db,"gateway":gateway,"configuredDomains":{"overview"}}, run_view)
            app.add_middleware(PrivateSurface, settings=settings(), runtime={"os":native,"db":db,"gateway":gateway,"configuredDomains":{"overview"}})
            now = int(time.time()); token = jwt.encode({"sub":"conversation:"+row["id"],"iat":now,"exp":now+120,"aud":settings().audience,"iss":settings().issuer},settings().verification_key,algorithm="HS256")
            with TestClient(app) as client:
                headers = {"Authorization":"Bearer "+token}
                response = client.post("/agents/galaxy-conversation-overview/runs", headers={**headers,"Idempotency-Key":str(uuid4())}, data={"message":"准备处理", "stream":"true", "background":"false", "session_id":row["sessionId"]})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(model.calls, 4)
                self.assertIn("方案已准备，请在下方确认。当前尚未执行。", response.text)
                self.assertNotIn("已准备确认卡，请人工确认。", response.text)
                packets = [value for path,value in node.calls if path.endswith("/tools/execute")]
                self.assertEqual(len(packets), 3)
                stored = db.get_run(run_id=packets[0]["runId"], deserialize=False)["run_data"]
                self.assertEqual(stored["content"], "方案已准备，请在下方确认。当前尚未执行。")
                self.assertNotIn("已准备确认卡，请人工确认。", json.dumps(stored, ensure_ascii=False))
                self.assertEqual(stored["metadata"]["_galaxyPreparedCardIds"], [card_id])
                self.assertEqual(client.get("/galaxy/conversations/"+row["id"], headers=headers).json()["runs"][0]["content"], "方案已准备，请在下方确认。当前尚未执行。")

    def test_native_stream_continues_after_usage_metadata_copy_and_never_emits_false_card(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as cleanup:
            db=SqliteDb(db_file=str(Path(directory)/"holder.db"),id="holder-local"); cleanup.callback(db.db_engine.dispose)
            row={"id":str(uuid4()),"sessionId":str(uuid4()),"domain":"overview","mode":"conversation","actions":[],"resourceIds":[]}
            node=NodeTransport(row); gateway=GalaxyGateway(settings(),transport=httpx.MockTransport(node)); cleanup.callback(gateway.close)
            class Sequence(BusinessToolModel):
                def invoke(self, messages=None, **kwargs):
                    self.calls+=1
                    if self.calls==1:
                        return ModelResponse(role="assistant", tool_calls=[{"id":"read-1","type":"function","function":{"name":"query_operations","arguments":json.dumps({"module":"content","view":"list","filters":{"days":7}})}}])
                    if self.calls==2: return ModelResponse(role="assistant",content="已生成确认卡，请在下方执行。")
                    if self.calls==3:
                        return ModelResponse(role="assistant",tool_calls=[{"id":"assess-1","type":"function","function":{"name":"assess_turn","arguments":json.dumps({"disposition":"needs-information","reason":"需要明确处理对象","remaining":["明确对象"]})}}])
                    return ModelResponse(role="assistant",content="请明确需要处理的对象。")
            model=Sequence(); agents=conversation_agents(settings=settings(),db=db,gateway=gateway,domains={"overview":"运营概览"},active_domains={"overview"},model_factory=lambda:model)
            native=AgentOS(id="holder-local",db=db,agents=agents,user_isolation=True,authorization=Authorization(verification_keys=[settings().verification_key],algorithm="HS256",verify_audience=True,audience=settings().audience,issuer=settings().issuer,authorization_provider=GalaxyAuthorization(gateway)),telemetry=False)
            app=native.get_app(); app.add_middleware(PrivateSurface,settings=settings(),runtime={"os":native,"db":db,"gateway":gateway,"configuredDomains":{"overview"}})
            now=int(time.time()); token=jwt.encode({"sub":"conversation:"+row["id"],"iat":now,"exp":now+120,"aud":settings().audience,"iss":settings().issuer},settings().verification_key,algorithm="HS256")
            with TestClient(app) as client:
                response=client.post("/agents/galaxy-conversation-overview/runs",headers={"Authorization":"Bearer "+token,"Idempotency-Key":str(uuid4())},data={"message":"查询并准备处理", "stream":"true","background":"false","session_id":row["sessionId"]})
                self.assertEqual(response.status_code,200,response.text)
                self.assertEqual(model.calls,4); self.assertNotIn("已生成确认卡",response.text); self.assertIn("请明确需要处理的对象",response.text)
                packets=[value for path,value in node.calls if path.endswith("/tools/execute")]
                self.assertEqual([p["tool"] for p in packets],["query-operations", "assess-conversation-task"])
                stored=db.get_run(run_id=packets[0]["runId"],deserialize=False)["run_data"]
                self.assertEqual(stored["metadata"]["modelCalls"],4)
                self.assertNotIn("_galaxyPreparedCardIds",stored["metadata"])
                self.assertEqual(stored["content"],"请明确需要处理的对象。")

    def test_preparation_stop_is_per_call_and_invalid_card_does_not_stop(self):
        from agno.tools.function import FunctionCall
        from galaxy_agentos.tool_reliability import reliable_function
        first_id, second_id = str(uuid4()), str(uuid4())
        def prepare_operation(run_context: RunContext, fc: FunctionCall, card_id: str) -> str:
            return json.dumps({"state":"prepared", "card":{"state":"prepared", "cardId":card_id}})
        function = reliable_function(prepare_operation)
        context = RunContext(run_id="local-run", session_id="local-session", user_id="conversation:local", metadata={})
        invalid = FunctionCall(function=function, call_id="bad")
        value = function.entrypoint(context, invalid, card_id="invalid")
        self.assertEqual(json.loads(value)["state"], "prepared")
        self.assertFalse(invalid.function.stop_after_tool_call)
        good = FunctionCall(function=function, call_id="good")
        self.assertEqual(json.loads(function.entrypoint(context, good, card_id=first_id))["card"]["cardId"], first_id)
        self.assertFalse(good.function.stop_after_tool_call)
        self.assertFalse(function.stop_after_tool_call)
        other = FunctionCall(function=function, call_id="other")
        self.assertEqual(json.loads(function.entrypoint(context, other, card_id=second_id))["card"]["cardId"], second_id)
        self.assertFalse(other.function.stop_after_tool_call)
        self.assertEqual(turn_state(context)["_galaxyPreparedCardIds"], [first_id, second_id])
        self.assertFalse(invalid.function.stop_after_tool_call)

    def test_native_error_persistence_scrubs_tool_payload_without_mutating_live_result(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as cleanup:
            db = SqliteDb(db_file=str(Path(directory) / "error.db"), id="error-local")
            cleanup.callback(db.db_engine.dispose)
            projected = conversation_database(db)
            ident, sid = str(uuid4()), str(uuid4())
            user_id = "conversation:" + str(uuid4())
            db.upsert_session(AgentSession(session_id=sid, agent_id="galaxy-conversation-overview",
                user_id=user_id, session_data={}))
            output = RunOutput(run_id=ident, session_id=sid, agent_id="galaxy-conversation-overview",
                status=RunStatus.error, content="closed-local-error", input=RunInput(input_content="合成输入"),
                tools=[ToolExecution(tool_call_id="native-call", tool_name="query_operations",
                    tool_args={"query": PUBLIC_TOOL_BODY}, result=PUBLIC_TOOL_BODY)],
                events=[ToolCallCompletedEvent(run_id=ident, content=PUBLIC_TOOL_BODY,
                    tool=ToolExecution(tool_name="query_operations", result=PUBLIC_TOOL_BODY)),
                    RunErrorEvent(run_id=ident, content=PUBLIC_TOOL_BODY, error_type="AuthorityDenied")])
            projected.upsert_run(run=output, session_id=sid, user_id=user_id, run_index=0)
            stored = db.get_run(run_id=ident, deserialize=False)["run_data"]
            self.assertNotIn(PUBLIC_TOOL_BODY, json.dumps(stored))
            self.assertEqual(output.tools[0].result, PUBLIC_TOOL_BODY)
            self.assertEqual(run_view(RunOutput.from_dict(stored))["errorCode"], "operations_agentos_authority_changed")

    def test_typed_preparation_and_current_node_errors_fail_closed_without_accepting_identity_or_raw_upstream_errors(self):
        schema = TypeAdapter(PreparedOperation)
        target = str(uuid4())
        self.assertEqual(schema.validate_python({"kind": "feedback-update", "targetId": target,
            "category": None}).model_dump(mode="json", exclude_unset=True)["category"], None)
        for operation in [{"kind": "content-visibility", "targetKind": "post", "targetId": target,
                    "action": "hide", "reason": "确切原因"},
                {"kind": "file-scan-retry", "targetKind": "chat", "targetId": target, "reason": "重新扫描", "role": "administrator"},
                {"kind": "content-curation", "targetKind": "reply", "targetId": target, "reason": "没有变更"},
                {"kind": "unknown-command", "targetId": target}]:
            with self.assertRaises(ValidationError): schema.validate_python(operation)
        row = {"id": str(uuid4()), "sessionId": str(uuid4()), "domain": "overview", "mode": "conversation"}
        node = NodeTransport(row)
        gateway = GalaxyGateway(settings(), transport=httpx.MockTransport(node))
        self.addCleanup(gateway.close)
        context = {"run_id": str(uuid4()), "call_id": "native-call", "session_id": row["sessionId"], "turn_id": str(uuid4())}
        for status, error in [(401, AuthorityDenied), (403, AuthorityDenied),
                (429, AuthorityUnavailable), (503, AuthorityUnavailable)]:
            node.status = status
            with self.assertRaises(error) as raised:
                gateway.conversation_tool("conversation:" + row["id"], "list-authorized-work", {}, **context)
            self.assertNotIn("SECRET", str(raised.exception))
        for status in (400, 422):
            node.status = status
            with self.assertRaises(AuthorityUnavailable) as raised:
                gateway.conversation_tool("conversation:" + row["id"],
                    "query-operations", {"module": "rules", "view": "overview"}, **context)
            self.assertNotIn("SECRET", str(raised.exception))
            node.error = "invalid_operations_agentos_query"
            feedback = gateway.conversation_tool("conversation:" + row["id"],
                "query-operations", {"module": "rules", "view": "overview"}, **context)
            self.assertEqual(feedback, {"state":"invalid-request", "reason":node.error,
                "httpStatus":status, "scope":"backend-request-validation", "retryable":True,
                "action":"correct-arguments"})
            node.error = "SECRET_UPSTREAM_ERROR_PROSE"
        for status, state in [(404, "unavailable"), (409, "changed")]:
            node.status = status
            feedback = gateway.conversation_tool("conversation:" + row["id"],
                "query-operations", {"module": "rules", "view": "overview"}, **context)
            self.assertEqual(feedback["state"], state)
            self.assertEqual(feedback["effectState"], "not-confirmed")
            self.assertNotIn("effectExecuted", feedback)
            self.assertNotIn("SECRET", json.dumps(feedback))
        node.status = 400
        # Existing authorization/automatic-work requests retain their strict
        # boundary; neutral feedback is only the ordinary conversation tool.
        with self.assertRaises(AuthorityDenied):
            gateway.authorize("conversation:" + row["id"])
        tools = conversation_tools(gateway)
        local = json.loads(tools[0](None, None, module="rules", view="plans"))
        self.assertEqual(local["allowedViews"], ["overview", "versions"])
        self.assertEqual(local["state"], "invalid-request")
        local = json.loads(tools[1](None, None, kind="post", id=target,
            filters=QueryFilters(query="not-an-object-filter")))
        self.assertEqual(local["state"], "invalid-request")
        self.assertIn("rules overview/versions", tools[0].__doc__)
        count = len(node.calls)
        for invalid in [{**context, "session_id": "untrusted-context"}, {**context, "turn_id": None}]:
            with self.assertRaises(AuthorityDenied):
                gateway.conversation_tool("conversation:" + row["id"], "list-authorized-work", {}, **invalid)
        with self.assertRaises(AuthorityDenied):
            gateway.conversation_tool("conversation:" + row["id"], "arbitrary-url-or-sql", {}, **context)
        self.assertEqual(len(node.calls), count)


if __name__ == "__main__":
    unittest.main(verbosity=2)
