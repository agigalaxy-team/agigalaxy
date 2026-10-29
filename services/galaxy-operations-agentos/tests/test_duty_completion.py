import asyncio
import json
import unittest
from types import SimpleNamespace

from agno.models.message import Message
from agno.models.response import ModelResponse, ToolExecution
from galaxy_agentos.duty_completion import DutyCompletionIncomplete, with_duty_completion


class Gateway:
    def __init__(self, states):
        self.states = iter(states)
    def duty_authorize(self, _user, *, operation):
        return {"task": {"completion": {"disposition": next(self.states)}}}


class Model:
    def __init__(self, values): self.values = iter(values)
    def response(self, messages, **kwargs): return next(self.values)
    async def aresponse(self, messages, **kwargs): return next(self.values)


def tool(ident, paused=False):
    return ToolExecution(tool_call_id=ident, tool_name="synthetic", external_execution_required=paused)


class CompletionTests(unittest.TestCase):
    def test_same_run_continues_and_keeps_tool_ids(self):
        model = with_duty_completion(Model([ModelResponse(content="partial", tool_executions=[tool("one")]),
            ModelResponse(content="done", tool_executions=[tool("two")])]), Gateway(["continue", "completed"]))
        run = SimpleNamespace(user_id="autonomy:test", requirements=[], metadata={})
        messages = [Message(role="user", content="task")]
        result = asyncio.run(model.aresponse(messages=messages, run_response=run))
        self.assertEqual(result.content, "done")
        self.assertEqual([t.tool_call_id for t in result.tool_executions], ["one", "two"])
        self.assertEqual(len(messages), 2)

    def test_pause_never_queries_completion(self):
        model = with_duty_completion(Model([ModelResponse(tool_executions=[tool("pause", True)])]), Gateway([]))
        run = SimpleNamespace(user_id="autonomy:test", requirements=[], metadata={})
        self.assertTrue(model.response(messages=[], run_response=run).tool_executions[0].external_execution_required)

    def test_unrecorded_local_validation_failure_cannot_finish_run(self):
        model = with_duty_completion(Model([ModelResponse(content="done")]), Gateway([]))
        run = SimpleNamespace(user_id="autonomy:test", requirements=[], metadata={"_galaxyDutyValidationLedgerFailed": True})
        with self.assertRaises(DutyCompletionIncomplete):
            model.response(messages=[], run_response=run)

    def test_repeated_same_fact_with_new_call_ids_is_not_progress(self):
        values = [ModelResponse(tool_executions=[ToolExecution(tool_call_id=str(i), tool_name="query_operations", tool_args={"module":"feedback", "view":"list"}, result=json.dumps({"availability":"available", "checkedAt":i, "data":{"items":[]}}))]) for i in range(4)]
        model = with_duty_completion(Model(values), Gateway(["continue"] * 4))
        run = SimpleNamespace(user_id="autonomy:test", requirements=[], metadata={})
        with self.assertRaises(DutyCompletionIncomplete):
            model.response(messages=[], run_response=run)

    def test_new_scope_or_changed_fact_resets_progress(self):
        values = [ModelResponse(tool_executions=[ToolExecution(tool_call_id=str(i), tool_name="query_operations", tool_args={"module":"feedback", "view":"list", "filters":{"state": state}}, result=json.dumps({"availability":"available", "data":{"items":[state]}}))]) for i, state in enumerate(["pending", "pending", "closed", "closed"])]
        model = with_duty_completion(Model(values), Gateway(["continue", "continue", "continue", "completed"]))
        run = SimpleNamespace(user_id="autonomy:test", requirements=[], metadata={})
        self.assertIsNotNone(model.response(messages=[], run_response=run))

    def test_no_progress_bounded(self):
        model = with_duty_completion(Model([ModelResponse(content="no") for _ in range(3)]), Gateway(["continue"] * 3))
        run = SimpleNamespace(user_id="autonomy:test", requirements=[], metadata={})
        with self.assertRaises(DutyCompletionIncomplete):
            model.response(messages=[], run_response=run)
        self.assertEqual(run.metadata["completionFailureCode"], "operations_autonomy_completion_incomplete")
