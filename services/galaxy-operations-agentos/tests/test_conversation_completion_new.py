import json
import asyncio
import unittest
from types import SimpleNamespace
from uuid import uuid4
from agno.models.message import Message
from agno.models.response import ModelResponse
from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall
from galaxy_agentos.conversation_completion import with_conversation_completion
from galaxy_agentos.conversation_turn_plan import ACTIVITY, ASSESSMENT, PLAN, plan_turn_tool, assess_turn_tool
from galaxy_agentos.conversation_turn_state import turn_state, bind_turn_state, TURN_STATE
from galaxy_agentos.p13_configuration import validate_configuration
from galaxy_agentos.tool_reliability import PREPARED_CARD_IDS

class Model:
    def __init__(self, fn): self.fn=fn; self.calls=0
    def response(self, messages, **kw):
        self.calls += 1; return self.fn(self.calls, messages, kw["run_response"])
    async def aresponse(self, messages, **kw): return self.response(messages, **kw)
    def response_stream(self, messages, **kw): yield self.response(messages, **kw)
    async def aresponse_stream(self, messages, **kw): yield self.response(messages, **kw)

class CompletionTest(unittest.TestCase):
    def test_unassessed_business_continues_once_then_accepts_assessment(self):
        def action(n, messages, run):
            if n == 1:
                turn_state(run)[ACTIVITY]=1
                messages.append(Message(role="tool", tool_name="query_operations", content=json.dumps({"state":"available"})))
            else: turn_state(run)[ASSESSMENT]={"activity":1,"disposition":"completed"}
            return ModelResponse(content=str(n))
        model=with_conversation_completion(Model(action)); messages=[]; run=SimpleNamespace(metadata={})
        out=model.response(messages, run_response=run)
        self.assertEqual(out.content,"2"); self.assertEqual(model.calls,2)
    def test_no_progress_blocked_and_greeting_unchecked(self):
        def action(n, messages, run):
            turn_state(run)[ACTIVITY]=1; return ModelResponse(content="fake completed")
        model=with_conversation_completion(Model(action)); run=SimpleNamespace(metadata={})
        out=model.response([], run_response=run)
        self.assertIn("尚未完成",out.content); self.assertEqual(model.calls,2)
        greeting=with_conversation_completion(Model(lambda n,m,r: ModelResponse(content="hello")))
        self.assertEqual(greeting.response([],run_response=SimpleNamespace(metadata={})).content,"hello"); self.assertEqual(greeting.calls,1)
    def test_prepare_plan_without_any_business_activity_is_not_done(self):
        def action(n, messages, run): return ModelResponse(content="已生成确认卡")
        model=with_conversation_completion(Model(action)); run=SimpleNamespace(metadata={})
        turn_state(run)[PLAN]={"intent":"prepare","proposalCount":1,"alternatives":False}
        out=model.response([],run_response=run)
        self.assertIn("尚未完成",out.content); self.assertEqual(model.calls,2)
    def test_three_requires_real_cards(self):
        def action(n, messages, run):
            turn_state(run).update({ACTIVITY:1, PLAN:{"intent":"prepare","proposalCount":3,"alternatives":True}, PREPARED_CARD_IDS:[str(uuid4())], ASSESSMENT:{"activity":1,"disposition":"awaiting-confirmation"}})
            return ModelResponse(content="ready")
        model=with_conversation_completion(Model(action)); out=model.response([],run_response=SimpleNamespace(metadata={}))
        self.assertIn("尚未完成",out.content)
    def test_stream_discards_prior_answers_and_no_progress_is_bounded(self):
        def action(n, messages, run):
            turn_state(run)[ACTIVITY]=1
            if n == 2: turn_state(run)[ASSESSMENT]={"activity":1,"disposition":"completed"}
            return ModelResponse(content="old" if n == 1 else "final")
        for async_mode in (False, True):
            model=with_conversation_completion(Model(action)); run=SimpleNamespace(metadata={})
            if async_mode:
                async def collect(): return [v async for v in model.aresponse_stream([],run_response=run)]
                result=asyncio.run(collect())
            else: result=list(model.response_stream([],run_response=run))
            self.assertEqual([v.content for v in result if v.content], ["final"])
            self.assertEqual(model.calls,2)
    def test_live_deltas_are_not_collected_until_end(self):
        class Live(Model):
            def response_stream(self, messages, **kw):
                yield ModelResponse(event="ModelRequestStarted")
                yield ModelResponse(content="第一段")
                self.finished = True
                yield ModelResponse(content="第二段")
        model=Live(None); model.finished=False
        model=with_conversation_completion(model)
        events=model.response_stream([],run_response=SimpleNamespace(metadata={}))
        self.assertEqual(next(events).event,"ModelRequestStarted")
        self.assertFalse(model.finished)
        self.assertEqual(next(events).content,"第一段")
        self.assertFalse(model.finished)
        self.assertEqual(next(events).content,"第二段")
        self.assertTrue(model.finished)

    def test_metadata_copy_and_concurrent_runs_keep_separate_holders(self):
        def pair():
            run=SimpleNamespace(run_id=str(uuid4()),session_id=str(uuid4()),user_id="conversation:"+str(uuid4()),metadata={"operationId":str(uuid4())})
            context=SimpleNamespace(run_id=run.run_id,session_id=run.session_id,user_id=run.user_id,metadata=dict(run.metadata))
            bind_turn_state(run,context); return run,context
        first,context=pair(); other,other_context=pair()
        first.metadata={**first.metadata,"modelCalls":1}; turn_state(context)[ACTIVITY]=7
        self.assertEqual(turn_state(first)[ACTIVITY],7)
        self.assertIs(first.metadata[TURN_STATE],context.metadata[TURN_STATE])
        self.assertNotIn(ACTIVITY,turn_state(other)); self.assertIsNot(turn_state(first),turn_state(other_context))
        context.metadata["operationId"]=str(uuid4()); self.assertNotIn(ACTIVITY,turn_state(context))
    def test_receipt_feedback_is_not_persisted_from_live_holder(self):
        from galaxy_agentos.conversation_storage import conversation_storage_fields
        from galaxy_agentos.conversation_turn_state import RECEIPT_FEEDBACK
        run=SimpleNamespace(run_id="r",metadata={"operationId":"o"})
        turn_state(run)[RECEIPT_FEEDBACK]={"receipt":{"summary":"本轮敏感正文"}}
        fields=conversation_storage_fields({"metadata":run.metadata})
        self.assertNotIn(RECEIPT_FEEDBACK,fields["metadata"][TURN_STATE])
        self.assertIn(RECEIPT_FEEDBACK,turn_state(run))
    def test_parallel_native_usage_copies_retain_only_own_state(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        from galaxy_agentos.model_usage import _RUN, _begin
        from agno.run.agent import RunOutput
        barrier=Barrier(2)
        def worker():
            run=RunOutput(run_id=str(uuid4()),session_id=str(uuid4()),user_id="conversation:"+str(uuid4()),metadata={"operationId":str(uuid4())})
            context=RunContext(run_id=run.run_id,session_id=run.session_id,user_id=run.user_id,metadata=dict(run.metadata))
            bind_turn_state(run,context); token=_RUN.set(run)
            try:
                turn_state(context)[ACTIVITY]=1; barrier.wait(timeout=5)
                _begin(SimpleNamespace()); barrier.wait(timeout=5)
                self.assertEqual(turn_state(run)[ACTIVITY],1); self.assertIs(turn_state(run),turn_state(context))
                return run.metadata[TURN_STATE]
            finally: _RUN.reset(token)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:worker(),range(2)))
        self.assertIsNot(results[0],results[1]); self.assertNotEqual(results[0]["operationId"],results[1]["operationId"])
    def test_rejected_plan_downgrade_keeps_three(self):
        def send(ctx,fc,name,args):
            if args["proposalCount"]==3: return json.dumps({"turnPlan":{**args,"preparedCardIds":[]}})
            return json.dumps({"state":"invalid-request","reason":"plan-conflict"})
        fn=plan_turn_tool(send); context=RunContext(run_id="r",session_id="s",metadata={"operationId":"o"}); call=FunctionCall(function=Function.from_callable(fn),call_id="one")
        fn(context,call,"prepare",3,True,"three"); fn(context,call,"prepare",1,False,"one")
        self.assertEqual(turn_state(context)[PLAN]["proposalCount"],3)

    def test_invalid_configuration_never_calls_gateway(self):
        from galaxy_agentos.conversation_tools import conversation_tools
        class Gateway:
            def conversation_tool(self, *args, **kwargs): raise AssertionError("invalid config dispatched")
        prepare=conversation_tools(Gateway())[-1]
        from galaxy_agentos.conversation_tool_contracts import StrategyDraft
        operation=StrategyDraft(kind="strategy-draft", configuration={}, reason="test")
        value=json.loads(prepare(RunContext(run_id="r", session_id="s", metadata={}), None, operation))
        self.assertEqual(value["reason"],"strategy_configuration_schema_invalid")
        self.assertFalse(value["cardPrepared"])
    def test_plan_is_server_acknowledged_and_schema_errors_bounded(self):
        def send(ctx, fc, name, args): return json.dumps({"turnPlan":{**args,"preparedCardIds":[]}})
        fn=plan_turn_tool(send); context=RunContext(run_id="run", session_id="session", metadata={}); call=FunctionCall(function=Function.from_callable(fn),call_id="one")
        fn(context,call,"prepare",3,True,"three")
        self.assertEqual(turn_state(context)[PLAN]["proposalCount"],3)
        result=validate_configuration({}); self.assertEqual(result["state"],"invalid-request"); self.assertLessEqual(len(result["errors"]),8)

if __name__ == "__main__": unittest.main()
