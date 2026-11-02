import json
import unittest

from pydantic import ValidationError
from galaxy_agentos.duties import TaskAssessment, duty_tools


class ReadResolutionContract(unittest.TestCase):
    def test_actual_sdk_exposes_closed_original_call_coordinates(self):
        native = duty_tools(object(), {"assess-task"})[0]
        native.process_entrypoint()
        schema = json.dumps(native.parameters, ensure_ascii=False)
        for value in ("readResolutions", "failedCallId", "evidenceCallIds", "not-applicable", "superseded"):
            self.assertIn(value, schema)
        call = "11111111-1111-4111-8111-111111111111"
        evidence = "22222222-2222-4222-8222-222222222222"
        item = TaskAssessment.model_validate({"goalSatisfied": True, "remainingWork": [], "summary": "checked",
            "readResolutions": [{"failedCallId": call, "resolution": "not-applicable", "evidenceCallIds": [evidence]}]})
        self.assertEqual(item.model_dump(mode="json")["readResolutions"][0]["failedCallId"], call)
        with self.assertRaises(ValidationError):
            TaskAssessment.model_validate({"goalSatisfied": True, "remainingWork": [], "summary": "checked",
                "readResolutions": [{"failedCallId": call, "resolution": "not-applicable", "evidenceCallIds": [evidence], "extra": "x"}]})

