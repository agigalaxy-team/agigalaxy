import json
import unittest

from agno.agent import Agent
from agno.models.response import ModelResponse
from pydantic import ValidationError
from galaxy_agentos.duties import TaskAssessment, duty_tools
from galaxy_agentos.duty_completion import with_duty_completion
from test_duty_completion import NativeProvider
from test_duties import CurrentTask


class ReadResolutionContract(unittest.TestCase):
    def test_actual_agent_uses_original_prompt_evidence_in_assessment(self):
        failed = "11111111-1111-4111-8111-111111111111"
        evidence = "22222222-2222-4222-8222-222222222222"
        gateway = CurrentTask()
        gateway.task["tools"] = ["assess-task"]
        gateway.task["completion"] = {"disposition": "continue", "reasonCode": "read-coverage-incomplete",
            "readCoverage": {"unresolved": [{"callId": failed, "tool": "inspect-operations", "coverage": "profile-partial"}],
                "successful": [{"callId": evidence, "tool": "read-operation-object", "coverage": "complete"}]}}
        class Provider(NativeProvider):
            def invoke(self, *args, **kwargs):
                messages = kwargs.get("messages", args[0] if args else [])
                self.calls += 1
                if self.calls == 1:
                    return ModelResponse(role="assistant", content="checking")
                if self.calls == 2:
                    prompt = next(m.content for m in messages if isinstance(m.content, str) and "当前程序裁决：" in m.content)
                    facts = json.loads(prompt.split("当前程序裁决：", 1)[1])
                    assessment = {"goalSatisfied": True, "remainingWork": [], "summary": "checked",
                        "readResolutions": [{"failedCallId": facts["unresolved"][0]["callId"], "resolution": "not-applicable",
                            "evidenceCallIds": [facts["successful"][0]["callId"]]}]}
                    return ModelResponse(role="assistant", tool_calls=[{"id": "assess-original", "type": "function",
                        "function": {"name": "assess_task", "arguments": json.dumps({"assessment": assessment})}}])
                return ModelResponse(role="assistant", content="done")
        provider = with_duty_completion(Provider(), gateway)
        result = Agent(model=provider, tools=duty_tools(gateway, {"assess-task"}), telemetry=False).run(
            "task", user_id="autonomy:" + gateway.task["taskId"], session_id=gateway.task["sessionId"])
        self.assertEqual(result.content, "done")
        self.assertEqual(gateway.calls[-1]["arguments"]["readResolutions"],
            [{"failedCallId": failed, "resolution": "not-applicable", "evidenceCallIds": [evidence]}])

    def test_actual_sdk_exposes_closed_original_call_coordinates(self):
        native = duty_tools(object(), {"assess-task"})[0]
        native.process_entrypoint()
        schema = json.dumps(native.parameters, ensure_ascii=False)
        for value in ("readResolutions", "failedCallId", "evidenceCallIds", "not-applicable", "superseded"):
            self.assertIn(value, schema)
        call = "11111111-1111-4111-8111-111111111111"
        evidence = "22222222-2222-4222-8222-222222222222"
        item = TaskAssessment.model_validate({"goalSatisfied": True, "remainingWork": [], "summary": "checked",
            "readResolutions": [{"failedCallId": call, "resolution": "not-applicable", "evidenceCallIds": [evidence]}]})
        self.assertEqual(item.model_dump(mode="json")["readResolutions"][0]["failedCallId"], call)
        with self.assertRaises(ValidationError):
            TaskAssessment.model_validate({"goalSatisfied": True, "remainingWork": [], "summary": "checked",
                "readResolutions": [{"failedCallId": call, "resolution": "not-applicable", "evidenceCallIds": [evidence], "extra": "x"}]})

    def test_current_task_prompt_has_original_read_and_receipt_coordinates(self):
        failed = "11111111-1111-4111-8111-111111111111"
        read = "22222222-2222-4222-8222-222222222222"
        writer = "33333333-3333-4333-8333-333333333333"
        class Gateway:
            calls = 0
            def duty_authorize(self, _user, *, operation):
                self.calls += 1
                return {"task": {"completion": {"disposition": "continue" if self.calls == 1 else "completed",
                    "readCoverage": {"unresolved": [{"callId": failed, "tool": "inspect-operations", "coverage": "profile-partial"}],
                        "successful": [{"callId": read, "tool": "read-operation-object", "coverage": "complete"}]},
                    "resolutionEvidence": [{"callId": writer, "operationId": "44444444-4444-4444-8444-444444444444",
                        "targetId": "55555555-5555-4555-8555-555555555555", "action": "ordinary-strategy-create-draft",
                        "state": "completed", "basis": "persisted-domain-operation-receipt", "private": "not-in-prompt"}]}}}
        provider = with_duty_completion(NativeProvider(), Gateway())
        Agent(model=provider, telemetry=False).run("task", user_id="autonomy:test")
        prompt = "\n".join(v for v in provider.captured[1] if isinstance(v, str))
        self.assertTrue(all(value in prompt for value in (failed, read, writer, "resolutionEvidence", "readResolutions")))
        self.assertNotIn("not-in-prompt", prompt)
