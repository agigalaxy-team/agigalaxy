import math
import unittest

from galaxy_agentos.duty_storage import duty_report_fields
from galaxy_agentos.duty_surface import duty_view


class DutyUsageSnapshotTest(unittest.TestCase):
    def test_report_and_view_share_original_native_metrics(self):
        raw = {"run_id":"native-original", "agent_id":"galaxy-duty", "user_id":"autonomy:00000000-0000-4000-8000-000000000001", "status":"ERROR",
            "metadata":{"modelCalls":29, "activeDurationBefore":2},
            "metrics":{"details":{"model":[{}]}, "input_tokens":1432518, "output_tokens":10852, "total_tokens":1443370, "duration":221.8314}}
        report = duty_report_fields(raw)
        view = duty_view("00000000-0000-4000-8000-000000000001", raw)
        self.assertEqual(report["modelUsage"], {"calls":29, "inputTokens":1432518, "outputTokens":10852, "totalTokens":1443370, "durationMs":223831.4})
        self.assertEqual(view["run"]["calls"], report["modelUsage"]["calls"])
        self.assertEqual(view["run"]["tokens"]["input"], report["modelUsage"]["inputTokens"])
        raw["metrics"]["input_tokens"] = math.inf
        self.assertIsNone(duty_report_fields(raw)["modelUsage"]["inputTokens"])
