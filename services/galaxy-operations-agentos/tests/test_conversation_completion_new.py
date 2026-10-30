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
from galaxy_agentos.conversation_turn_state import turn_state, bind_turn_state, TURN_STATE, TASK_CONTEXT, TASK_PROGRESS
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
    def test_interrupted_resumed_task_plain_answer_does_not_complete(self):
        model = with_conversation_completion(Model(lambda n,m,r: ModelResponse(content="已完成")))
        run = SimpleNamespace(metadata={"operationId":"retry"})
        turn_state(run)[TASK_CONTEXT] = {"rootOperationId":"root", "phase":"interrupted", "remaining":[]}
        turn_state(run)[TASK_PROGRESS] = {"phase":"interrupted", "remaining":[]}
        result = model.response([], run_response=run)
        self.assertIn("尚未完成", result.content)
        self.assertEqual(model.calls, 2)
        self.assertNotEqual(turn_state(run)[TASK_PROGRESS]["phase"], "completed")

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
    def test_three_real_cards_finish_without_assessment_or_extra_request(self):
        ids=[str(uuid4()) for _ in range(3)]
        for async_mode in (False, True):
            def action(n,messages,run):
                turn_state(run).update({PLAN:{"intent":"prepare","proposalCount":3,"alternatives":True}, ACTIVITY:3, PREPARED_CARD_IDS:ids})
                return ModelResponse(content="三张卡等待确认。")
            model=with_conversation_completion(Model(action)); run=SimpleNamespace(metadata={})
            if async_mode:
                async def collect(): return [v async for v in model.aresponse_stream([],run_response=run)]
                result=asyncio.run(collect())
            else: result=list(model.response_stream([],run_response=run))
            self.assertEqual(model.calls,1); self.assertEqual([v.content for v in result if v.content],["已准备 3 个备选方案，请在下方选择一项。当前尚未执行。"]); self.assertEqual(turn_state(run)[ASSESSMENT]["disposition"], "waiting-confirmation")
    def test_prepare_notice_replaces_model_text_and_preserves_live_events(self):
        from galaxy_agentos.conversation_completion import _PREPARED_ONE, _PREPARED_THREE
        for count, notice in ((1,_PREPARED_ONE),(3,_PREPARED_THREE)):
            for async_mode in (False,True):
                run=SimpleNamespace(metadata={}); turn_state(run)[PLAN]={"intent":"prepare","proposalCount":count,"alternatives":count==3}
                class Live(Model):
                    def response_stream(self,messages,**kw):
                        yield ModelResponse(event="ModelRequestStarted")
                        yield ModelResponse(content="内部字段 UUID 和命令")
                        turn_state(run)[PREPARED_CARD_IDS]=[str(uuid4()) for _ in range(count)]
                        yield ModelResponse(event="ToolCallCompleted")
                        yield ModelResponse(content="内部字段又出现")
                    async def aresponse_stream(self,messages,**kw):
                        for item in self.response_stream(messages,**kw): yield item
                model=with_conversation_completion(Live(None))
                if async_mode:
                    async def collect(): return [v async for v in model.aresponse_stream([],run_response=run)]
                    events=asyncio.run(collect())
                else: events=list(model.response_stream([],run_response=run))
                self.assertEqual([e.content for e in events if e.content],[notice])
                self.assertEqual([e.event for e in events if not e.content],["ModelRequestStarted","ToolCallCompleted"])
                def action(n,m,r): return ModelResponse(content="内部字段 UUID")
                model=with_conversation_completion(Model(action)); self.assertEqual(model.response([],run_response=run).content,notice)
                self.assertEqual(asyncio.run(model.aresponse([],run_response=run)).content,notice)
    def test_prepare_needing_information_keeps_honest_content(self):
        run=SimpleNamespace(metadata={}); turn_state(run).update({PLAN:{"intent":"prepare","proposalCount":3,"alternatives":True}, ACTIVITY:1, ASSESSMENT:{"activity":1,"disposition":"needs-information"}})
        model=with_conversation_completion(Model(lambda n,m,r:ModelResponse(content="请补充目标。")))
        self.assertEqual([e.content for e in model.response_stream([],run_response=run) if e.content],["请补充目标。"])

    def test_three_target_zero_or_two_real_cards_still_incomplete(self):
        for count in (0,2):
            def action(n,messages,run): return ModelResponse(content="未核验完成")
            run=SimpleNamespace(metadata={}); turn_state(run).update({PLAN:{"intent":"prepare","proposalCount":3,"alternatives":True},PREPARED_CARD_IDS:[str(uuid4()) for _ in range(count)]})
            model=with_conversation_completion(Model(action)); result=model.response([],run_response=run)
            self.assertIn("尚未完成",result.content); self.assertEqual(model.calls,2)
    def test_two_continuations_merge_one_system_preserve_tool_pairing(self):
        for initial_system in (True, False):
            assistant=Message(role="assistant",tool_calls=[{"id":"call-original","type":"function","function":{"name":"query_operations","arguments":"{}"}}])
            tool=Message(role="tool",tool_call_id="call-original",tool_name="query_operations",content=json.dumps({"state":"available","value":0}))
            user=Message(role="user",content="问题")
            messages=([Message(role="system",content="原规则")] if initial_system else [])+[user,assistant,tool]
            original=[m for m in messages if m.role!="system"]; run=SimpleNamespace(metadata={})
            def action(n,messages,run):
                turn_state(run)[ACTIVITY]=n
                if n<3: messages.append(Message(role="tool",tool_call_id="synthetic-"+str(n),tool_name="query_operations",content=json.dumps({"state":"available","value":n})))
                else: turn_state(run)[ASSESSMENT]={"activity":n,"disposition":"completed"}
                return ModelResponse(content="最终" if n==3 else "暂未完成")
            model=with_conversation_completion(Model(action)); self.assertEqual(model.response(messages,run_response=run).content,"最终")
            self.assertEqual(model.calls,3); systems=[m for m in messages if m.role=="system"]; self.assertEqual(len(systems),1); self.assertEqual(messages[0].role,"system")
            from galaxy_agentos.conversation_completion import _PROMPT
            self.assertEqual(systems[0].content.count(_PROMPT),1)
            self.assertEqual([m for m in messages if m in original],original); self.assertEqual(assistant.tool_calls[0]["id"],tool.tool_call_id)

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
