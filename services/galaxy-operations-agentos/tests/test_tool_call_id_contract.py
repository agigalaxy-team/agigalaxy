"""Actual SDK tool entrypoints and closed local HTTP fixtures; no model run."""
import copy
from dataclasses import dataclass
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from uuid import UUID, uuid4

from agno.db.sqlite import SqliteDb
from agno.models.base import Model
from agno.models.message import Message
from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall
import httpx

from galaxy_agentos.conversation_storage import conversation_storage_fields
from galaxy_agentos.conversation_tools import conversation_tools, _feedback_filter_feedback
from galaxy_agentos.conversations import conversation_agents
from galaxy_agentos.duty_continuation import call_reference
from galaxy_agentos.gateway import AuthorityDenied, GalaxyGateway
from galaxy_agentos.tool_call_ids import conversation_call_reference, projected_tool_call_id, valid_tool_call_id


@dataclass
class NeverInvokedModel(Model):
    id: str = "explicit-synthetic-no-run"
    name: str = "NeverInvoked"
    provider: str = "NoProvider"

    def invoke(self, *args, **kwargs):
        raise AssertionError("no model is invoked by this finite tool fixture")

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


class ToolCallIdContractTest(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.context = RunContext(run_id=str(uuid4()), session_id=str(uuid4()),
            user_id="conversation:" + str(uuid4()), metadata={"operationId": str(uuid4())})
        self.settings = SimpleNamespace(authority_url="http://127.0.0.1:1/v1/internal/agentos/",
            service_key="explicit-local-synthetic-key")
        self.transport = httpx.MockTransport(self.respond)
        self.gateway = GalaxyGateway(self.settings, transport=self.transport)
        self.addCleanup(self.gateway.close)

    def respond(self, request):
        body = json.loads(request.content)
        self.requests.append(body)
        return httpx.Response(200, json={"state": "available", "source": "explicit-local-fixture",
            "effectExecuted": False})

    def execute(self, tool, call_id, arguments=None):
        function = Function.from_callable(tool)
        function.process_entrypoint()
        function._run_context = self.context
        call = FunctionCall(function=function, call_id=call_id, arguments=arguments or {})
        return call, call.execute()

    def binding(self, call_id):
        return {"run_id": self.context.run_id, "session_id": self.context.session_id,
            "turn_id": self.context.metadata["operationId"], "call_id": call_id}

    def summary(self, gateway):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        db = SqliteDb(db_file=str(Path(directory.name) / "sdk-construction.db"), id="opaque-fixture")
        agents = conversation_agents(settings=SimpleNamespace(), db=db, gateway=gateway,
            domains={"overview": "synthetic"}, active_domains={"overview"}, model_factory=NeverInvokedModel)
        return agents[0].tools[0]

    def test_old_gateway_reproduces_same_closed_pre_node_failure_for_synthetic_opaque_id(self):
        # This deliberately synthetic shape is not a recovered production ID.
        namespace = {"__name__": "synthetic_native30_gateway"}
        source = Path(os.environ.get("NATIVE30_GATEWAY_FIXTURE",
            Path(__file__).with_name("fixtures") / "native30_gateway.py"))
        exec(compile(source.read_text("utf-8"), str(source), "exec"), namespace)
        old = namespace["GalaxyGateway"](self.settings, transport=self.transport)
        self.addCleanup(old.close)
        call, outcome = self.execute(self.summary(old), "provider/call+summary:1")
        self.assertEqual(outcome.status, "failure")
        self.assertEqual(outcome.error, "agentos_tool_arguments_invalid")
        self.assertEqual(call.error, "agentos_tool_arguments_invalid")
        self.assertEqual(self.requests, [])

    def test_actual_current_summary_sdk_entrypoint_accepts_opaque_id_without_repair(self):
        opaque = "provider/call+summary:1.with-dot"
        call, result = self.execute(self.summary(self.gateway), opaque)
        self.assertEqual(result.status, "success")
        self.assertEqual(json.loads(result.result)["state"], "available")
        self.assertEqual(self.requests[-1]["callId"], conversation_call_reference(self.context.run_id, opaque))
        self.assertEqual(self.requests[-1]["arguments"], {})
        self.assertEqual(call.call_id, opaque)
        self.assertEqual(len(self.requests), 1)

    def test_query_sdk_entrypoint_preserves_all_printable_ascii_pairing_and_200_boundary(self):
        query = conversation_tools(self.gateway)[0]
        identifiers = ["call.simple:with/slash+plus", "quote\"and\\backslash", "".join(map(chr, range(33, 127))), "x" * 200]
        for opaque in identifiers:
            with self.subTest(length=len(opaque)):
                arguments = {"module": "analytics", "view": "overview", "filters": {"days": 7}}
                assistant = Message(role="assistant", tool_calls=[{"id": opaque, "type": "function",
                    "function": {"name": "query_operations", "arguments": json.dumps(arguments)}}])
                call, result = self.execute(query, assistant.tool_calls[0]["id"], arguments)
                self.assertEqual(result.status, "success")
                tool_message = Message(role="tool", tool_call_id=call.call_id, content=result.result)
                self.assertEqual(assistant.tool_calls[0]["id"], tool_message.tool_call_id)
                self.assertEqual(self.requests[-1]["callId"], conversation_call_reference(self.context.run_id, opaque))
                self.assertEqual(self.requests[-1]["arguments"], arguments)
                self.assertTrue(valid_tool_call_id(opaque))
                self.assertEqual(projected_tool_call_id(opaque), opaque)
        self.assertEqual(len(self.requests), len(identifiers))

    def test_invalid_call_id_is_distinct_closed_error_without_node_or_value_echo(self):
        for value in ("", " x", "x ", "x y", "\t", "a\nb", "\x00", "\x1f", "\x7f", "银河", "x" * 16385, None, 123):
            with self.subTest(kind=type(value).__name__):
                self.assertFalse(valid_tool_call_id(value))
                self.assertIsNone(projected_tool_call_id(value))
                with self.assertRaisesRegex(AuthorityDenied, "^agentos_tool_call_id_invalid$"):
                    self.gateway.conversation_tool(self.context.user_id, "workbench-summary", {}, **self.binding(value))
        self.assertEqual(self.requests, [])

    def test_only_call_id_contract_changes_authority_and_run_context_remain_strict(self):
        binding = self.binding("provider/call:opaque")
        for key, value in (("run_id", "run/opaque"), ("session_id", "session/opaque"), ("turn_id", "turn/opaque")):
            with self.subTest(field=key), self.assertRaises(AuthorityDenied):
                self.gateway.conversation_tool(self.context.user_id, "query-operations", {}, **{**binding, key: value})
        with self.assertRaises(AuthorityDenied):
            self.gateway.conversation_tool("conversation:provider/opaque", "query-operations", {}, **binding)
        task, run = str(uuid4()), str(uuid4())
        first = call_reference(task, run, binding["call_id"])
        self.assertEqual(first, call_reference(task, run, binding["call_id"]))
        self.assertEqual(str(UUID(first)), first)
        self.assertNotEqual(first, binding["call_id"])
        self.assertEqual(self.requests, [])

    def test_storage_keeps_opaque_pairing_only_and_still_scrubs_arguments_results_and_invalid_authority_ids(self):
        opaque = 'provider/call+opaque:1."\\'
        original = {"tools": [{"tool_call_id": opaque, "tool_name": "query_operations", "tool_call_error": False,
            "tool_args": {"query": "synthetic-private-input"}, "result": "synthetic-private-result"}],
            "events": [{"event": "ToolCallCompleted", "run_id": "run/opaque", "session_id": "session/opaque",
                "tool": {"tool_call_id": opaque, "tool_name": "query_operations", "tool_args": {"private": True}}}],
            "messages": [{"role": "assistant", "tool_calls": [{"id": opaque}]}, {"role": "tool", "tool_call_id": opaque}],
            "additional_input": "synthetic-additional-private"}
        preserved = copy.deepcopy(original)
        projected = conversation_storage_fields(original)
        self.assertEqual(original, preserved)
        self.assertEqual(projected["tools"][0]["tool_call_id"], opaque)
        self.assertEqual(projected["events"][0]["tool"]["tool_call_id"], opaque)
        self.assertNotIn("run_id", projected["events"][0])
        self.assertNotIn("session_id", projected["events"][0])
        self.assertEqual(projected["messages"], [])
        self.assertIsNone(projected["additional_input"])
        text = json.dumps(projected)
        self.assertNotIn("synthetic-private-input", text)
        self.assertNotIn("synthetic-private-result", text)
        self.assertNotIn("tool_args", text)

    def test_feedback_query_is_rejected_without_dropping_it_or_leaking_values(self):
        query = conversation_tools(self.gateway)[0]
        call, result = self.execute(query, "provider/feedback:1", {"module": "feedback", "view": "list",
            "filters": {"days": 7, "query": "synthetic-private-query-marker"}})
        self.assertEqual(result.status, "success")
        feedback = json.loads(result.result)
        self.assertEqual(feedback["state"], "invalid-request")
        self.assertEqual(feedback["allowedFilterKeys"], ["category", "module", "state", "days", "after", "limit"])
        self.assertEqual(feedback["scope"], "feedback-metadata-only")
        self.assertFalse(feedback["dataRead"])
        self.assertFalse(feedback["effectExecuted"])
        self.assertNotIn("synthetic-private-query-marker", result.result)
        self.assertEqual(feedback["issues"], [{"path": "filters", "code": "unsupported-filter"}])
        for values in ({"days": 30}, {"state": "synthetic-private-state"}, {"after": "9223372036854775808"},
                {"after": "0"}, {"category": "technology"}, {"synthetic-private-key": "synthetic-private-value"}):
            closed = _feedback_filter_feedback(values)
            self.assertEqual(closed["state"], "invalid-request")
            self.assertLessEqual(len(closed["issues"]), 5)
            self.assertNotIn("synthetic-private", json.dumps(closed))
        self.assertEqual(self.requests, [])

    def test_feedback_valid_metadata_is_forwarded_unchanged_and_prose_requires_selected_read(self):
        query, read = conversation_tools(self.gateway)[:2]
        for filters in ({"days": 7}, {"category": "unclassified", "module": "other", "state": "pending", "days": 28,
                "after": "9223372036854775807", "limit": 25}, {"days": "all", "limit": 100}):
            _, result = self.execute(query, "provider/metadata:1", {"module": "feedback", "view": "list", "filters": filters})
            self.assertEqual(result.status, "success")
            self.assertEqual(self.requests[-1]["arguments"], {"module": "feedback", "view": "list", "filters": filters})
        selected = str(uuid4())
        _, result = self.execute(read, "provider/selected-feedback:1", {"kind": "feedback", "id": selected})
        self.assertEqual(result.status, "success")
        self.assertEqual(self.requests[-1]["arguments"], {"kind": "feedback", "id": selected})
        self.assertIn("It does not accept query or search titles/bodies", query.__doc__)
        self.assertIn('read_operation_object(kind="feedback"', query.__doc__)
        self.assertEqual(len(self.requests), 4)


if __name__ == "__main__":
    unittest.main()
