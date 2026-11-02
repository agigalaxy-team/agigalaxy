import asyncio
import json
import unittest
from types import SimpleNamespace
from uuid import uuid4
from agno.models.message import Message
from agno.models.response import ModelResponse
from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall
from galaxy_agentos.conversation_completion import with_conversation_completion
from galaxy_agentos.conversation_turn_plan import assess_turn_tool, plan_turn_tool
from galaxy_agentos.conversation_turn_state import (turn_state, PLAN, ACTIVITY, ASSESSMENT, TASK_PROGRESS,
    TASK_CONTEXT, RECEIPT_FEEDBACK, PREPARED_CARD_IDS)

class Model:
    def __init__(self, action): self.action=action; self.calls=0
    def response(self, messages, **kw):
        self.calls+=1; return self.action(self.calls,messages,kw['run_response'])
    async def aresponse(self,messages,**kw): return self.response(messages,**kw)
    def response_stream(self,messages,**kw): yield self.response(messages,**kw)
    async def aresponse_stream(self,messages,**kw): yield self.response(messages,**kw)

def run(): return SimpleNamespace(run_id=str(uuid4()),session_id=str(uuid4()),user_id='conversation:'+str(uuid4()),metadata={'operationId':str(uuid4())})

class TaskProgressTest(unittest.TestCase):
    def test_native_final_checkpoint_uses_server_business_state_all_paths(self):
        from dataclasses import dataclass
        from agno.agent import Agent
        from agno.models.base import Model as NativeModel
        from galaxy_agentos.model_usage import install_usage_scope

        @dataclass
        class Provider(NativeModel):
            id: str = "local-checkpoint"
            calls: int = 0
            def invoke(self, *args, **kwargs):
                self.calls += 1
                return ModelResponse(role="assistant", content="原模型答复")
            async def ainvoke(self, *args, **kwargs): return self.invoke(*args, **kwargs)
            def invoke_stream(self, *args, **kwargs): yield self.invoke(*args, **kwargs)
            async def ainvoke_stream(self, *args, **kwargs): yield self.invoke(*args, **kwargs)
            def _parse_provider_response(self, value, **kwargs): return value
            def _parse_provider_response_delta(self, value): return value

        for phase in ("completed", "waiting-confirmation"):
            for mode in ("sync", "async", "stream", "astream"):
                calls = []
                class Gateway:
                    def conversation_tool(self, user, name, args, **binding):
                        calls.append((name, args, binding))
                        return {"state": "recorded", "taskProgress": {"phase": phase, "remaining": []}}
                provider = Provider()
                install_usage_scope(provider)
                with_conversation_completion(provider, gateway=Gateway())
                agent = Agent(model=provider, telemetry=False)
                options = {"user_id": "conversation:" + str(uuid4()), "session_id": str(uuid4()),
                    "metadata": {"operationId": str(uuid4())}}
                if mode == "sync": result = agent.run("原问题", **options); content = result.content
                elif mode == "async": result = asyncio.run(agent.arun("原问题", **options)); content = result.content
                elif mode == "stream": content = "".join(str(e.content or "") for e in agent.run("原问题", stream=True, **options))
                else:
                    async def collect(): return [e async for e in agent.arun("原问题", stream=True, **options)]
                    content = "".join(str(e.content or "") for e in asyncio.run(collect()))
                self.assertIn("原模型答复", content)
                self.assertEqual(provider.calls, 1)
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0][1]["disposition"], "completed")
                if mode in ("sync", "async"):
                    self.assertEqual(turn_state(result)[TASK_PROGRESS]["phase"], phase)

    def test_completed_with_remaining_is_rejected_without_dispatch(self):
        sent=[]
        def send(*args): sent.append(args); return '{}'
        fn=assess_turn_tool(send); ctx=RunContext(run_id='r',session_id='s',metadata={'operationId':'o'}); call=FunctionCall(function=Function.from_callable(fn),call_id='c')
        turn_state(ctx)[ASSESSMENT]={'activity':0,'disposition':'completed','remaining':[]}
        result=json.loads(fn(ctx,call,'completed','仍有事',['处理剩余项']))
        self.assertEqual(result['state'],'invalid-request'); self.assertEqual(result['nextStep'],'correct-assessment'); self.assertEqual(sent,[]); self.assertNotIn(ASSESSMENT,turn_state(ctx))
    def test_async_native_provider_timeout_checkpoints_interrupted(self):
        from dataclasses import dataclass
        from agno.models.base import Model as NativeModel
        from agno.run.agent import RunOutput
        from agno.metrics import RunMetrics
        @dataclass
        class Slow(NativeModel):
            id: str='slow-local'; name: str='local'; provider: str='local'
            def invoke(self,*a,**k): return ModelResponse(content='late')
            async def ainvoke(self,*a,**k): await asyncio.sleep(0.1); return ModelResponse(content='late')
            def invoke_stream(self,*a,**k): yield ModelResponse(content='late')
            async def ainvoke_stream(self,*a,**k):
                await asyncio.sleep(0.1)
                yield ModelResponse(content='late')
            def _parse_provider_response(self,value,**kwargs): return value
            def _parse_provider_response_delta(self,value): return value
        calls=[]
        class Gateway:
            def conversation_tool(self,user,name,args,**binding):
                calls.append((name,args,binding)); return {'state':'recorded','taskProgress':{'phase':'interrupted','remaining':args['remaining']}}
        async def check():
            r=run(); native=RunOutput(run_id=r.run_id,session_id=r.session_id,user_id=r.user_id,metadata=r.metadata,metrics=RunMetrics())
            model=with_conversation_completion(Slow(),timeout_seconds=0.01,gateway=Gateway())
            return [event async for event in model.aresponse_stream([Message(role='user',content='本地测试')],run_response=native)]
        from galaxy_agentos.task_loop import TaskLoopTimeout
        with self.assertRaises(TaskLoopTimeout): asyncio.run(check())
        self.assertEqual(len(calls),1); self.assertEqual(calls[0][1]['disposition'],'interrupted')
    def test_assessment_failure_is_not_success_and_current_context_is_preserved(self):
        def send(ctx,fc,name,args): return json.dumps({'state':'unavailable'})
        fn=assess_turn_tool(send); ctx=RunContext(run_id='r',session_id='s',metadata={'operationId':'o'}); fc=FunctionCall(function=Function.from_callable(fn),call_id='c')
        turn_state(ctx)[TASK_PROGRESS]={'phase':'continue','remaining':['原工作']}; fn(ctx,fc,'completed','准备结束',[])
        self.assertNotIn(ASSESSMENT,turn_state(ctx)); self.assertEqual(turn_state(ctx)[TASK_PROGRESS]['remaining'],['原工作'])

    def test_new_plan_tool_activity_invalidates_prior_assessment(self):
        from galaxy_agentos.tool_reliability import reliable_function
        def send(ctx,fc,name,args): return json.dumps({'state':'recorded','turnPlan':{**args,'preparedCardIds':[]}})
        ctx=RunContext(run_id='r',session_id='s',metadata={'operationId':'o'})
        turn_state(ctx).update({ACTIVITY:1,ASSESSMENT:{'activity':1,'disposition':'completed','remaining':[]}})
        fn=reliable_function(plan_turn_tool(send)); call=FunctionCall(function=fn,call_id='c',arguments={'intent':'answer','proposal_count':1,'alternatives':False,'summary':'继续'})
        fn._run_context=ctx; call.execute()
        self.assertEqual(turn_state(ctx)[ACTIVITY],2); self.assertNotEqual(turn_state(ctx)[ASSESSMENT]['activity'],turn_state(ctx)[ACTIVITY])

    def test_server_assessment_is_recorded_and_new_activity_invalidates(self):
        calls=[]
        def send(ctx,fc,name,args): calls.append((name,args)); return json.dumps({'state':'needs-continuation','taskProgress':{'phase':'continue','remaining':['后续核对']}})
        fn=assess_turn_tool(send); ctx=RunContext(run_id='r',session_id='s',metadata={'operationId':'o'}); fc=FunctionCall(function=Function.from_callable(fn),call_id='c')
        turn_state(ctx)[ACTIVITY]=2; result=json.loads(fn(ctx,fc,'continue','继续',['后续核对']))
        self.assertEqual(calls[0][0],'assess-conversation-task'); self.assertEqual(result['state'],'needs-continuation')
        self.assertEqual(turn_state(ctx)[ASSESSMENT]['activity'],2); turn_state(ctx)[ACTIVITY]=3
        self.assertNotEqual(turn_state(ctx)[ASSESSMENT]['activity'],turn_state(ctx)[ACTIVITY]); self.assertEqual(turn_state(ctx)[TASK_PROGRESS]['remaining'],['后续核对'])

if __name__=='__main__': unittest.main()
