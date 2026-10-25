import asyncio
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

from fastapi.testclient import TestClient
from galaxy_model_gateway.policy import Settings, load_models, native_config
from galaxy_model_gateway.surface import PrivateSurface

KEY = "synthetic-only-new-service-key-000000000000"
BASE = Path(__file__).resolve().parents[1]


async def exchange(app, path, *, method="GET", headers=None, payload=None, query=b"", unreadable=False):
    read = 0
    output = []
    async def receive():
        nonlocal read
        read += 1
        if unreadable: raise AssertionError("Rejected request body must not be read")
        return {"type": "http.request", "body": json.dumps(payload).encode() if payload is not None else b"", "more_body": False}
    async def send(message): output.append(message)
    await app({"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "scheme": "http",
        "path": path, "raw_path": path.encode(), "method": method, "query_string": query,
        "headers": headers or [], "client": ("127.0.0.1", 1), "server": ("127.0.0.1", 3351)}, receive, send)
    return output[0]["status"], b"".join(message.get("body", b"") for message in output[1:]), read


class GatewayTest(unittest.TestCase):
    def test_01_native_empty_proxy_starts_without_enterprise_and_rejects_before_prompt(self):
        self.assertIsNone(importlib.util.find_spec("litellm_enterprise"))
        from importlib.metadata import version
        self.assertEqual(version("litellm"), "1.108.0")
        with self.assertRaisesRegex(ValueError, "auth_not_configured"):
            Settings(service_key="")
        settings = Settings(service_key=KEY, models_file=str(BASE / "config/models.empty.yaml"))
        from galaxy_model_gateway.app import create_app
        with tempfile.TemporaryDirectory() as directory:
            import yaml
            file = Path(directory) / "missing-key.yaml"
            file.write_text(yaml.safe_dump({"model_list": [{"model_name": "galaxy-missing", "litellm_params": {
                "model": "openai/synthetic-not-run", "api_base": "http://127.0.0.1:9/v1",
                "api_key": "os.environ/GALAXY_MODEL_PROVIDER_UNSET_KEY"}}]}))
            with self.assertRaisesRegex(ValueError, "provider_credentials_not_configured"):
                create_app(Settings(service_key=KEY, models_file=str(file)), quiet=False)
        app = create_app(settings, quiet=False)
        self.assertEqual(os.environ["LITELLM_TELEMETRY_DISABLED"], "true")
        self.assertNotIn("DATABASE_URL", os.environ)
        with TestClient(app, raise_server_exceptions=False) as client:
            self.assertEqual(client.get("/v1/models").status_code, 401)
            auth = {"Authorization": "Bearer " + KEY}
            status = client.get("/galaxy/status", headers=auth)
            self.assertEqual(status.status_code, 200, status.text)
            self.assertEqual(status.json()["modelState"], "not-configured")
            self.assertEqual(status.json()["modelCount"], 0)
            self.assertNotIn(KEY, status.text)
            models = client.get("/v1/models", headers=auth)
            self.assertEqual(models.status_code, 200, models.text)
            self.assertEqual(models.json()["data"], [])
            self.assertEqual(models.headers["x-galaxy-model-config-version"], "unconfigured-v1")
            result = client.post("/v1/chat/completions", headers=auth, json={"model": "openai/gpt-anything", "messages": []})
            self.assertEqual(result.status_code, 503, result.text)
            self.assertEqual(result.json()["error"]["code"], "model_gateway_model_not_configured")
            self.assertEqual(client.get("/v1/models?anything=1", headers=auth).status_code, 400)
        async def impossible(scope, receive, send): raise AssertionError("Denied route entered native Proxy")
        guarded = PrivateSurface(impossible, settings, [])
        for path in ["/config/update", "/model/new", "/key/generate", "/v1/responses/foreign"]:
            code, _, read = asyncio.run(exchange(guarded, path, method="POST", headers=[(b"authorization", ("Bearer " + KEY).encode())], unreadable=True))
            self.assertEqual((code, read), (403, 0))
        code, _, read = asyncio.run(exchange(guarded, "/v1/chat/completions", method="POST",
            headers=[(b"authorization", ("Bearer " + KEY).encode())], unreadable=True))
        self.assertEqual((code, read), (503, 0))

    def test_02_configured_admission_uses_native_protocol_and_metadata_only_without_model_call(self):
        # Explicit transport double: no provider is contacted or completion run.
        settings = Settings(service_key=KEY, config_version="test-v2")
        rows = [{"model_name": "galaxy-local-test", "litellm_params": {"model": "openai/synthetic-not-run",
            "api_base": "http://127.0.0.1:9/v1", "api_key": "os.environ/GALAXY_MODEL_PROVIDER_TEST_KEY"}}]
        seen = []
        async def native_protocol_double(scope, receive, send):
            seen.append(json.loads((await receive())["body"]))
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": b'{"choices":[{"finish_reason":"stop","message":{"content":"SYNTHETIC_RESULT"}}]}'})
        guarded = PrivateSurface(native_protocol_double, settings, rows)
        headers = [(b"authorization", ("Bearer " + KEY).encode()), (b"x-galaxy-model-scenario", b"governance"),
            (b"x-galaxy-model-config-version", b"test-v2")]
        payload = {"model": "galaxy-local-test", "messages": [{"role": "user", "content": "SYNTHETIC_PROMPT_CANARY"}], "store": False}
        self.assertEqual(asyncio.run(exchange(guarded, "/v1/chat/completions", method="POST", headers=headers, payload=payload))[0], 200)
        self.assertEqual(seen[0]["model"], "galaxy-local-test")
        self.assertEqual(seen[0]["metadata"]["galaxy_scenario"], "governance")
        for changed in [dict(payload, model="openai/implicit-model"), dict(payload, api_key="SYNTHETIC_SECRET_CANARY"),
                dict(payload, metadata={"prompt": "CANARY"}), dict(payload, fallbacks=["other"])]:
            self.assertEqual(asyncio.run(exchange(guarded, "/v1/chat/completions", method="POST", headers=headers, payload=changed))[0], 400)
        self.assertEqual(len(seen), 1)
        self.assertEqual(asyncio.run(exchange(guarded, "/v1/chat/completions", method="POST", headers=headers[:-1], unreadable=True))[0], 409)
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "models.yaml"
            import yaml
            file.write_text(yaml.safe_dump({"model_list": rows}))
            self.assertEqual(load_models(file), rows)
            file.write_text(yaml.safe_dump({"model_list": [dict(rows[0], litellm_params=dict(rows[0]["litellm_params"], api_key="SYNTHETIC_RAW_KEY"))]}))
            with self.assertRaisesRegex(ValueError, "configuration_invalid"): load_models(file)
        from galaxy_model_gateway.metadata import safe_record
        now = datetime.now(timezone.utc)
        record = safe_record({"litellm_params": {"metadata": seen[0]["metadata"]}, "messages": payload["messages"], "api_key": "SECRET_CANARY"},
            {"choices": [{"message": {"content": "OUTPUT_CANARY"}}], "usage": {"prompt_tokens": 7, "completion_tokens": 2, "total_tokens": 9}}, now, now + timedelta(milliseconds=12))
        self.assertEqual((record["inputTokens"], record["outputTokens"], record["totalTokens"], record["durationMs"]), (7, 2, 9, 12))
        self.assertNotIn("CANARY", json.dumps(record))
        unknown = safe_record({"litellm_params": {"metadata": seen[0]["metadata"]}}, None, None, None, failed=True)
        self.assertIsNone(unknown["totalTokens"])
        self.assertEqual(unknown["code"], "model_gateway_request_failed")
        config = native_config(rows)
        self.assertEqual(config["router_settings"]["fallbacks"], [])
        self.assertEqual(config["router_settings"]["num_retries"], 0)
        self.assertTrue(config["litellm_settings"]["turn_off_message_logging"])


if __name__ == "__main__": unittest.main()
