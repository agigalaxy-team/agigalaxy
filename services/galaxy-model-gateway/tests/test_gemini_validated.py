"""Locked LiteLLM Proxy to loopback Gemini double; no model calls."""
import asyncio
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from unittest import TestCase
from unittest.mock import patch

from fastapi.testclient import TestClient
import yaml
from galaxy_model_gateway.policy import Settings
from test_model_profiles import KEY, VERSION, profile, row
from test_gateway import exchange
from galaxy_model_gateway.surface import PrivateSurface

class GeminiDouble(BaseHTTPRequestHandler):
    seen = []
    def log_message(self, *args): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.seen.append(body)
        result = {"candidates":[{"content":{"role":"model","parts":[{"text":"synthetic result"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":3,"totalTokenCount":14}}
        if ":streamGenerateContent" in self.path:
            data = ("data: " + json.dumps(result) + "\n\n").encode()
            self.send_response(200); self.send_header("Content-Type","text/event-stream"); self.send_header("Content-Length",str(len(data))); self.end_headers(); self.wfile.write(data)
        else:
            data=json.dumps(result).encode()
            self.send_response(200); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(data))); self.end_headers(); self.wfile.write(data)

class GeminiValidatedTest(TestCase):
    def test_proxy_sends_validated_only_for_automatic_function_tools(self):
        from galaxy_model_gateway.app import create_app
        GeminiDouble.seen=[]
        server=ThreadingHTTPServer(("127.0.0.1",0),GeminiDouble)
        thread=Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        env={"NO_PROXY":"127.0.0.1,localhost,::1","no_proxy":"127.0.0.1,localhost,::1","GALAXY_MODEL_PROVIDER_SYNTHETIC_ONLY_KEY":"synthetic-local-only"}
        with patch.dict(os.environ,env,clear=True), TemporaryDirectory() as directory:
            root=Path(directory);alias="galaxy-m"+"1".zfill(32)
            model=row(alias,"gemini",f"http://127.0.0.1:{server.server_port}/")
            file=root/"models.yaml";file.write_text(yaml.safe_dump({"model_list":[model],"galaxy_profiles":{alias:profile("gemini","overview")}}))
            settings=Settings(service_key=KEY,models_file=str(file),config_version=VERSION,usage_file=str(root/"usage.sqlite3"))
            app=create_app(settings,quiet=False)
            headers={"Authorization":"Bearer "+KEY,"X-Galaxy-Model-Scenario":"overview","X-Galaxy-Model-Config-Version":VERSION}
            function={"type":"function","function":{"name":"lookup","description":"Read a synthetic fact","parameters":{"type":"object","properties":{"value":{"type":"string"}},"required":["value"]}}}
            base={"model":alias,"messages":[{"role":"user","content":"synthetic prompt"}],"max_tokens":512,"reasoning_effort":"medium","tools":[function]}
            with TestClient(app,raise_server_exceptions=False) as client:
                for choice,stream,expected in [(None,False,"VALIDATED"),("auto",True,"VALIDATED"),("none",False,"NONE"),("required",False,"ANY"),({"type":"function","function":{"name":"lookup"}},False,"ANY")]:
                    payload={**base,"stream":stream}
                    if choice is not None:payload["tool_choice"]=choice
                    response=client.post("/v1/chat/completions",headers=headers,json=payload)
                    self.assertEqual(response.status_code,200,response.text)
                    wire=GeminiDouble.seen[-1]
                    config=wire.get("toolConfig",{}).get("functionCallingConfig",{})
                    self.assertEqual(config.get("mode"),expected,(choice,wire))
                    if isinstance(choice,dict):
                        self.assertIn("lookup",config.get("allowed_function_names",config.get("allowedFunctionNames",[])))
                response=client.post("/v1/chat/completions",headers=headers,json={**base,"tools":[]})
                self.assertEqual(response.status_code,200,response.text)
                self.assertNotEqual(GeminiDouble.seen[-1].get("toolConfig",{}).get("functionCallingConfig",{}).get("mode"),"VALIDATED")
                before=len(GeminiDouble.seen)
                response=client.post("/v1/chat/completions",headers=headers,json={**base,"extra_body":{"toolConfig":{}}})
                self.assertEqual(response.status_code,400)
                self.assertEqual(len(GeminiDouble.seen),before)

    def test_other_models_and_mixed_tools_are_not_mutated(self):
        alias="galaxy-m"+"2".zfill(32)
        headers=[(b"authorization",("Bearer "+KEY).encode()),(b"x-galaxy-model-scenario",b"overview"),(b"x-galaxy-model-config-version",VERSION.encode())]
        seen=[]
        async def native(scope,receive,send):
            seen.append(json.loads((await receive())["body"]))
            await send({"type":"http.response.start","status":200,"headers":[(b"content-type",b"application/json")]})
            await send({"type":"http.response.body","body":b'{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}',"more_body":False})
        class Usage:
            def start(self, metadata): pass
        settings=Settings(service_key=KEY,config_version=VERSION)
        function={"type":"function","function":{"name":"lookup","parameters":{"type":"object","properties":{}}}}
        for fmt,tools in [("gemini",[function,{"type":"web_search"}]),("openai-chat",[function])]:
            models=[row(alias,fmt,"http://127.0.0.1:9/")]
            app=PrivateSurface(native,settings,models,{alias:profile(fmt,"overview")},Usage(),token_counter=lambda *args,**kwargs:5)
            payload={"model":alias,"messages":[{"role":"user","content":"synthetic"}],"max_tokens":512,"reasoning_effort":"medium","tools":tools}
            status,_,_=asyncio.run(exchange(app,"/v1/chat/completions",method="POST",headers=headers,payload=payload))
            self.assertEqual(status,200)
            self.assertNotIn("extra_body",seen[-1])
