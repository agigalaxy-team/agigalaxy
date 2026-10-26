import asyncio
import unittest
import httpx
from types import SimpleNamespace
from agno.exceptions import ModelProviderError
from galaxy_agentos.model_failover import with_model_failover,provider_failure
from galaxy_agentos.gateway import AuthorityDenied


def rejected(status,source='provider'):
    cause=RuntimeError('NEVER_LOG_PROVIDER_BODY')
    cause.body={'error':{'code':'model_gateway_request_failed','source':source}}
    error=ModelProviderError('closed',status_code=status,model_name='test',model_id='test')
    error.__cause__=cause
    return error


class Candidate:
    def __init__(self,name,error=None,partial=False):self.id=name;self.error=error;self.calls=0;self.partial=partial
    def invoke(self,*args,**kwargs):
        self.calls+=1
        if self.error:raise self.error
        return 'complete'
    async def ainvoke(self,*args,**kwargs):return self.invoke(*args,**kwargs)
    def invoke_stream(self,*args,**kwargs):
        self.calls+=1
        if self.partial:yield 'DISCARD_PARTIAL'
        if self.error:raise self.error
        yield 'complete'
    async def ainvoke_stream(self,*args,**kwargs):
        for chunk in self.invoke_stream(*args,**kwargs):yield chunk


class ModelFailover(unittest.TestCase):
    def test_actual_native_openai_adapter_preserves_the_gateway_origin_in_its_exception_chain(self):
        from galaxy_agentos.model_profiles import native_model,load_runtime_profile
        from agno.models.message import Message
        captured=[]
        def transport(request):
            captured.append(__import__('json').loads(request.content))
            return httpx.Response(403,json={'error':{'code':'model_gateway_request_failed','source':'provider'}})
        profile=load_runtime_profile({'apiFormat':'openai-chat','contextWindow':8192,'maxOutputTokens':512,'reasoningEffort':None,'timeoutSeconds':30,'toolCalling':True,'structuredOutput':True,'imageUnderstanding':True,'parallelToolCalls':False,'verbosity':'low'})
        model=native_model(profile,alias='galaxy-test',base_url='http://127.0.0.1:1/v1',api_key='explicit-local-test-only',headers={})
        model.http_client=httpx.Client(transport=httpx.MockTransport(transport));self.addCleanup(model.http_client.close)
        with self.assertRaises(ModelProviderError) as caught:model.invoke([Message(role='user',content='only a local adapter check')],assistant_message=Message(role='assistant'))
        self.assertEqual(provider_failure(caught.exception),{'status':403,'source':'provider'})
        self.assertFalse(captured[0]['parallel_tool_calls']);self.assertEqual(captured[0]['verbosity'],'low')

    def test_only_attested_provider_codes_can_select_a_backup(self):
        for status in [401,402,403,408,429,500,502,503,504,507,529,599]:
            self.assertEqual(provider_failure(rejected(status))['status'],status)
        for error in [rejected(503,'model-gateway'),rejected(400),rejected(404),rejected(422),AuthorityDenied('closed'),ModelProviderError('closed',status_code=503)]:self.assertIsNone(provider_failure(error))

    def test_bounded_order_keeps_original_model_and_does_not_retry_a_candidate(self):
        primary=Candidate('primary',rejected(502));one=Candidate('one',rejected(403));two=Candidate('two')
        model=with_model_failover(primary,[one,two]);self.assertEqual(model.invoke(messages=[]),'complete')
        self.assertEqual([item.calls for item in [primary,one,two]],[1,1,1]);self.assertEqual(model.id,'primary')

    def test_galaxy_denial_and_bad_arguments_do_not_fall_back(self):
        for error in [AuthorityDenied('closed'),rejected(401,'model-gateway'),rejected(400),TypeError('closed')]:
            primary=Candidate('primary',error);backup=Candidate('backup')
            with self.assertRaises(type(error)):with_model_failover(primary,[backup]).invoke(messages=[])
            self.assertEqual(backup.calls,0)

    def test_stream_discards_half_calls_and_async_paths_use_the_same_rules(self):
        primary=Candidate('primary',rejected(503),partial=True);backup=Candidate('backup')
        self.assertEqual(list(with_model_failover(primary,[backup]).invoke_stream(messages=[])),['complete'])
        async def check():
            primary=Candidate('primary',rejected(401));backup=Candidate('backup');model=with_model_failover(primary,[backup])
            self.assertEqual(await model.ainvoke(messages=[]),'complete')
            self.assertEqual([chunk async for chunk in model.ainvoke_stream(messages=[])],['complete'])
        asyncio.run(check())

    def test_exhaustion_preserves_original_failure(self):
        original=rejected(502);primary=Candidate('primary',original);backup=Candidate('backup',rejected(503))
        with self.assertRaises(ModelProviderError) as caught:with_model_failover(primary,[backup]).invoke(messages=[])
        self.assertIs(caught.exception,original)

    def test_successful_fallback_stays_with_the_current_run_and_preserves_the_input_snapshot(self):
        original=[{'role':'tool','content':'original receipt'}]
        class Mutating(Candidate):
            def invoke(self,*args,**kwargs):
                self.calls+=1;kwargs['messages'].append({'role':'assistant','content':'failed partial'})
                raise rejected(503)
        class Checked(Candidate):
            def invoke(self,*args,**kwargs):
                self.calls+=1;self.observed=kwargs['messages'];return 'complete'
        primary=Mutating('primary');backup=Checked('backup');run=SimpleNamespace(metadata={})
        model=with_model_failover(primary,[backup]);model.invoke(messages=original,run_response=run)
        self.assertEqual(backup.observed,[{'role':'tool','content':'original receipt'}])
        self.assertEqual(run.metadata['activeModelFallbackAlias'],'backup')
        model.invoke(messages=[],run_response=run)
        self.assertEqual(primary.calls,1);self.assertEqual(backup.calls,2)


if __name__=='__main__':unittest.main()
