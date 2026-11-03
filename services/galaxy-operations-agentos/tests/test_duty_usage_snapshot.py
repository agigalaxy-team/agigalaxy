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


class DutyFailureProjectionTests(unittest.TestCase):
    def test_original_failure_keeps_category_and_http_without_provider_body(self):
        from galaxy_agentos.duty_storage import duty_storage_fields
        fields = {"status": "ERROR", "content": "PRIVATE_PROVIDER_BODY", "metadata": {
            "runtimeFailure": {"stage": "model-request", "category": "service-unavailable", "reportedStatus": 502}}}
        projected = duty_storage_fields(fields)
        self.assertIsNone(projected["content"])
        report = duty_report_fields(projected)
        self.assertEqual(report["failure"], fields["metadata"]["runtimeFailure"])
        self.assertEqual(report["code"], "operations_autonomy_model_service_unavailable")
        self.assertNotIn("PRIVATE_PROVIDER_BODY", str(report))

    def test_unknown_origin_does_not_claim_model_failure(self):
        report = duty_report_fields({"status": "ERROR", "metadata": {}})
        self.assertEqual(report["failure"]["stage"], "execution")
        self.assertEqual(report["failure"]["category"], "unknown")
        self.assertEqual(report["code"], "operations_autonomy_run_failed")


    def test_status_only_timeout_keeps_original_binding_metadata(self):
        from galaxy_agentos.duty_storage import duty_database
        from agno.run.status_persist import RunPersistOutcome
        class Db:
            id = "closed-error-patch"
            patch = None
            def update_run_in_session(self, *args, fields, **kwargs):
                self.patch = (fields, kwargs)
                return RunPersistOutcome.STALE_ATTEMPT
        db = Db()
        bound = duty_database(db, object())
        bound.update_run_in_session('session', 'run', fields={"status":"ERROR"},
            content_if_absent="agentos_autonomy_round_timeout")
        fields, kwargs = db.patch
        self.assertNotIn("metadata", fields)
        self.assertEqual(kwargs["content_if_absent"], "agentos_autonomy_round_timeout")
