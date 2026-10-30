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
from galaxy_agentos.tool_reliability import reliable_function, repair, tool_call_key, _model_feedback, _closed_failure
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
                if status == 400:
                    self.assertEqual(result, {'state': 'invalid-request', 'reason': code,
                        'httpStatus': 400, 'scope': 'backend-request-validation',
                        'retryable': True, 'action': 'correct-arguments'})
                    self.assertNotIn('UPSTREAM_PRIVATE_PROSE', output.getvalue() + call.result)
                    continue
                self.assertIn('message', result)
                self.assertNotIn('agentos_', call.result)
                self.assertNotIn('business_admin_', call.result)
                self.assertNotIn('UPSTREAM_PRIVATE_PROSE', output.getvalue() + call.result)
                if status == 403:
                    self.assertEqual(result['failureCategory'], 'authorization-check-rejected')
                    self.assertFalse(result['causeKnown'])
                if status == 503:
                    self.assertEqual(result['failureCategory'], 'source-unavailable')
                self.assertNotEqual(result.get('nextStep'), 'read-original-operation')
                self.assertFalse(result['dataRead'])
                self.assertFalse(result['valuesCurrent'])
                if status in {403, 503}:
                    self.assertIn('尚未查明', result['message'])
                if status in {403, 503}:
                    self.assertIn(code, output.getvalue())

    def test_current_failures_and_model_failure_are_distinct_closed_facts(self):
        value = {"priorReadReceipts":{"items":[{"state":"unavailable","code":"business_admin_denied"}]},
            "currentReadOutcomes":{"items":[{"state":"unavailable","code":"operations_agentos_tool_request_timeout"},
                {"state":"completed","resultState":"invalid-request","code":"invalid_operations_agentos_query"}]},
            "turnOutcomes":{"items":[{"nativeStatus":"ERROR","failure":{"stage":"model-request","category":"service-unavailable","reportedStatus":502}}]}}
        output, diagnostic = _model_feedback(value)
        self.assertNotIn("business_admin_denied", json.dumps(output))
        self.assertNotIn("invalid_operations_agentos_query", json.dumps(output))
        self.assertEqual(output["priorReadReceipts"]["items"][0]["outcome"]["failureCategory"], "authorization-check-rejected")
        self.assertFalse(output["priorReadReceipts"]["items"][0]["outcome"]["causeKnown"])
        self.assertEqual(output["currentReadOutcomes"]["items"][0]["outcome"]["failureCategory"], "timeout")
        self.assertEqual(output["currentReadOutcomes"]["items"][1]["outcome"]["failureCategory"], "invalid-request")
        self.assertEqual(output["turnOutcomes"]["items"][0]["failure"]["stage"], "model-request")
        self.assertIn("business_admin_denied", json.dumps(diagnostic))
        unavailable = AuthorityUnavailable("agentos_authority_unavailable"); unavailable.status_code = 502
        self.assertEqual(_closed_failure("current_summary", unavailable)["failureCategory"], "source-unavailable")
        self.assertNotEqual(_closed_failure("current_summary", unavailable)["state"], "denied")
        summary, _ = _model_feedback({"availability":"unavailable","reason":"summary-not-connected"})
        self.assertEqual(summary["failureCategory"], "source-unavailable")
        self.assertNotIn("summary-not-connected", json.dumps(summary))

    def test_closed_argument_feedback_and_unknown_errors(self):
        for status, code, expected in [
                (400, "invalid_p13_strategy_request", True),
                (422, "invalid_operations_agentos_request", True),
                (400, "unknown_SECRET_CANARY", False),
                (503, "invalid_p13_strategy_request", False)]:
            with self.subTest(status=status, code=code):
                def respond(request):
                    return httpx.Response(status, json={"error": code, "message": "SECRET_CANARY"})
                gateway = GalaxyGateway(SimpleNamespace(service_key="synthetic",
                    authority_url="http://127.0.0.1:1/v1/internal/agentos/"),
                    transport=httpx.MockTransport(respond))
                self.addCleanup(gateway.close)
                if expected:
                    feedback = gateway.request("tools/execute", {}, tool_feedback=True)
                    self.assertEqual(feedback, {"state": "invalid-request", "reason": code,
                        "httpStatus": status, "scope": "backend-request-validation", "retryable": True, "action": "correct-arguments"})
                    projected, _ = _model_feedback(feedback)
                    self.assertEqual(projected, feedback)
                    projected_query, _ = _model_feedback({**feedback, "analysisConstraints": {"ignored": "SECRET_CANARY"}})
                    self.assertEqual(projected_query, feedback)
                else:
                    with self.assertRaises(AuthorityUnavailable) as caught:
                        gateway.request("tools/execute", {}, tool_feedback=True)
                    feedback = _closed_failure("prepare_operation", caught.exception)
                    self.assertEqual(feedback["state"], "unavailable")
                    self.assertNotIn("SECRET_CANARY", json.dumps(feedback))
        forged = {"state":"invalid-request", "reason":"invalid_p13_strategy_request",
            "httpStatus":503, "scope":"backend-request-validation", "retryable":True, "action":"correct-arguments"}
        projected, _ = _model_feedback(forged)
        self.assertEqual(projected["state"], "unavailable")
        self.assertNotIn("action", projected)
        self.assertFalse(projected["retryable"])
        forged.update({"httpStatus": 400, "extra": "SECRET_CANARY"})
        projected, diagnostic = _model_feedback(forged)
        self.assertEqual(projected["state"], "unavailable")
        self.assertNotIn("SECRET_CANARY", json.dumps([projected, diagnostic]))

    def test_sdk_prepare_invalid_then_corrected_card(self):
        calls = []
        card_id = str(uuid4())
        def respond(request):
            calls.append(json.loads(request.content))
            if len(calls) == 1:
                return httpx.Response(400, json={"error": "invalid_p13_strategy_request", "message": "SECRET_CANARY"})
            return httpx.Response(200, json={"state": "prepared", "card": {"state": "prepared", "cardId": card_id}})
        gateway = GalaxyGateway(SimpleNamespace(service_key="synthetic", authority_url="http://127.0.0.1:1/v1/internal/agentos/"),
            transport=httpx.MockTransport(respond))
        self.addCleanup(gateway.close)
        function = reliable_function(conversation_tools(gateway)[-1])
        function._run_context = self.context()
        first = FunctionCall(function=function, call_id="first", arguments={"operation":{"kind":"rule-publish", "key":"business-controls", "reason":"first"}})
        with redirect_stdout(StringIO()):
            first.execute()
        feedback = json.loads(first.result)
        self.assertEqual(feedback["reason"], "invalid_p13_strategy_request")
        self.assertEqual(feedback["scope"], "backend-request-validation")
        self.assertEqual(feedback["action"], "correct-arguments")
        self.assertNotIn("SECRET_CANARY", first.result)
        second = FunctionCall(function=function, call_id="second", arguments={"operation":{"kind":"rule-publish", "key":"business-controls", "reason":"corrected"}})
        with redirect_stdout(StringIO()):
            second.execute()
        self.assertEqual(json.loads(second.result)["card"]["cardId"], card_id)
        self.assertEqual(function._run_context.metadata["_galaxyPreparedCardIds"], [card_id])
        self.assertEqual(len(calls), 2)

    def test_slow_read_timeouts_do_not_repeat_the_same_entire_call(self):
        for error_type in (httpx.ReadTimeout, httpx.PoolTimeout):
            with self.subTest(error=error_type.__name__):
                requests = []
                def timeout(request):
                    requests.append(request)
                    raise error_type('UPSTREAM_PRIVATE_PROSE', request=request)
                gateway = GalaxyGateway(SimpleNamespace(service_key='explicit-synthetic-key',
                    authority_url='http://127.0.0.1:1/v1/internal/agentos/'),
                    transport=httpx.MockTransport(timeout))
                self.addCleanup(gateway.close)
                def current_summary(run_context: RunContext, fc: FunctionCall):
                    return json.dumps(gateway.conversation_summary(run_context.user_id,
                        run_id=run_context.run_id, call_id=fc.call_id,
                        session_id=run_context.session_id, turn_id=run_context.metadata['operationId']))
                function = reliable_function(current_summary)
                function._run_context = self.context()
                output = StringIO()
                with redirect_stdout(output):
                    call = FunctionCall(function=function, call_id='one-timeout-read', arguments={})
                    call.execute()
                result = json.loads(call.result)
                self.assertEqual(len(requests), 1)
                self.assertEqual(result['state'], 'unavailable')
                self.assertIn('本次读取超时', result['message'])
                self.assertIn('尚未查明', result['message'])
                self.assertFalse(result['dataRead'])
                self.assertFalse(result['valuesCurrent'])
                self.assertNotIn('UPSTREAM_PRIVATE_PROSE', output.getvalue() + call.result)
                self.assertNotIn('agentos_', call.result)
                self.assertIn('agentos_authority_timeout', output.getvalue())

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
        self.assertTrue(result['retryable']);self.assertTrue(result['repeatedValidationFailure']);self.assertEqual(result['nextStep'],'correct-arguments');self.assertEqual(calls,[])

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
