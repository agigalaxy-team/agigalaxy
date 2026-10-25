"""Closed diagnostics and actual Agno no-argument tool dispatch; no model run."""
from dataclasses import dataclass
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from uuid import uuid4

from agno.db.sqlite import SqliteDb
from agno.models.base import Model
from agno.run.base import RunContext
from agno.tools.function import Function
from agno.utils.tools import get_function_call_for_tool_call
import httpx

from galaxy_agentos.conversations import conversation_agents
from galaxy_agentos.gateway import AuthorityDenied, GalaxyGateway
from galaxy_agentos.tool_call_ids import conversation_call_reference, rejected_tool_call_shape


@dataclass
class NeverInvokedModel(Model):
    id: str = "explicit-synthetic-no-run"
    name: str = "NeverInvoked"
    provider: str = "NoProvider"

    def invoke(self, *args, **kwargs):
        raise AssertionError("no model is invoked by this SDK tool fixture")

    async def ainvoke(self, *args, **kwargs):
        return self.invoke(*args, **kwargs)

    def invoke_stream(self, *args, **kwargs):
        self.invoke(*args, **kwargs)
        yield

    async def ainvoke_stream(self, *args, **kwargs):
        self.invoke(*args, **kwargs)
        yield

    def _parse_provider_response(self, response, **kwargs):
        return response

    def _parse_provider_response_delta(self, response):
        return response


class ToolCallIdDiagnosticsTest(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.context = RunContext(run_id=str(uuid4()), session_id=str(uuid4()),
            user_id="conversation:" + str(uuid4()), metadata={"operationId": str(uuid4())})
        def respond(request):
            self.requests.append(json.loads(request.content))
            return httpx.Response(200, json={"state": "available", "effectExecuted": False})
        self.gateway = GalaxyGateway(SimpleNamespace(authority_url="http://127.0.0.1:1/v1/internal/agentos/",
            service_key="explicit-local-synthetic-key"), transport=httpx.MockTransport(respond))
        self.addCleanup(self.gateway.close)

    def binding(self, call_id):
        return {"run_id": self.context.run_id, "session_id": self.context.session_id,
            "turn_id": self.context.metadata["operationId"], "call_id": call_id}

    def native_functions(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        db = SqliteDb(db_file=str(Path(directory.name) / "sdk-construction.db"), id="closed-id-shape")
        agent = conversation_agents(settings=SimpleNamespace(), db=db, gateway=self.gateway,
            domains={"overview": "synthetic"}, active_domains={"overview"}, model_factory=NeverInvokedModel)[0]
        functions = {}
        for tool in agent.tools:
            function = Function.from_callable(tool)
            function.process_entrypoint()
            function._run_context = self.context
            functions[function.name] = function
        return functions

    def test_shape_is_closed_for_all_types_and_never_stringifies_an_object(self):
        class NeverStringify:
            def __str__(self): raise AssertionError("must not stringify rejected ID")
            def __repr__(self): raise AssertionError("must not repr rejected ID")
        keys = {"valueType", "stringLength", "hasWhitespace", "hasControl", "hasNonAscii", "isEmpty", "exceedsMaxLength"}
        fixtures = [(None, "null"), (True, "boolean"), (123, "integer"), (1.5, "number"),
            ([], "array"), ({"private-marker": "private-value"}, "object"), (NeverStringify(), "other"),
            ("", "string"), ("private-id \t\x00银河", "string"), ("x" * 201, "string")]
        for value, expected in fixtures:
            with self.subTest(expected=expected):
                shape = rejected_tool_call_shape(value)
                self.assertEqual(set(shape), keys)
                self.assertEqual(shape["valueType"], expected)
                self.assertTrue(all(type(shape[key]) is bool for key in keys - {"valueType", "stringLength"}))
                self.assertNotIn("private", json.dumps(shape))
        shape = rejected_tool_call_shape("private-id \t\x00银河")
        self.assertTrue(shape["hasWhitespace"])
        self.assertTrue(shape["hasControl"])
        self.assertTrue(shape["hasNonAscii"])
        self.assertTrue(rejected_tool_call_shape("x" * 201)["exceedsMaxLength"])

    def test_invalid_id_logs_only_allowed_fields_and_unchanged_closed_exception(self):
        keys = {"code", "runId", "tool", "valueType", "stringLength", "hasWhitespace", "hasControl", "hasNonAscii", "isEmpty", "exceedsMaxLength"}
        fixtures = [None, "", "private-id-marker with-space", "private-id-marker\n", "private-id-marker银河",
            "private-id-marker" + "x" * 16385, {"private-id-marker": "private-value-marker"}]
        for value in fixtures:
            with self.assertLogs("galaxy_agentos.gateway", level="WARNING") as logged:
                with self.assertRaisesRegex(AuthorityDenied, "^agentos_tool_call_id_invalid$"):
                    self.gateway.conversation_tool(self.context.user_id, "prepare-operation",
                        {"prompt": "private-argument-marker", "nested": {"body": "private-body-marker"}}, **self.binding(value))
            self.assertEqual(len(logged.records), 1)
            record = logged.records[0]
            self.assertEqual(record.msg, "agentos_tool_call_id_invalid %s")
            self.assertIsNone(record.exc_info)
            diagnostic = json.loads(record.args[0])
            self.assertEqual(set(diagnostic), keys)
            self.assertEqual(diagnostic["code"], "agentos_tool_call_id_invalid")
            self.assertEqual(diagnostic["runId"], self.context.run_id)
            self.assertEqual(diagnostic["tool"], "prepare-operation")
            text = record.getMessage()
            for marker in ("private-id-marker", "private-value-marker", "private-argument-marker", "private-body-marker"):
                self.assertNotIn(marker, text)
        self.assertEqual(self.requests, [])

    def test_unvalidated_run_or_tool_is_not_logged_and_valid_call_has_no_diagnostic(self):
        with self.assertNoLogs("galaxy_agentos.gateway", level="WARNING"):
            for patch in ({"run_id": "private-invalid/run"}, {}):
                with self.assertRaises(AuthorityDenied):
                    self.gateway.conversation_tool(self.context.user_id, "private-invalid-tool" if not patch else "workbench-summary", {},
                        **{**self.binding("private invalid call"), **patch})
            self.gateway.conversation_summary(self.context.user_id, **self.binding("provider/call:valid"))
        self.assertEqual(len(self.requests), 1)

    def test_actual_summary_schema_hides_fc_context_and_sdk_preserves_id_for_empty_argument_shapes(self):
        functions = self.native_functions()
        summary = functions["current_summary"]
        self.assertEqual(summary.parameters["properties"], {})
        self.assertEqual(summary.parameters.get("required"), [])
        self.assertTrue({"run_context", "fc"}.issubset(summary._framework_params))
        for arguments in (None, "", "{}", "[]"):
            opaque = "synthetic/provider:original-summary-id"
            call = get_function_call_for_tool_call({"id": opaque, "type": "function",
                "function": {"name": "current_summary", "arguments": arguments}}, functions)
            self.assertIsNotNone(call)
            self.assertEqual(call.call_id, opaque)
            injected = call._build_entrypoint_args()
            self.assertIs(injected["fc"], call)
            self.assertIs(injected["run_context"], self.context)
            result = call.execute()
            self.assertEqual(result.status, "success")
            self.assertEqual(self.requests[-1]["callId"], conversation_call_reference(self.context.run_id, opaque))
            self.assertEqual(self.requests[-1]["arguments"], {})
        self.assertEqual(len(self.requests), 4)

    def test_sdk_missing_id_is_not_generated_or_replaced_by_summary_entrypoint(self):
        functions = self.native_functions()
        for supplied in (None, ""):
            call = get_function_call_for_tool_call({"id": supplied, "type": "function",
                "function": {"name": "current_summary", "arguments": "{}"}}, functions)
            self.assertEqual(call.call_id, supplied)
            result = call.execute()
            self.assertEqual(result.status, "failure")
            self.assertEqual(result.error, "agentos_native_tool_call_required")
            self.assertEqual(call.call_id, supplied)
        self.assertEqual(self.requests, [])

    def test_sdk_model_fc_override_cannot_change_injected_provider_id_or_context(self):
        functions = self.native_functions()
        opaque = "synthetic/provider:original-id"
        call = get_function_call_for_tool_call({"id": opaque, "type": "function", "function": {
            "name": "current_summary", "arguments": json.dumps({"fc": {"call_id": "synthetic-forged-id"},
                "run_context": {"run_id": "synthetic-forged-context"}})}}, functions)
        result = call.execute()
        self.assertEqual(result.status, "success")
        self.assertEqual(call.call_id, opaque)
        self.assertEqual(call.arguments, {})
        self.assertEqual(self.requests[0]["callId"], conversation_call_reference(self.context.run_id, opaque))
        self.assertEqual(self.requests[0]["runId"], self.context.run_id)


if __name__ == "__main__":
    unittest.main()
