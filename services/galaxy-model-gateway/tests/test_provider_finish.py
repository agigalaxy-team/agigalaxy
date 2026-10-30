import sys
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


if __name__ == "__main__": unittest.main()
