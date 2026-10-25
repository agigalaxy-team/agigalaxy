"""P20 additions with a local HTTP provider double, never a real model API."""
import asyncio
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from uuid import uuid4

from fastapi.testclient import TestClient
import yaml

from galaxy_model_gateway.policy import Settings, load_models
from galaxy_model_gateway.profiles import load_profiles
from galaxy_model_gateway.surface import PrivateSurface
from galaxy_model_gateway.usage import UsageStore
from test_gateway import exchange

KEY = "synthetic-private-service-key-not-a-provider-00000"
VERSION = "fixture-p20-v1"


def row(alias, api_format, base):
    responses = api_format == "openai-responses"
    models = {"openai-chat": "custom_openai/synthetic-chat", "openai-responses": "custom_openai/synthetic-responses",
        "anthropic": "anthropic/claude-sonnet-4-6", "gemini": "gemini/gemini-2.5-flash"}
    return {"model_name": alias, "litellm_params": {"model": models[api_format], "api_base": base,
        "api_key": "os.environ/GALAXY_MODEL_PROVIDER_SYNTHETIC_ONLY_KEY"}, "model_info": {"mode": "responses" if responses else "chat",
        "max_input_tokens": 7680, "max_output_tokens": 512,
        "supported_endpoints": ["/v1/responses" if responses else "/v1/chat/completions"]}}


def profile(api_format, domain):
    return {"apiFormat": api_format, "contextWindow": 8192, "maxOutputTokens": 512, "reasoningEffort": "medium",
        "timeoutSeconds": 30, "toolCalling": True, "structuredOutput": True, "scenarios": [domain]}


class ProviderDouble(BaseHTTPRequestHandler):
    seen = []
    def log_message(self, *args): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.seen.append({"path": self.path, "body": body})
        if ":generateContent" in self.path:
            result = {"candidates": [{"content": {"role": "model", "parts": [{"text": "SYNTHETIC_RESULT"}]}, "finishReason": "STOP"}],
                "usageMetadata": {"promptTokenCount": 11, "candidatesTokenCount": 3, "totalTokenCount": 14}}
        elif self.path.endswith("/messages"):
            result = {"id": "msg_fixture", "type": "message", "role": "assistant", "model": body["model"],
                "content": [{"type": "text", "text": "SYNTHETIC_RESULT"}], "stop_reason": "end_turn", "stop_sequence": None,
                "usage": {"input_tokens": 11, "output_tokens": 3}}
        elif self.path.endswith("/responses"):
            result = {"id": "resp_fixture", "object": "response", "created_at": 1790000000, "status": "completed", "model": body["model"],
                "output": [{"id": "msg_fixture", "type": "message", "role": "assistant", "status": "completed",
                    "content": [{"type": "output_text", "text": "SYNTHETIC_RESULT", "annotations": []}]}],
                "usage": {"input_tokens": 11, "output_tokens": 3, "total_tokens": 14,
                    "input_tokens_details": {"cached_tokens": 2}, "output_tokens_details": {"reasoning_tokens": 1}}}
        else:
            result = {"id": "chatcmpl_fixture", "object": "chat.completion", "created": 1790000000, "model": body["model"],
                "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "SYNTHETIC_RESULT"}}],
                "usage": {"prompt_tokens": 11, "completion_tokens": 3, "total_tokens": 14}}
        data = json.dumps(result).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)


class ModelProfilesTest(unittest.TestCase):
    def test_01_native_proxy_four_protocols_and_durable_usage_with_local_provider_double(self):
        from galaxy_model_gateway.app import create_app
        ProviderDouble.seen = []
        server = ThreadingHTTPServer(("127.0.0.1", 0), ProviderDouble)
        thread = Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with TemporaryDirectory() as directory:
                root = Path(directory); model_rows = []; profiles = {}
                pairs = list(zip(("openai-chat", "openai-responses", "anthropic", "gemini"), ("overview", "governance", "messaging", "discovery")))
                for index, (api_format, domain) in enumerate(pairs):
                    alias = "galaxy-m" + str(index + 1).zfill(32)
                    base = "http://127.0.0.1:" + str(server.server_port) + "/"
                    model_rows.append(row(alias, api_format, base)); profiles[alias] = profile(api_format, domain)
                file = root / "models.yaml"; file.write_text(yaml.safe_dump({"model_list": model_rows, "galaxy_profiles": profiles}))
                os.environ["GALAXY_MODEL_PROVIDER_SYNTHETIC_ONLY_KEY"] = "SYNTHETIC_LOCAL_PROVIDER_DOUBLE_ONLY"
                settings = Settings(service_key=KEY, models_file=str(file), config_version=VERSION, usage_file=str(root / "usage.sqlite3"))
                self.assertEqual(load_profiles(file, load_models(file)), profiles)
                app = create_app(settings, quiet=False)
                with TestClient(app, raise_server_exceptions=False) as client:
                    for index, (api_format, domain) in enumerate(pairs):
                        alias = model_rows[index]["model_name"]
                        headers = {"Authorization": "Bearer " + KEY, "X-Galaxy-Model-Scenario": domain, "X-Galaxy-Model-Config-Version": VERSION}
                        payload = {"model": alias, "store": False}
                        if api_format == "openai-responses":
                            payload.update({"input": "SYNTHETIC_PROMPT", "max_output_tokens": 512, "reasoning": {"effort": "medium"}, "truncation": "disabled"})
                        else:
                            payload.update({"messages": [{"role": "user", "content": "SYNTHETIC_PROMPT"}], "max_tokens": 512, "reasoning_effort": "medium"})
                        result = client.post("/v1/responses" if api_format == "openai-responses" else "/v1/chat/completions", headers=headers, json=payload)
                        self.assertEqual(result.status_code, 200, (api_format, result.text))
                    self.assertEqual(len(ProviderDouble.seen), 4)
                    for request in ProviderDouble.seen:
                        self.assertNotIn("temperature", request["body"])
                        self.assertNotIn("top_p", request["body"])
                    wire = [request["body"] for request in ProviderDouble.seen]
                    self.assertEqual(wire[0]["reasoning_effort"], "medium")
                    self.assertEqual(wire[1]["reasoning"]["effort"], "medium")
                    self.assertEqual(wire[2]["max_tokens"], 512)
                    self.assertIn("thinkingConfig", wire[3]["generationConfig"])
                    usage = client.get("/galaxy/usage?days=7", headers={"Authorization": "Bearer " + KEY}).json()
                    self.assertEqual(usage["calls"]["total"], 4)
                    self.assertEqual(usage["calls"]["completed"], 4)
                    self.assertEqual(usage["tokens"]["input"], 44)
                    self.assertFalse(usage["coversWholeWindow"])
                    self.assertNotIn("SYNTHETIC_PROMPT", json.dumps(usage))
                    self.assertNotIn("SYNTHETIC_LOCAL_PROVIDER_DOUBLE_ONLY", json.dumps(usage))
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=5)
            os.environ.pop("GALAXY_MODEL_PROVIDER_SYNTHETIC_ONLY_KEY", None)

    def test_02_profile_limits_and_unknown_usage_do_not_call_or_invent_tokens(self):
        settings = Settings(service_key=KEY, config_version=VERSION)
        alias = "galaxy-m" + "1".zfill(32)
        models = [row(alias, "openai-responses", "http://127.0.0.1:9/v1")]
        profiles = {alias: profile("openai-responses", "governance")}
        async def must_not_run(scope, receive, send): raise AssertionError("Rejected request reached provider")
        with TemporaryDirectory() as directory:
            store = UsageStore(Path(directory) / "usage.sqlite3")
            guarded = PrivateSurface(must_not_run, settings, models, profiles, store, token_counter=lambda *args, **kwargs: 8192)
            headers = [(b"authorization", ("Bearer " + KEY).encode()), (b"x-galaxy-model-scenario", b"governance"), (b"x-galaxy-model-config-version", VERSION.encode())]
            payload = {"model": alias, "input": "SYNTHETIC_PROMPT", "store": False, "max_output_tokens": 512, "reasoning": {"effort": "medium"}}
            code, body, _ = asyncio.run(exchange(guarded, "/v1/responses", method="POST", headers=headers, payload=payload))
            self.assertEqual(code, 422)
            self.assertEqual(json.loads(body)["error"]["code"], "model_gateway_context_window_exceeded")
            self.assertEqual(store.summary(7)["calls"]["total"], 0)
            for changed in (dict(payload, max_output_tokens=1024), dict(payload, temperature=0.1), dict(payload, previous_response_id="resp_other")):
                self.assertEqual(asyncio.run(exchange(guarded, "/v1/responses", method="POST", headers=headers, payload=changed))[0], 400)
            call_id = str(uuid4()); metadata = {"galaxy_call_id": call_id, "galaxy_scenario": "governance", "galaxy_model_alias": alias, "galaxy_config_version": VERSION}
            store.start(metadata)
            from galaxy_model_gateway.metadata import safe_record
            record = safe_record({"litellm_params": {"metadata": metadata}}, {"usage": {"input_tokens": 11, "output_tokens": 3, "total_tokens": 14}}, None, None)
            store.finish(record); store.finish(record)
            store.start({**metadata, "galaxy_call_id": str(uuid4())})
            result = store.summary(7)
            self.assertEqual(result["calls"], {"total": 2, "completed": 1, "failed": 0, "unknown": 1})
            self.assertEqual(result["tokens"]["total"], 14)
            self.assertEqual(result["unknownUsageCalls"], 1)
            zero = safe_record({"litellm_params": {"metadata": metadata}}, {"usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}}, None, None)
            self.assertIsNone(zero["totalTokens"])


if __name__ == "__main__": unittest.main()
