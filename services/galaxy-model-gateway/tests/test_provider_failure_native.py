"""Actual local HTTP provider -> LiteLLM callback -> Galaxy guard provenance.

No production configuration, credentials, provider traffic or business data.
"""
import json
import os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import tempfile
import time
import socket
import unittest
from unittest.mock import patch
import yaml
from fastapi.testclient import TestClient


class NativeProviderFailure(unittest.TestCase):
    def test_native_http_failure_and_timeout_keep_provider_origin(self):
        environment = patch.dict(os.environ, {"NO_PROXY": "127.0.0.1,localhost,::1", "no_proxy": "127.0.0.1,localhost,::1"})
        environment.start(); self.addCleanup(environment.stop)
        for variable in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            os.environ.pop(variable, None)
        from galaxy_model_gateway.app import create_app
        from galaxy_model_gateway.policy import Settings
        calls=[]
        class Provider(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                self.rfile.read(int(self.headers.get('content-length','0')))
                name=self.path.split('/')[1];calls.append(name)
                if name=='disconnect':
                    self.connection.shutdown(socket.SHUT_RDWR);self.connection.close();return
                if name=='timeout':time.sleep(2.5)
                status=int(name) if name.isdigit() else 503
                body=json.dumps({'error':{'message':'local failure fixture','type':'api_error','code':'fixture'}}).encode()
                try:
                    self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
                except (BrokenPipeError,ConnectionResetError):pass
        server=ThreadingHTTPServer(('127.0.0.1',0),Provider)
        server.daemon_threads=True
        worker=Thread(target=server.serve_forever,daemon=True);worker.start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        key='local-test-service-key-never-production-00001'
        os.environ['GALAXY_MODEL_PROVIDER_FAILURE_FIXTURE_KEY']='local-provider-fixture'
        with tempfile.TemporaryDirectory() as directory:
            rows=[];profiles={}
            for name in ['401','402','403','429','502','503','507','timeout','disconnect']:
                alias='galaxy-failure-'+name
                rows.append({'model_name':alias,'litellm_params':{'model':'custom_openai/local-fixture','api_base':f'http://127.0.0.1:{server.server_port}/{name}/v1','api_key':'os.environ/GALAXY_MODEL_PROVIDER_FAILURE_FIXTURE_KEY'},'model_info':{'mode':'chat','max_input_tokens':7680,'max_output_tokens':512,'supported_endpoints':['/v1/chat/completions']}})
                profiles[alias]={'apiFormat':'openai-chat','contextWindow':8192,'maxOutputTokens':512,'reasoningEffort':None,'timeoutSeconds':1,'toolCalling':True,'structuredOutput':True,'scenarios':['overview']}
            path=Path(directory)/'models.yaml';path.write_text(yaml.safe_dump({'model_list':rows,'galaxy_profiles':profiles}))
            app=create_app(Settings(service_key=key,models_file=str(path),config_version='failure-test-v1',usage_file=str(Path(directory)/'usage.db')),quiet=True)
            with TestClient(app,raise_server_exceptions=False) as client:
                headers={'Authorization':'Bearer '+key,'X-Galaxy-Model-Scenario':'overview','X-Galaxy-Model-Config-Version':'failure-test-v1'}
                for name in ['401','402','403','429','502','503','507','timeout','disconnect']:
                    with self.subTest(provider=name):
                        response=client.post('/v1/chat/completions',headers=headers,json={'model':'galaxy-failure-'+name,'messages':[{'role':'user','content':'local fixture only'}],'max_tokens':512,'store':False})
                        self.assertGreaterEqual(response.status_code,400)
                        self.assertEqual(response.json()['error'].get('source'),'provider',response.text)
                        if name.isdigit(): self.assertEqual(response.status_code, int(name), response.text)
                        self.assertNotIn('local failure fixture',response.text)
            self.assertEqual(set(calls),{'401','402','403','429','502','503','507','timeout','disconnect'})


if __name__=='__main__':unittest.main()
