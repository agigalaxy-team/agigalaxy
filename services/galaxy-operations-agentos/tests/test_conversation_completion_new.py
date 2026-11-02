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
    def test_native_continuation_is_provider_input_not_an_extra_user_turn(self):
        from dataclasses import dataclass,field
        import tempfile
        from pathlib import Path
        from galaxy_agentos.conversation_retry import ConversationAgent as Agent
        from agno.models.base import Model as NativeModel
        from agno.db.sqlite import SqliteDb
        from galaxy_agentos.model_usage import _RUN,install_usage_scope
        for streaming,asynchronous in ((False,False),(True,False),(False,True),(True,True)):
            @dataclass
            class StrictProvider(NativeModel):
                id: str = "strict-continuation-fixture"
                name: str = "local"
                provider: str = "local"
                calls: int = 0
                snapshots: list = field(default_factory=list)
                def invoke(self,messages,**kwargs):
                    self.calls+=1;self.snapshots.append(list(messages))
                    state=turn_state(_RUN.get())
                    if self.calls in (1,3):
                        if self.calls==3:
                            if messages[-1].role!="user" or messages[-1].name!="galaxy_runtime_continuation":
                                raise AssertionError("provider received unsupported assistant-prefill continuation")
                        return ModelResponse(role="assistant",tool_calls=[{"id":"read-"+str(self.calls),"type":"function","function":{"name":"read_current","arguments":"{}"}}])
                    state[ASSESSMENT]={"activity":state[ACTIVITY],"disposition":"continue" if self.calls==2 else "completed","remaining":["第二项"] if self.calls==2 else [],"reason":"继续" if self.calls==2 else "完成"}
                    return ModelResponse(role="assistant",content="第一项已完成，接着处理。" if self.calls==2 else "两项已完成。")
                async def ainvoke(self,messages,**kwargs):return self.invoke(messages,**kwargs)
                def invoke_stream(self,messages,**kwargs):yield self.invoke(messages,**kwargs)
                async def ainvoke_stream(self,messages,**kwargs):yield self.invoke(messages,**kwargs)
                def _parse_provider_response(self,response,**kwargs):return response
                def _parse_provider_response_delta(self,response):return response
            reads=[]
            def read_current(run_context: RunContext):
                reads.append(len(reads)+1);state=turn_state(run_context);state[ACTIVITY]=len(reads)
                return json.dumps({"value":len(reads)})
            with tempfile.TemporaryDirectory() as directory:
                db=SqliteDb(db_file=str(Path(directory)/"native.sqlite"))
                provider=StrictProvider();install_usage_scope(provider);with_conversation_completion(provider)
                agent=Agent(model=provider,db=db,tools=[read_current],store_tool_messages=False,telemetry=False)
                try:
                    if asynchronous:
                        async def run():
                            if streaming:return [item async for item in agent.arun("完成两项",session_id="s",user_id="u",stream=True)]
                            return await agent.arun("完成两项",session_id="s",user_id="u")
                        asyncio.run(run())
                    elif streaming:list(agent.run("完成两项",session_id="s",user_id="u",stream=True))
                    else:agent.run("完成两项",session_id="s",user_id="u")
                    self.assertEqual(reads,[1,2]);self.assertEqual(provider.calls,4)
                    signals=[m for m in provider.snapshots[2] if m.name=="galaxy_runtime_continuation"]
                    self.assertEqual(len(signals),1)
                    self.assertEqual([m.id for m in provider.snapshots[3] if m.name=="galaxy_runtime_continuation"],[signals[0].id])
                    stored=db.get_runs(session_id="s",user_id="u")[0]
                    self.assertEqual(stored.input.input_content,"完成两项")
                    self.assertFalse(any(m.name=="galaxy_runtime_continuation" for m in stored.messages))
                    self.assertEqual([m.content for m in stored.messages if m.role=="user"],["完成两项"])
                    self.assertIn("两项已完成。", stored.content)
                finally:db.db_engine.dispose()

    def test_native_stream_delivers_first_delta_before_provider_finishes(self):
        from dataclasses import dataclass
        from agno.agent import Agent
        from agno.models.base import Model as NativeModel
        from galaxy_agentos.model_usage import install_usage_scope

        @dataclass
        class Streaming(NativeModel):
            id: str = "local-stream"
            finished: bool = False
            def invoke(self, *args, **kwargs): return ModelResponse(role="assistant", content="第一段第二段")
            async def ainvoke(self, *args, **kwargs): return self.invoke(*args, **kwargs)
            def invoke_stream(self, *args, **kwargs):
                yield ModelResponse(role="assistant", content="第一段")
                self.finished = True
                yield ModelResponse(role="assistant", content="第二段")
            async def ainvoke_stream(self, *args, **kwargs):
                yield ModelResponse(role="assistant", content="第一段")
                self.finished = True
                yield ModelResponse(role="assistant", content="第二段")
            def _parse_provider_response(self, value, **kwargs): return value
            def _parse_provider_response_delta(self, value): return value

        for asynchronous in (False, True):
            provider = Streaming()
            install_usage_scope(provider)
            with_conversation_completion(provider)
            agent = Agent(model=provider, telemetry=False)
            if asynchronous:
                async def check():
                    async for event in agent.arun("任务", stream=True):
                        if event.content == "第一段":
                            self.assertFalse(provider.finished)
                            return
                    self.fail("missing first delta")
                asyncio.run(check())
            else:
                for event in agent.run("任务", stream=True):
                    if event.content == "第一段":
                        self.assertFalse(provider.finished)
                        break
                else:
                    self.fail("missing first delta")

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

if __name__ == "__main__": unittest.main()
