"""Synthetic loopback wrapper; unmodified Apache-2.0 HelloWorld executor.

No model, credential store, external network client, or production participant.
The declared logical HTTPS URL is pinned by the JS test's transport injection.
"""
import json
import socket
import sys
from pathlib import Path
from importlib.metadata import version

sys.path.insert(0, str(Path(__file__).parent / "vendor"))
from agent_executor import HelloWorldAgentExecutor
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import AgentCard, AgentCapabilities, AgentInterface, AgentSkill
from starlette.applications import Starlette
import uvicorn
from lifecycle import LifecycleExecutor

assert version("a2a-sdk") == "1.1.2"
card = AgentCard(name="Official Python HelloWorld synthetic peer", description="No model protocol fixture",
    version="sample-1bb0871294af52fdb2c7e5173e43fade0eb008ba",
    default_input_modes=["text/plain"], default_output_modes=["text/plain"],
    capabilities=AgentCapabilities(streaming=False),
    skills=[AgentSkill(id="hello_world", name="Returns hello world", description="Deterministic response", tags=["hello"])],
    supported_interfaces=[AgentInterface(protocol_binding="JSONRPC", url="https://python-peer.example.org/a2a", protocol_version="1.0")])
handler = DefaultRequestHandler(agent_executor=HelloWorldAgentExecutor(), task_store=InMemoryTaskStore(), agent_card=card)
extension_card = AgentCard()
extension_card.CopyFrom(card)
extension_card.name = "Galaxy deterministic Python lifecycle fixture"
extension_card.supported_interfaces[0].url = "https://python-peer.example.org/lifecycle"
extension_handler = DefaultRequestHandler(agent_executor=LifecycleExecutor(), task_store=InMemoryTaskStore(), agent_card=extension_card)
app = Starlette(routes=[*create_agent_card_routes(agent_card=card), *create_jsonrpc_routes(request_handler=handler, rpc_url="/a2a"),
    *create_agent_card_routes(agent_card=extension_card, card_url="/lifecycle-card.json"),
    *create_jsonrpc_routes(request_handler=extension_handler, rpc_url="/lifecycle")])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.bind(("127.0.0.1", 0))
sock.listen(128)
print(json.dumps({"port": sock.getsockname()[1], "sdk": version("a2a-sdk"), "protocol": "1.0"}), flush=True)
uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False)).run(sockets=[sock])
