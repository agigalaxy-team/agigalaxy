"""Native SDK construction only: no provider, browser, live DB or model run."""
import asyncio
import copy
import json
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from agno.agent._messages import aget_system_message, get_system_message
from agno.db.sqlite import SqliteDb
from agno.models.base import Model
from agno.run.base import RunContext
from agno.run.agent import RunOutput
from agno.session.agent import AgentSession
from agno.utils.agent import execute_instructions
from agno.tools.function import Function, FunctionCall
import httpx
from pydantic import TypeAdapter, ValidationError

from galaxy_agentos.conversation_ai_management import AiPromptCommand
from galaxy_agentos.conversation_prompt import BOUNDARY_VERSION, ROLE_PREFIX, ROLE_SUFFIX
from galaxy_agentos.conversation_storage import conversation_storage_fields
from galaxy_agentos.conversation_tools import DutyPreparedOperation, PreparedOperation, conversation_tools
from galaxy_agentos.conversations import conversation_agents
from galaxy_agentos.duties import duty_tools
from galaxy_agentos.duty_continuation import call_reference, continuation_tools, pending_tools
from galaxy_agentos.gateway import AuthorityDenied, GalaxyGateway
from galaxy_agentos.read_model import metadata


@dataclass
class NeverInvokedModel(Model):
    id: str = "explicit-synthetic-no-run"
    name: str = "NeverInvoked"
    provider: str = "NoProvider"

    def invoke(self, *args, **kwargs):
        raise AssertionError("model invocation is outside this SDK construction check")

    async def ainvoke(self, *args, **kwargs):
        return self.invoke(*args, **kwargs)

    def invoke_stream(self, *args, **kwargs):
        raise AssertionError("model invocation is outside this SDK construction check")
        yield

    async def ainvoke_stream(self, *args, **kwargs):
        raise AssertionError("model invocation is outside this SDK construction check")
        yield

    def _parse_provider_response(self, response, **kwargs):
        return response

    def _parse_provider_response_delta(self, response):
        return response


class CurrentPromptGateway:
    def __init__(self):
        self.rows = {}
        self.allowed = True
        self.calls = []

    def add(self, domain, role, version):
        row = {"id": str(uuid4()), "sessionId": str(uuid4()), "domain": domain,
            "mode": "conversation", "rolePrompt": {"text": role, "version": version}}
        user = "conversation:" + row["id"]
        self.rows[user] = row
        return RunContext(run_id=str(uuid4()), session_id=row["sessionId"], user_id=user,
            metadata={"operationId": str(uuid4()), "promptVersion": "galaxy-conversation-v2",
                "rolePromptVersion": 999, "rolePrompt": "untrusted-client-or-history-text"})

    def authorize(self, user_id, **kwargs):
        self.calls.append((user_id, kwargs))
        return {"allowed": self.allowed, "execution": copy.deepcopy(self.rows[user_id])}


class PromptManagementNativeTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.db = SqliteDb(db_file=str(Path(self.directory.name) / "construction.db"), id="prompt-construction")
        self.gateway = CurrentPromptGateway()
        self.first = self.gateway.add("overview", "本地岗位文本甲", 3)
        self.second = self.gateway.add("governance", "本地岗位文本乙", 7)
        self.agents = conversation_agents(settings=SimpleNamespace(), db=self.db, gateway=self.gateway,
            domains={"overview": "总控", "governance": "治理"}, active_domains={"overview", "governance"},
            model_factory=NeverInvokedModel)

    def test_current_role_hot_loads_on_next_turn_with_fixed_prefix_suffix_and_no_shared_state(self):
        agent = self.agents[0]
        shared = copy.deepcopy(agent.metadata)
        session = AgentSession(session_id=self.first.session_id)
        native_output = RunOutput(run_id=self.first.run_id, session_id=self.first.session_id,
            user_id=self.first.user_id, metadata=self.first.metadata)
        agent.get_tools(native_output, self.first, session, user_id=self.first.user_id)
        message = get_system_message(agent, session, run_context=self.first)
        self.assertIn("本地岗位文本甲", message.content)
        self.assertNotIn("untrusted-client-or-history-text", message.content)
        self.assertLess(message.content.index(ROLE_PREFIX), message.content.index("本地岗位文本甲"))
        self.assertGreater(message.content.index(ROLE_SUFFIX), message.content.index("本地岗位文本甲"))
        self.assertEqual(self.first.metadata["rolePromptVersion"], 3)
        self.assertEqual(native_output.metadata["rolePromptVersion"], 3)
        self.assertNotIn("本地岗位文本甲", json.dumps(native_output.metadata, ensure_ascii=False))
        self.assertEqual(self.first.metadata["boundaryVersion"], BOUNDARY_VERSION)
        self.assertEqual(agent.metadata, shared)
        self.gateway.rows[self.first.user_id].update(rolePrompt={"text": "当前新岗位文本丙", "version": 4})
        same_turn = get_system_message(agent, session, run_context=self.first)
        self.assertIn("本地岗位文本甲", same_turn.content)
        self.assertNotIn("当前新岗位文本丙", same_turn.content)
        self.assertEqual(self.first.metadata["rolePromptVersion"], 3)
        agent.post_hooks[0](self.first)
        self.assertEqual(self.first.metadata["rolePromptVersion"], 3)
        later = RunContext(run_id=str(uuid4()), session_id=self.first.session_id,
            user_id=self.first.user_id, metadata={"operationId": str(uuid4())})
        changed = asyncio.run(aget_system_message(agent, session, run_context=later))
        self.assertIn("当前新岗位文本丙", changed.content)
        self.assertNotIn("本地岗位文本甲", changed.content)
        self.assertEqual(later.metadata["rolePromptVersion"], 4)
        self.assertEqual(self.first.metadata["rolePromptVersion"], 3)
        other = get_system_message(self.agents[1], AgentSession(session_id=self.second.session_id), run_context=self.second)
        self.assertIn("本地岗位文本乙", other.content)
        self.assertNotIn("当前新岗位文本丙", other.content)
        self.assertEqual(self.second.metadata["rolePromptVersion"], 7)
        self.assertEqual(agent.metadata, shared)
        self.assertIn((self.first.user_id, {"operation": "run", "turn_id": self.first.metadata["operationId"]}), self.gateway.calls)
        self.assertTrue(all(call[1] in ({"operation": "run"},
            {"operation": "run", "turn_id": self.first.metadata["operationId"]}) for call in self.gateway.calls))

    def test_current_context_and_closed_prompt_fail_before_any_model(self):
        row = self.gateway.rows[self.first.user_id]
        original = copy.deepcopy(row)
        invalid = [
            {"sessionId": str(uuid4())}, {"id": str(uuid4())}, {"domain": "governance"},
            {"mode": "autonomy"}, {"rolePrompt": {"text": "x", "version": True}},
            {"rolePrompt": {"text": "x", "version": 0}},
            {"rolePrompt": {"text": "x", "version": "3"}},
            {"rolePrompt": {"text": "x", "version": 3, "model": "never-accepted"}},
            {"rolePrompt": {"text": "x", "version": 3, "boundary": "never-accepted"}},
            {"rolePrompt": {"text": "x" * 16001, "version": 3}}, {"rolePrompt": "invalid"},
        ]
        for patch in invalid:
            with self.subTest(fields=list(patch)):
                self.gateway.rows[self.first.user_id] = {**original, **patch}
                with self.assertRaises(AuthorityDenied):
                    execute_instructions(self.agents[0].instructions, run_context=self.first)
        self.gateway.rows[self.first.user_id] = original
        self.gateway.allowed = False
        with self.assertRaises(AuthorityDenied):
            execute_instructions(self.agents[0].instructions, run_context=self.first)

    def test_missing_current_prompt_does_not_reuse_a_historical_version_or_body(self):
        del self.gateway.rows[self.first.user_id]["rolePrompt"]
        result = "\n".join(execute_instructions(self.agents[0].instructions, run_context=self.first))
        self.assertIn("未配置岗位工作提示词", result)
        self.assertNotIn("untrusted-client-or-history-text", result)
        self.assertNotIn("本地岗位文本甲", result)
        self.assertIsNone(self.first.metadata["rolePromptVersion"])
        self.assertEqual(self.first.metadata["boundaryVersion"], BOUNDARY_VERSION)

    def test_capability_answer_uses_current_summary_and_ordinary_prompt_is_not_model_or_boundary(self):
        fixed = execute_instructions(self.agents[0].instructions, run_context=self.first)
        text = "\n".join(fixed)
        self.assertIn("先用current_summary", text)
        self.assertIn("普通岗位工作提示词不是模型配置", text)
        self.assertIn("工作台只准备具体人工卡", text)
        self.assertIn("后台执行另须当前显式授权", text)
        self.assertIn("不能授予读取或写入权限", text)
        self.assertNotIn("不能修改目标、策略授权边界或模型配置", text)

    def test_run_metadata_projects_only_current_version_and_preserves_historical_boundary_id(self):
        execute_instructions(self.agents[0].instructions, run_context=self.first)
        row = {"run_id": self.first.run_id, "user_id": self.first.user_id,
            "agent_id": "galaxy-conversation-overview", "run_type": "agent",
            "session_id": self.first.session_id, "status": "COMPLETED",
            "run_data": {"metadata": {**self.first.metadata, "domain": "overview"}}}
        result = metadata(row)
        self.assertEqual(result["rolePromptVersion"], 3)
        self.assertEqual(result["boundaryVersion"], BOUNDARY_VERSION)
        self.assertEqual(result["promptVersion"], "galaxy-conversation-v2")
        self.assertNotIn("本地岗位文本甲", json.dumps(result, ensure_ascii=False))
        self.assertNotIn("untrusted-client-or-history-text", json.dumps(result, ensure_ascii=False))
        row["run_data"]["metadata"]["rolePromptVersion"] = True
        self.assertIsNone(metadata(row)["rolePromptVersion"])
        self.assertEqual(metadata(row)["boundaryVersion"], BOUNDARY_VERSION)


class ManagementToolNativeTest(unittest.TestCase):
    def test_workbench_management_is_closed_prepare_only_and_binds_original_turn(self):
        calls = []
        class Gateway:
            def conversation_tool(self, user_id, tool, arguments, **binding):
                calls.append({"user_id": user_id, "tool": tool, "arguments": arguments, **binding})
                return {"state": "prepared"} if tool == "prepare-operation" else {"items": []}
        tools = conversation_tools(Gateway())
        self.assertEqual([tool.name if isinstance(tool, Function) else tool.__name__ for tool in tools], ["query_operations", "read_operation_object",
            "list_authorized_work", "run_authorized_work", "read_task_operation", "read_ai_delegation", "plan_turn", "assess_turn", "prepare_operation"])
        prepare = next(tool for tool in tools if tool.__name__ == "prepare_operation")
        read = next(tool for tool in tools if tool.__name__ == "read_ai_delegation")
        schema = Function.from_callable(prepare)
        schema.process_entrypoint()
        # Agno resolves Pydantic's discriminated union into the provider-facing
        # branch schema and does not retain the discriminator mapping itself.
        operation_schema = json.dumps(schema.parameters["properties"]["operation"])
        self.assertIn('"ai-work-prompt-save"', operation_schema)
        self.assertIn('"ai-role-command"', operation_schema)
        self.assertIn('"targetAiAccountIds"', operation_schema)
        workbench_mapping = TypeAdapter(PreparedOperation).json_schema()["discriminator"]["mapping"]
        business_mapping = TypeAdapter(DutyPreparedOperation).json_schema()["discriminator"]["mapping"]
        self.assertEqual(set(workbench_mapping) - set(business_mapping), {"ai-work-prompt-save", "ai-role-command"})
        self.assertEqual(set(business_mapping) - set(workbench_mapping), {"ordinary-strategy-create-draft"})
        self.assertNotIn('"ordinary-strategy-create-draft"', operation_schema)
        duty_only = {"kind": "ordinary-strategy-create-draft", "sourceStrategyId": str(uuid4()),
            "sourceVersionId": str(uuid4()), "expectedRevision": 1, "name": "受控策略", "reason": "批准范围内"}
        with self.assertRaises(ValidationError):
            TypeAdapter(PreparedOperation).validate_python(duty_only)
        context = RunContext(run_id=str(uuid4()), session_id=str(uuid4()), user_id="conversation:" + str(uuid4()),
            metadata={"operationId": str(uuid4())})
        target = str(uuid4())
        prompt = {"kind": "ai-work-prompt-save", "aiAccountId": target, "prompt": "本地具体岗位工作要求"}
        role = {"kind": "ai-role-command", "command": {"kind": "role-create", "expectedVersion": 0,
            "name": "本地受限AI岗位", "description": "明确合成输入", "enabled": True,
            "permissions": ["content.read"], "targetAiAccountIds": [target]}}
        assignment = {"kind": "ai-role-command", "command": {"kind": "assignment-save", "expectedVersion": 2,
            "id": None, "aiAccountId": target, "roleId": str(uuid4()), "enabled": True}}
        for index, payload in enumerate((prompt, role, assignment)):
            operation = TypeAdapter(PreparedOperation).validate_python(payload)
            call = FunctionCall(function=schema, call_id="prepare-management-" + str(index))
            self.assertEqual(json.loads(prepare(context, call, operation=operation))["state"], "prepared")
            expected = copy.deepcopy(payload)
            if payload is assignment:
                expected["command"].pop("id")
            self.assertEqual(calls[-1]["arguments"], expected)
            self.assertEqual(calls[-1]["tool"], "prepare-operation")
            self.assertEqual(calls[-1]["turn_id"], context.metadata["operationId"])
            self.assertEqual(calls[-1]["session_id"], context.session_id)
            self.assertEqual(calls[-1]["run_id"], context.run_id)
            with self.assertRaises(ValidationError):
                TypeAdapter(DutyPreparedOperation).validate_python(payload)
        read_call = FunctionCall(function=Function.from_callable(read), call_id="read-delegation")
        read(context, read_call)
        self.assertEqual(calls[-1]["arguments"], {})
        read(context, read_call, ai_account_id=__import__("uuid").UUID(target))
        self.assertEqual(calls[-1]["arguments"], {"aiAccountId": target})
        for forbidden in ("operationId", "expectedRevision", "expectedPromptVersion", "model", "boundary", "planId"):
            with self.subTest(forbidden=forbidden), self.assertRaises(ValidationError):
                TypeAdapter(PreparedOperation).validate_python({**prompt, forbidden: "untrusted"})
        with self.assertRaises(ValidationError):
            TypeAdapter(PreparedOperation).validate_python({**prompt, "prompt": "x" * 16001})
        self.assertTrue(all(call["tool"] in {"prepare-operation", "read-ai-delegation"} for call in calls))

    def test_duty_prompt_tool_is_allowlisted_typed_and_rechecks_before_each_call(self):
        task_id, session_id, run_id, target = [str(uuid4()) for _ in range(4)]
        class Gateway:
            allowed = ["read-ai-delegation", "manage-ai-prompt"]
            calls = []
            def duty_authorize(self, user_id, **kwargs):
                return {"allowed": True, "task": {"taskId": task_id, "domain": "overview",
                    "sessionId": session_id, "tools": list(self.allowed)}}
            def duty_tool(self, user_id, tool, arguments, **binding):
                self.calls.append({"tool": tool, "arguments": arguments, **binding})
                return {"state": "completed", "operationId": str(uuid4())}
        gateway = Gateway()
        self.assertEqual(duty_tools(gateway, set()), [])
        tools = duty_tools(gateway, set(gateway.allowed))
        self.assertEqual([tool.name if isinstance(tool, Function) else tool.__name__ for tool in tools], ["read_ai_delegation", "manage_ai_prompt"])
        writer = tools[-1]
        schema = writer
        schema.process_entrypoint()
        command_schema = schema.parameters["properties"]["command"]
        self.assertEqual(set(command_schema["properties"]), {"aiAccountId", "expectedRevision", "expectedPromptVersion", "prompt"})
        self.assertFalse(command_schema["additionalProperties"])
        payload = {"aiAccountId": target, "expectedRevision": 6, "expectedPromptVersion": 4, "prompt": "本地获准岗位要求"}
        command = AiPromptCommand.model_validate(payload)
        context = RunContext(run_id=run_id, session_id=session_id, user_id="autonomy:" + task_id)
        call = FunctionCall(function=schema, call_id="prompt-call-1")
        writer.entrypoint(context, call, command=payload)
        self.assertEqual(gateway.calls[-1]["arguments"], payload)
        self.assertEqual(gateway.calls[-1]["tool"], "manage-ai-prompt")
        self.assertEqual(gateway.calls[-1]["call_id"], call_reference(task_id, run_id, call.call_id))
        self.assertEqual(gateway.calls[-1]["run_id"], run_id)
        gateway.allowed = []
        self.assertEqual(json.loads(writer.entrypoint(context, call, command=payload))["state"], "denied")
        self.assertEqual(len(gateway.calls), 1)
        for patch in ({"expectedRevision": 0}, {"expectedPromptVersion": True}, {"operationId": str(uuid4())},
                {"model": "never-accepted"}, {"prompt": "x" * 16001}):
            with self.assertRaises(ValidationError):
                AiPromptCommand.model_validate({**payload, **patch})

    def test_new_writer_preserves_waiting_human_original_operation_and_scrubs_body(self):
        task_id, session_id, run_id, operation_id = [str(uuid4()) for _ in range(4)]
        run = {"run_id": run_id, "agent_id": "galaxy-duty", "session_id": session_id,
            "user_id": "autonomy:" + task_id, "status": "PAUSED", "tools": [{
                "tool_name": "manage_ai_prompt", "tool_call_id": "prompt-waiting",
                "external_execution_required": True, "tool_args": {"prompt": "private-prompt-body"},
                "result": "private-result-body"}]}
        self.assertEqual(len(pending_tools(run)), 1)
        task = {"taskId": task_id, "sessionId": session_id, "continuation": {"allowed": True, "decisions": [{
            "callId": call_reference(task_id, run_id, "prompt-waiting"), "operationId": operation_id,
            "state": "completed", "basis": "persisted-domain-operation-receipt"}]}}
        resolved = continuation_tools(task, run)
        self.assertEqual(resolved[0]["tool_name"], "manage_ai_prompt")
        self.assertEqual(json.loads(resolved[0]["result"])["operationId"], operation_id)
        self.assertEqual(resolved[0]["tool_args"], {})
        task["continuation"]["decisions"][0]["state"] = "unknown"
        with self.assertRaises(AuthorityDenied):
            continuation_tools(task, run)
        projected = conversation_storage_fields(run)
        self.assertEqual(projected["tools"][0]["tool_name"], "manage_ai_prompt")
        self.assertNotIn("private-prompt-body", json.dumps(projected))
        self.assertNotIn("private-result-body", json.dumps(projected))

    def test_conversation_transport_allows_only_read_delegation_never_background_writer(self):
        requests = []
        def respond(request):
            requests.append(json.loads(request.content))
            return httpx.Response(200, json={"items": []})
        gateway = GalaxyGateway(SimpleNamespace(authority_url="http://127.0.0.1:1/v1/internal/agentos/",
            service_key="explicit-local-synthetic-key"), transport=httpx.MockTransport(respond))
        self.addCleanup(gateway.close)
        binding = {"run_id": str(uuid4()), "call_id": "read-delegation", "session_id": str(uuid4()), "turn_id": str(uuid4())}
        user = "conversation:" + str(uuid4())
        gateway.conversation_tool(user, "read-ai-delegation", {}, **binding)
        self.assertEqual(requests[-1]["tool"], "read-ai-delegation")
        self.assertEqual(requests[-1]["turnId"], binding["turn_id"])
        for tool in ("manage-ai-prompt", "manage-ai-role"):
            with self.assertRaises(AuthorityDenied):
                gateway.conversation_tool(user, tool, {}, **binding)
        self.assertEqual(len(requests), 1)


if __name__ == "__main__":
    unittest.main()
