import asyncio
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from uuid import uuid4

from galaxy_model_gateway.endpoints import protocol_base
from galaxy_model_gateway.response_guard import ResponseGuard
from galaxy_model_gateway.usage import UsageStore


async def guarded(parts, *, stream=False, responses=False, content_type=None, status=200):
    output, failures = [], []
    async def send(value): output.append(value)
    async def rejected(): failures.append(True)
    guard = ResponseGuard(send, stream=stream, responses=responses, version="fixture-v1", rejected=rejected)
    await guard.send({"type":"http.response.start", "status":status, "headers":[
        (b"content-type",content_type or (b"text/event-stream" if stream else b"application/json")),
        (b"x-provider-debug", b"PRIVATE_CANARY")]})
    for index, part in enumerate(parts):
        await guard.send({"type":"http.response.body","body":part,"more_body":index < len(parts)-1})
    await guard.complete()
    return output, failures


def event(value):
    return b"data: " + json.dumps(value).encode() + b"\n\n"


class ConnectionRobustnessTest(unittest.TestCase):
    def test_root_and_full_endpoints_preserve_custom_prefixes(self):
        for fmt in ["openai-chat","openai-responses"]:
            self.assertEqual(protocol_base("https://gateway.example/",fmt),"https://gateway.example/v1")
            self.assertEqual(protocol_base("https://gateway.example/proxy/v1/chat/completions/",fmt),
                "https://gateway.example/proxy/v1")
            self.assertEqual(protocol_base("https://opencode.ai/inference/openai/v1",fmt),
                "https://opencode.ai/inference/openai/v1")
        self.assertEqual(protocol_base("https://gateway.example//","gemini"),"https://gateway.example/v1beta")
        self.assertEqual(protocol_base("https://gateway.example/proxy/v1beta/models/model:generateContent","gemini"),
            "https://gateway.example/proxy/v1beta")
        self.assertEqual(protocol_base("https://gateway.example/v1/messages","anthropic"),"https://gateway.example/v1")

    def test_html_empty_and_truncated_are_not_success(self):
        cases = [([b"<html>PRIVATE_CANARY</html>"],{"content_type":b"text/html"}),
            ([b'{"choices":[{"finish_reason":"stop","message":{"content":null}}]}'],{}),
            ([b'{"output":[],"status":"completed"}'],{"responses":True}),
            ([b'{"choices":'],{}),
            ([event({"choices":[{"delta":{"content":"answer"},"finish_reason":None}]})],{"stream":True}),
            ([event({"choices":[{"delta":{},"finish_reason":"stop"}]})+b"data: [DONE]\n\n"],{"stream":True})]
        for body, options in cases:
            with self.subTest(options=options, body=body):
                output, failures = asyncio.run(guarded(body,**options))
                self.assertEqual(len(failures),1)
                payload=b"".join(x.get("body",b"") for x in output)
                if options.get("stream") and body[0].endswith(b"data: [DONE]\n\n"):
                    self.assertEqual(output[0]["status"],502)
                    self.assertEqual(json.loads(payload)["error"],{"code":"model_gateway_empty_completion",
                        "source":"model-gateway","status":502,"category":"empty-completion","outputStarted":False})
                else:
                    self.assertIn(b"model_gateway_response_invalid",payload)
                self.assertNotIn("PRIVATE_CANARY",repr(output))
                self.assertFalse(output[-1].get("more_body"))

    def test_chat_tool_and_responses_answers_pass_without_rewriting_body(self):
        values = [
            ({"choices":[{"finish_reason":"stop","message":{"content":"answer"}}]},False),
            ({"choices":[{"finish_reason":"tool_calls","message":{"content":None,"tool_calls":[
                {"id":"call_1","type":"function","function":{"name":"read_clock","arguments":"{}"}}]}}]},False),
            ({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"answer"}]}]},True)]
        for value, responses in values:
            body=json.dumps(value).encode()
            output, failures=asyncio.run(guarded([body[:7],body[7:]],responses=responses))
            self.assertFalse(failures)
            self.assertEqual(output[0]["status"],200)
            self.assertEqual(b"".join(x.get("body",b"") for x in output),body)
            self.assertNotIn("PRIVATE_CANARY",repr(output))

    def test_stream_frames_split_across_packets_and_error_after_start(self):
        body=event({"choices":[{"delta":{"content":"answer"},"finish_reason":None}]})+event(
            {"choices":[{"delta":{},"finish_reason":"stop"}]})+b"data: [DONE]\n\n"
        output,failures=asyncio.run(guarded([body[:11],body[11:37],body[37:]],stream=True))
        self.assertFalse(failures)
        self.assertEqual(b"".join(x.get("body",b"") for x in output),body)
        complete={"type":"response.completed","response":{"status":"completed","output":[
            {"type":"message","content":[{"type":"output_text","text":"answer"}]}]}}
        body=event({"type":"response.output_text.delta","delta":"answer"})+event(complete)
        output,failures=asyncio.run(guarded([body],stream=True,responses=True))
        self.assertFalse(failures)
        output,failures=asyncio.run(guarded([event({"choices":[{"delta":{"content":"answer"},"finish_reason":None}]}),
            event({"error":{"message":"PRIVATE_CANARY"}})],stream=True))
        self.assertEqual(len(failures),1)
        self.assertNotIn("PRIVATE_CANARY",repr(output))
        self.assertNotIn(b"[DONE]",b"".join(x.get("body",b"") for x in output))

    def test_rejected_response_wins_over_late_sdk_success_without_losing_usage(self):
        with TemporaryDirectory() as folder:
            store=UsageStore(Path(folder)/"usage.sqlite3")
            call=str(uuid4())
            store.start({"galaxy_call_id":call,"galaxy_scenario":"overview","galaxy_model_alias":"galaxy-test",
                "galaxy_config_version":"fixture-v1"})
            receipt={"callId":call,"state":"completed","inputTokens":9,"outputTokens":4,"totalTokens":13}
            store.finish(receipt)
            store.reject_response(call)
            store.finish(receipt)
            result=store.summary(7)
            self.assertEqual(result["calls"],{"total":1,"completed":0,"failed":1,"unknown":0})
            self.assertEqual(result["tokens"]["total"],13)


if __name__=="__main__": unittest.main()
