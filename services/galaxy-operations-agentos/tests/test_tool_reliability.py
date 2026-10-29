import json
import unittest
from contextlib import redirect_stdout
from io import StringIO
from types import SimpleNamespace
from uuid import uuid4
import httpx
from agno.run.base import RunContext
from agno.tools.function import FunctionCall
from pydantic import BaseModel, ConfigDict, Field
from galaxy_agentos.tool_reliability import reliable_function, repair, tool_call_key
from galaxy_agentos.conversation_tools import conversation_tools
from galaxy_agentos.gateway import AuthorityDenied, AuthorityUnavailable, GalaxyGateway


class ToolReliability(unittest.TestCase):
    def context(self):
        return RunContext(run_id=str(uuid4()), user_id='conversation:'+str(uuid4()), session_id=str(uuid4()), metadata={'operationId':str(uuid4())})

    def test_signature_id_is_bounded_stable_without_changing_provider_id(self):
        provider='call_test__thought__'+'aB1+/_='*100
        key=tool_call_key(provider)
        self.assertLess(len(key),128);self.assertEqual(key,tool_call_key(provider));self.assertNotIn('thought',key)
        self.assertEqual(tool_call_key('call_ordinary'),'call_ordinary')
        self.assertNotEqual(key,tool_call_key(provider+'A'))
        for bad in ['',None,'../path','x'*129,'call_test__thought__illegal!']:
            with self.assertRaises(AuthorityDenied):tool_call_key(bad)

    def test_repairs_only_schema_supported_representations(self):
        schema={'type':'object','properties':{'count':{'type':'integer'},'active':{'type':'boolean'},'items':{'type':'array','items':{'type':'integer'}}},'additionalProperties':False}
        self.assertEqual(repair({'count':'20','active':'false','items':'[1,2]','unknown':'keep-for-validation'},schema),{'count':20,'active':False,'items':[1,2],'unknown':'keep-for-validation'})
        self.assertEqual(repair('yes',{'type':'boolean'}),'yes')
        self.assertEqual(repair('30',{'anyOf':[{'type':'integer'},{'type':'string','const':'all'}]}),30)
        self.assertEqual(repair('all',{'anyOf':[{'type':'integer'},{'type':'string','const':'all'}]}),'all')

    def test_read_failure_retries_once_and_permission_denial_never_retries(self):
        calls=[]
        def current_summary(run_context: RunContext, fc: FunctionCall):
            calls.append(fc.call_id)
            if len(calls)==1:raise AuthorityUnavailable('closed')
            return json.dumps({'availability':'available'})
        fn=reliable_function(current_summary);fn._run_context=self.context()
        original='call_summary__thought__'+'aB1+/_='*100
        call=FunctionCall(function=fn,call_id=original,arguments={});call.execute()
        self.assertEqual(json.loads(call.result)['availability'],'available');self.assertEqual(calls,[original,original])
        calls.clear()
        def denied(run_context: RunContext, fc: FunctionCall):
            calls.append(fc.call_id);raise AuthorityDenied('closed')
        fn=reliable_function(denied);fn._run_context=self.context()
        call=FunctionCall(function=fn,call_id='call_denied',arguments={});call.execute()
        self.assertFalse(json.loads(call.result)['retryable']);self.assertEqual(len(calls),1)

    def test_execution_unknown_is_not_automatically_retried(self):
        calls=[]
        def run_authorized_work(run_context: RunContext, fc: FunctionCall):
            calls.append(fc.call_id);raise AuthorityUnavailable('closed')
        fn=reliable_function(run_authorized_work);fn._run_context=self.context()
        call=FunctionCall(function=fn,call_id='call_unknown',arguments={});call.execute();result=json.loads(call.result)
        self.assertEqual(len(calls),1);self.assertIsNone(result['effectExecuted'])
        self.assertEqual(result['nextStep'],'read-original-operation');self.assertFalse(result['cardPrepared'])

    def test_actual_gateway_failures_keep_categories_and_codes_only_in_diagnostics(self):
        for status, code, state, expected_calls in [
                (503, 'operations_agentos_conversation_not_ready', 'unavailable', 2),
                (403, 'business_admin_denied', 'denied', 1),
                (400, 'invalid_operations_agentos_request', 'invalid-request', 1),
                (404, 'operations_agentos_operation_not_found', 'unavailable', 1),
                (410, 'operations_agentos_source_changed', 'unavailable', 1),
                (409, 'operations_agentos_source_changed', 'changed', 1)]:
            with self.subTest(status=status):
                requests = []
                def rejected(request):
                    requests.append(request)
                    return httpx.Response(status, json={'error': code, 'private': 'UPSTREAM_PRIVATE_PROSE'})
                gateway = GalaxyGateway(SimpleNamespace(service_key='explicit-synthetic-key',
                    authority_url='http://127.0.0.1:1/v1/internal/agentos/'),
                    transport=httpx.MockTransport(rejected))
                self.addCleanup(gateway.close)
                def current_summary(run_context: RunContext, fc: FunctionCall):
                    return json.dumps(gateway.conversation_summary(run_context.user_id,
                        run_id=run_context.run_id, call_id=fc.call_id,
                        session_id=run_context.session_id, turn_id=run_context.metadata['operationId']))
                function = reliable_function(current_summary)
                function._run_context = self.context()
                output = StringIO()
                with redirect_stdout(output):
                    call = FunctionCall(function=function, call_id='closed-current-summary', arguments={})
                    call.execute()
                result = json.loads(call.result)
                self.assertEqual(result['state'], state)
                self.assertEqual(len(requests), expected_calls)
                self.assertIn('message', result)
                self.assertNotIn('agentos_', call.result)
                self.assertNotIn('business_admin_', call.result)
                self.assertNotIn('UPSTREAM_PRIVATE_PROSE', output.getvalue() + call.result)
                self.assertNotIn('授权', result['message'])
                self.assertNotEqual(result.get('nextStep'), 'read-original-operation')
                if status in {403, 503}:
                    self.assertIn(code, output.getvalue())

    def test_native_binding_shape_failure_is_not_reported_as_user_permission_loss(self):
        def query_operations(run_context: RunContext, fc: FunctionCall):
            raise AuthorityDenied('agentos_conversation_context_required')
        function = reliable_function(query_operations)
        function._run_context = self.context()
        call = FunctionCall(function=function, call_id='missing-trusted-context', arguments={})
        call.execute()
        result = json.loads(call.result)
        self.assertEqual(result['state'], 'invalid-request')
        self.assertEqual(result['message'], '工具调用参数不符。')
        self.assertNotIn('agentos_', call.result)

    def test_old_summary_failure_code_does_not_become_current_authority_feedback(self):
        def current_summary(run_context: RunContext, fc: FunctionCall):
            return json.dumps({'counts': {'feedback': 2}, 'priorReadReceipts': {'valuesCurrent': False,
                'items': [{'tool': 'workbench-summary', 'state': 'unavailable',
                    'code': 'operations_agentos_conversation_not_ready'}]}})
        function = reliable_function(current_summary)
        function._run_context = self.context()
        output = StringIO()
        with redirect_stdout(output):
            call = FunctionCall(function=function, call_id='past-read-receipt', arguments={})
            call.execute()
        result = json.loads(call.result)
        self.assertEqual(result['counts'], {'feedback': 2})
        self.assertEqual(result['priorReadReceipts']['items'][0]['state'], 'unavailable')
        self.assertNotIn('operations_agentos_', call.result)
        self.assertIn('operations_agentos_conversation_not_ready', output.getvalue())

    def test_actual_agno_tools_normalize_filters_and_preserve_scope(self):
        calls=[]
        class Gateway:
            def conversation_tool(self,user,tool,arguments,**binding):
                calls.append((tool,arguments,binding));return {'availability':'available'}
        fn=reliable_function(conversation_tools(Gateway(),domain='overview')[0])
        fn._run_context=self.context()
        call=FunctionCall(function=fn,call_id='call_query',arguments={'module':'recommendations','view':'overview','days':'30'})
        call.execute()
        self.assertEqual(json.loads(call.result)['availability'],'available')
        self.assertEqual(calls[0][1],{'module':'recommendations','view':'overview','filters':{'days':30}})
        self.assertEqual(calls[0][2]['turn_id'],fn._run_context.metadata['operationId'])

    def test_native_validation_returns_closed_feedback_without_execution(self):
        calls=[]
        class Gateway:
            def conversation_tool(self,*args,**kwargs):calls.append(args);return {}
        fn=reliable_function(conversation_tools(Gateway(),domain='overview')[0]);fn._run_context=self.context()
        for attempt in range(3):
            call=FunctionCall(function=fn,call_id='call_bad'+str(attempt),arguments={'module':'CANARY_PRIVATE','view':'overview'})
            call.execute();result=json.loads(call.result)
            self.assertFalse(result['effectExecuted']);self.assertFalse(result['cardPrepared']);self.assertNotIn('CANARY_PRIVATE',call.result)
        self.assertFalse(result['retryable']);self.assertEqual(result['nextStep'],'report-blocked');self.assertEqual(calls,[])

    def test_conflicting_filter_is_not_silently_overridden(self):
        class Gateway:
            def conversation_tool(self,*args,**kwargs):raise AssertionError('must not execute')
        fn=reliable_function(conversation_tools(Gateway(),domain='overview')[0]);fn._run_context=self.context()
        call=FunctionCall(function=fn,call_id='call_conflict',arguments={'module':'search','view':'overview','days':7,'filters':{'days':30}})
        call.execute();self.assertEqual(json.loads(call.result)['state'],'invalid-request')

    def test_unknown_field_names_cannot_leak_input_into_failure_metadata(self):
        class Gateway:
            def conversation_tool(self,*args,**kwargs):raise AssertionError('must not execute')
        fn=reliable_function(conversation_tools(Gateway(),domain='overview')[0]);fn._run_context=self.context()
        call=FunctionCall(function=fn,call_id='call_unknown_field',arguments={'module':'search','view':'overview','PRIVATE_CANARY_UNKNOWN_KEY':'ignored'})
        call.execute();result=json.loads(call.result)
        self.assertEqual(result['state'],'invalid-request');self.assertNotIn('PRIVATE_CANARY_UNKNOWN_KEY',call.result)

    def test_injected_context_cannot_be_supplied_by_model(self):
        calls=[]
        class Gateway:
            def conversation_tool(self,user,tool,arguments,**binding):
                calls.append((user,binding));return {'availability':'available'}
        fn=reliable_function(conversation_tools(Gateway(),domain='overview')[0]);fn._run_context=self.context()
        call=FunctionCall(function=fn,call_id='call_spoof',arguments={'run_context':{},'module':'search','view':'overview','filters':{'days':30}})
        # Agno itself strips model-provided injected keys before our wrapper.
        # Verify the call uses the server context, not an unrelated error.
        call.execute();self.assertFalse(call.error)
        self.assertEqual(calls[0][0],fn._run_context.user_id)
        self.assertEqual(calls[0][1]['turn_id'],fn._run_context.metadata['operationId'])


if __name__=='__main__':unittest.main()
