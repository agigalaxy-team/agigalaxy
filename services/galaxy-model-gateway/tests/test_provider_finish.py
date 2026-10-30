import sys
import asyncio
import json
import types
import unittest
from unittest.mock import patch

from galaxy_model_gateway import provider_finish


class ProviderFinishTest(unittest.TestCase):
    def test_parsed_candidates_emit_only_validated_closed_metadata(self):
        # Minimal CustomLogger substitute only when the LiteLLM SDK is absent;
        # metadata.safe_record itself remains the gateway's actual validator.
        custom = types.ModuleType("litellm.integrations.custom_logger")
        custom.CustomLogger = type("CustomLogger", (), {})
        modules = {"litellm":types.ModuleType("litellm"), "litellm.integrations":types.ModuleType("litellm.integrations"),
            "litellm.integrations.custom_logger":custom}
        result = object()
        class Iterator:
            def __init__(self, details): self.logging_obj = types.SimpleNamespace(model_call_details=details)
            def chunk_parser(self, chunk):
                self.received = chunk
                return result
        metadata = {"galaxy_model_alias":"galaxy-overview", "galaxy_scenario":"overview",
            "galaxy_config_version":"v1", "galaxy_call_id":"11111111-1111-1111-1111-111111111111"}
        chunk = {"candidates":[{"finishReason":"MALFORMED_FUNCTION_CALL", "content":"synthetic-secret"},
            {"finishReason":"synthetic-secret"}, {"content":"synthetic-secret"}]}
        with patch.dict(sys.modules, modules), patch.object(provider_finish, "emit") as emit:
            provider_finish.install(Iterator)
            provider_finish.install(Iterator)
            iterator = Iterator({"litellm_params":{"metadata":metadata}})
            self.assertIs(iterator.chunk_parser(chunk), result)
            self.assertIs(iterator.received, chunk)
            rows = [call.args[0] for call in emit.call_args_list]
            self.assertEqual(rows, [{"event":"provider-native-finish", "callId":metadata["galaxy_call_id"], "finishReason":"MALFORMED_FUNCTION_CALL"},
                {"event":"provider-native-finish", "callId":metadata["galaxy_call_id"], "finishReason":"unknown"}])
            self.assertNotIn("synthetic-secret", repr(rows))
            emit.reset_mock()
            Iterator({"litellm_params":{"metadata":{**metadata, "galaxy_call_id":"invalid"}}}).chunk_parser(chunk)
            emit.assert_not_called()

    def test_parser_evidence_is_scoped_to_guard_call_and_never_overrides_partial_output(self):
        from galaxy_model_gateway.response_guard import ResponseGuard
        custom = types.ModuleType("litellm.integrations.custom_logger")
        custom.CustomLogger = type("CustomLogger", (), {})
        modules = {"litellm":types.ModuleType("litellm"), "litellm.integrations":types.ModuleType("litellm.integrations"),
            "litellm.integrations.custom_logger":custom}
        class Iterator:
            def __init__(self, details): self.logging_obj = types.SimpleNamespace(model_call_details=details)
            def chunk_parser(self, chunk): return chunk
        ident = "22222222-2222-2222-2222-222222222222"
        metadata = {"galaxy_model_alias":"galaxy-overview", "galaxy_scenario":"overview", "galaxy_config_version":"v1", "galaxy_call_id":ident}
        async def check(call_id, partial=False):
            sent = []
            async def send(value): sent.append(value)
            async def rejected(): pass
            guard = ResponseGuard(send, stream=True, responses=False, version='v1', rejected=rejected, call_id=call_id)
            await guard.send({'type':'http.response.start', 'status':200, 'headers':[(b'content-type',b'text/event-stream')]})
            if partial:
                frame = {'choices':[{'delta':{'content':'partial'}, 'finish_reason':None}]}
                await guard.send({'type':'http.response.body','body':b'data: '+json.dumps(frame).encode()+b'\n\n','more_body':True})
            frame = {'choices':[{'delta':{}, 'finish_reason':'stop'}]}
            await guard.send({'type':'http.response.body','body':b'data: '+json.dumps(frame).encode()+b'\n\ndata: [DONE]\n\n','more_body':False})
            await guard.complete()
            return sent
        with patch.dict(sys.modules, modules), patch.object(provider_finish, 'emit'), patch('galaxy_model_gateway.output.emit'):
            provider_finish.install(Iterator)
            Iterator({'litellm_params':{'metadata':metadata}}).chunk_parser({'candidates':[{'finishReason':'MALFORMED_FUNCTION_CALL'}]})
            response_id = '55555555-5555-5555-5555-555555555555'
            safety_id = '66666666-6666-6666-6666-666666666666'
            for call_id, reason in [(response_id,'MALFORMED_RESPONSE'), (safety_id,'SAFETY')]:
                Iterator({'litellm_params':{'metadata':{**metadata, 'galaxy_call_id':call_id}}}).chunk_parser({'candidates':[{'finishReason':reason}]})
            proven = asyncio.run(check(ident))
            response = asyncio.run(check(response_id))
            safety = asyncio.run(check(safety_id))
            other = asyncio.run(check('33333333-3333-3333-3333-333333333333'))
            partial = asyncio.run(check(ident, True))
        self.assertEqual(json.loads(proven[-1]['body'])['error'], {'code':'model_gateway_malformed_tool_call', 'source':'model-gateway',
            'status':502, 'category':'malformed-tool-call', 'outputStarted':False})
        self.assertEqual(json.loads(other[-1]['body'])['error']['code'], 'model_gateway_empty_completion')
        self.assertEqual(json.loads(response[-1]['body'])['error'], {'code':'model_gateway_malformed_response', 'source':'model-gateway',
            'status':502, 'category':'malformed-response', 'outputStarted':False})
        self.assertEqual(json.loads(safety[-1]['body'])['error']['code'], 'model_gateway_empty_completion')
        self.assertEqual(partial[0]['status'], 200)
        self.assertNotIn(b'model_gateway_malformed_tool_call', b''.join(v.get('body',b'') for v in partial))


if __name__ == "__main__": unittest.main()
