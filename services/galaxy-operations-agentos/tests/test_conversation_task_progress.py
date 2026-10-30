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
    def test_plain_answer_checkpoint_once_without_extra_model_all_paths(self):
        for mode in ('sync','async','stream','astream'):
            calls=[]
            class Gateway:
                def conversation_tool(self,user,name,args,**binding):
                    calls.append((user,name,args,binding)); return {'state':'recorded','taskProgress':{'phase':'completed','remaining':[]}}
            r=run(); model=with_conversation_completion(Model(lambda n,m,r:ModelResponse(content='你好')),gateway=Gateway())
            if mode=='sync': content=model.response([],run_response=r).content
            elif mode=='async': content=asyncio.run(model.aresponse([],run_response=r)).content
            elif mode=='stream': content=''.join(e.content for e in model.response_stream([],run_response=r) if e.content)
            else:
                async def collect(): return [e async for e in model.aresponse_stream([],run_response=r)]
                content=''.join(e.content for e in asyncio.run(collect()) if e.content)
            self.assertEqual(content,'你好'); self.assertEqual(model.calls,1); self.assertEqual(len(calls),1); self.assertEqual(calls[0][2]['disposition'],'completed'); self.assertEqual(turn_state(r)[TASK_PROGRESS]['phase'],'completed')
    def test_prepare_wait_checkpoint_preserves_remaining(self):
        calls=[]
        class Gateway:
            def conversation_tool(self,user,name,args,**binding):
                calls.append(args); return {'state':'recorded','taskProgress':{'phase':'waiting-confirmation','remaining':args['remaining']}}
        r=run(); turn_state(r).update({PLAN:{'intent':'prepare','proposalCount':1,'alternatives':False},PREPARED_CARD_IDS:[str(uuid4())], TASK_PROGRESS:{'phase':'continue','remaining':['确认后核对']}})
        model=with_conversation_completion(Model(lambda n,m,r:ModelResponse(content='模型正文')),gateway=Gateway())
        self.assertIn('当前尚未执行',model.response([],run_response=r).content); self.assertEqual(calls[0]['disposition'],'awaiting-confirmation'); self.assertEqual(calls[0]['remaining'],['确认后核对']); self.assertEqual(turn_state(r)[TASK_PROGRESS]['phase'],'waiting-confirmation')

    def test_more_than_three_progress_steps_are_not_stopped(self):
        def action(n,messages,run):
            state=turn_state(run); state[ACTIVITY]=n
            messages.append(Message(role='tool',tool_name='query_operations',tool_call_id=str(n),content=json.dumps({'state':'available','page':n})))
            state[ASSESSMENT]={'activity':n,'disposition':'continue' if n<6 else 'completed','reason':'继续','remaining':['处理下一项'] if n<6 else []}
            return ModelResponse(content='finished' if n==6 else 'partial')
        model=with_conversation_completion(Model(action)); self.assertEqual(model.response([],run_response=run()).content,'finished'); self.assertEqual(model.calls,6)
    def test_completed_with_remaining_is_rejected_without_dispatch(self):
        sent=[]
        def send(*args): sent.append(args); return '{}'
        fn=assess_turn_tool(send); ctx=RunContext(run_id='r',session_id='s',metadata={'operationId':'o'}); call=FunctionCall(function=Function.from_callable(fn),call_id='c')
        turn_state(ctx)[ASSESSMENT]={'activity':0,'disposition':'completed','remaining':[]}
        result=json.loads(fn(ctx,call,'completed','仍有事',['处理剩余项']))
        self.assertEqual(result['state'],'invalid-request'); self.assertEqual(result['nextStep'],'correct-assessment'); self.assertEqual(sent,[]); self.assertNotIn(ASSESSMENT,turn_state(ctx))
    def test_waiting_card_is_not_completed_and_feedback_resumes_original_task(self):
        r=run(); turn_state(r).update({PLAN:{'intent':'prepare','proposalCount':1,'alternatives':False}, PREPARED_CARD_IDS:[str(uuid4())], TASK_PROGRESS:{'phase':'waiting-confirmation','remaining':['核对结果']}})
        model=with_conversation_completion(Model(lambda n,m,r:ModelResponse(content='fake')))
        self.assertIn('当前尚未执行',model.response([],run_response=r).content); self.assertEqual(turn_state(r)[TASK_PROGRESS]['phase'],'waiting-confirmation')
        feedback=run(); turn_state(feedback).update({TASK_CONTEXT:{'objective':'原目标','objectiveAvailable':True,'remaining':['核对结果']}, RECEIPT_FEEDBACK:{'state':'completed'}, TASK_PROGRESS:{'phase':'continue','remaining':['核对结果']}})
        def resume(n,m,r):
            if n==1: return ModelResponse(content='仅反馈原卡')
            turn_state(r).update({ACTIVITY:1,ASSESSMENT:{'activity':1,'disposition':'completed','remaining':[]}}); return ModelResponse(content='核对已完成')
        model=with_conversation_completion(Model(resume)); result=model.response([],run_response=feedback)
        self.assertEqual(result.content,'核对已完成'); self.assertEqual(model.calls,2)
    def test_recorded_blocked_takes_precedence_over_prepared_card(self):
        r=run(); turn_state(r).update({PLAN:{"intent":"prepare","proposalCount":1,"alternatives":False}, PREPARED_CARD_IDS:[str(uuid4())], ACTIVITY:1, ASSESSMENT:{"activity":1,"disposition":"blocked","remaining":["其他工作"]}, TASK_PROGRESS:{"phase":"blocked","remaining":["其他工作"]}})
        model=with_conversation_completion(Model(lambda n,m,r:ModelResponse(content="其他工作受阻。")))
        self.assertEqual(model.response([],run_response=r).content,"其他工作受阻。")
        self.assertEqual(turn_state(r)[TASK_PROGRESS]["phase"],"blocked")
    def test_different_failed_methods_can_continue_until_alternative_succeeds(self):
        def action(n,messages,r):
            state=turn_state(r); state[ACTIVITY]=n; state[ASSESSMENT]={'activity':n,'disposition':'continue' if n<4 else 'completed','reason':'尝试其他方法','remaining':['读取'] if n<4 else []}
            ident=str(n); messages.append(Message(role='assistant',tool_calls=[{'id':ident,'type':'function','function':{'name':'query_operations','arguments':json.dumps({'view':n})}}]))
            messages.append(Message(role='tool',tool_call_id=ident,tool_name='query_operations',content=json.dumps({'state':'unavailable' if n<4 else 'available'})))
            return ModelResponse(content='完成' if n==4 else '尝试')
        model=with_conversation_completion(Model(action)); self.assertEqual(model.response([],run_response=run()).content,'完成'); self.assertEqual(model.calls,4)
    def test_timeout_persists_interrupted_with_original_binding(self):
        calls=[]
        class Gateway:
            def conversation_tool(self,user,name,args,**binding):
                calls.append((user,name,args,binding)); return {'state':'recorded','taskProgress':{'phase':'interrupted','remaining':args['remaining']}}
        r=run(); turn_state(r)[TASK_PROGRESS]={'phase':'continue','remaining':['原工作'+str(n) for n in range(12)]}
        model=with_conversation_completion(Model(lambda n,m,r:ModelResponse(content='不能称完成')),timeout_seconds=0,gateway=Gateway())
        self.assertIn('已中断',model.response([],run_response=r).content)
        self.assertEqual(turn_state(r)[TASK_PROGRESS]['phase'],'interrupted'); self.assertEqual(len(calls),1)
        self.assertEqual(calls[0][2]['remaining'],['原工作'+str(n) for n in range(12)]); self.assertEqual(calls[0][3]['turn_id'],r.metadata['operationId']); self.assertEqual(calls[0][3]['run_id'],r.run_id)
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
        events=asyncio.run(check()); self.assertTrue(any('已中断' in str(event.content) for event in events)); self.assertEqual(len(calls),1); self.assertEqual(calls[0][1]['disposition'],'interrupted')
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
