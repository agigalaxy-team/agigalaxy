"""Actual ASGI routes and Agno 3.1.7 authorization scope; no provider/network.

Blocking authority/database doubles make event-loop starvation deterministic.
The SQLite leaf separately exercises the actual native get_runs implementation;
it does not claim to reproduce production PostgreSQL locks or the observed RTT.
"""
import asyncio
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from uuid import uuid4

import httpx
import jwt
from fastapi import FastAPI
from agno.db.sqlite import SqliteDb
from agno.models.base import Model
from agno.models.response import ModelResponse
from agno.os.authz.provider import AuthorizationContext
from agno.run.agent import RunOutput
from agno.run.authorization import RunAuthorization, authorization_scope
from agno.run.base import RunStatus
from agno.session.agent import AgentSession

from galaxy_agentos.app import PrivateSurface, run_view
from galaxy_agentos.authorization import GalaxyAuthorization
from galaxy_agentos.config import Settings
from galaxy_agentos.conversations import install_conversation_read
from galaxy_agentos.gateway import AuthorityDenied
from galaxy_agentos.model_gate import with_current_authority


REQUEST_CONTEXT = ContextVar("synthetic_read_context", default=None)


class Reader:
    def __init__(self):
        self.row = {"id": str(uuid4()), "sessionId": str(uuid4()), "domain": "governance", "mode": "conversation"}
        self.calls, self.contexts, self.threads = 0, [], []
        self.revoked, self.changed = False, False
        self.block_call = None
        self.entered, self.release = threading.Event(), threading.Event()
        self.lease = int(time.time()) + 19

    def authorize(self, user_id, **kwargs):
        self.calls += 1
        self.contexts.append(REQUEST_CONTEXT.get())
        self.threads.append(threading.get_ident())
        if self.calls == self.block_call:
            self.entered.set()
            if not self.release.wait(3):
                raise AssertionError("blocked local reader was not released")
        if self.revoked or user_id != "conversation:" + self.row["id"]:
            raise AuthorityDenied("synthetic_current_reader_denied")
        row = dict(self.row)
        if self.changed:
            row["sessionId"] = str(uuid4())
        return {"allowed": True, "execution": row, "readExpiresAt": self.lease}


class Ledger:
    def __init__(self, reader):
        self.reader, self.calls = reader, []
        self.entered, self.release = threading.Event(), threading.Event()
        self.blocked, self.after = False, None

    def get_runs(self, **kwargs):
        self.calls.append((kwargs, REQUEST_CONTEXT.get(), threading.get_ident()))
        if self.blocked:
            self.entered.set()
            if not self.release.wait(3):
                raise AssertionError("blocked local ledger was not released")
        if self.after:
            self.after()
        return [{"runId": "owned-run", "status": "COMPLETED", "content": "controlled local history", "createdAt": 1}]


def read_app(reader, db, projector=lambda run: dict(run)):
    settings = Settings(database_url="postgresql+psycopg://not-connected.invalid/local",
        authority_url="http://127.0.0.1:1/v1/internal/agentos/",
        service_key="synthetic-read-service-key-never-production",
        verification_key="synthetic-read-signing-key-never-production")
    app = FastAPI()
    runtime = {"gateway": reader, "db": db, "os": SimpleNamespace(agents=[])}
    install_conversation_read(app, runtime, projector)
    app.add_middleware(PrivateSurface, settings=settings, runtime=runtime)
    now = int(time.time())
    token = jwt.encode({"sub": "conversation:" + reader.row["id"], "iat": now, "exp": now + 120,
        "aud": settings.audience, "iss": settings.issuer}, settings.verification_key, algorithm="HS256")
    return app, {"Authorization": "Bearer " + token}


@dataclass
class LocalModel(Model):
    id: str = "concurrency-local-only"
    name: str = "LocalOnly"
    provider: str = "ExplicitSynthetic"
    calls: int = 0
    on_call: object = None

    def _local_result(self):
        self.calls += 1
        if self.on_call:
            self.on_call()
        return ModelResponse(role="assistant", content="local-result")

    def invoke(self, *args, **kwargs):
        return self._local_result()

    async def ainvoke(self, *args, **kwargs):
        return self._local_result()

    def invoke_stream(self, *args, **kwargs):
        yield self._local_result()

    async def ainvoke_stream(self, *args, **kwargs):
        yield self._local_result()

    def _parse_provider_response(self, response, **kwargs):
        return response

    def _parse_provider_response_delta(self, response):
        return response


class CurrentReadConcurrencyTest(unittest.IsolatedAsyncioTestCase):
    async def test_each_current_authority_boundary_and_native_read_leave_asgi_heartbeat_responsive(self):
        for blocked in ("middleware", "before", "database", "after"):
            with self.subTest(blocked=blocked):
                reader = Reader()
                ledger = Ledger(reader)
                if blocked == "database":
                    ledger.blocked = True
                    entered, release = ledger.entered, ledger.release
                else:
                    reader.block_call = {"middleware": 1, "before": 2, "after": 3}[blocked]
                    entered, release = reader.entered, reader.release
                app, headers = read_app(reader, ledger)
                main_thread = threading.get_ident()
                marker = REQUEST_CONTEXT.set("trusted-request")
                try:
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local-asgi") as client:
                        history = asyncio.create_task(client.get("/galaxy/conversations/" + reader.row["id"], headers=headers))
                        try:
                            self.assertTrue(await asyncio.to_thread(entered.wait, 1))
                            started = time.monotonic()
                            heartbeat = await asyncio.wait_for(client.get("/health"), timeout=0.5)
                            self.assertEqual(heartbeat.status_code, 200)
                            self.assertLess(time.monotonic() - started, 0.5)
                            self.assertFalse(history.done(), "A blocked history must not block the ASGI loop")
                        finally:
                            release.set()
                        response = await history
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json()["runs"][0]["runId"], "owned-run")
                    self.assertEqual(response.json()["readExpiresAt"], reader.lease, "No new or longer lease is fabricated")
                    self.assertEqual(reader.calls, 3, "Middleware plus both fresh read checks remain")
                    self.assertEqual(reader.contexts, ["trusted-request"] * 3)
                    self.assertTrue(all(ident != main_thread for ident in reader.threads))
                    self.assertEqual(ledger.calls[0][0], {"session_id": reader.row["sessionId"], "user_id": "conversation:" + reader.row["id"], "agent_id": "galaxy-conversation-governance", "limit": 50, "page": 1, "sort_by": "created_at", "sort_order": "desc"})
                    self.assertEqual(ledger.calls[0][1], "trusted-request")
                    self.assertNotEqual(ledger.calls[0][2], main_thread)
                finally:
                    release.set()
                    REQUEST_CONTEXT.reset(marker)

    async def test_revocation_after_native_read_cannot_release_old_materials(self):
        reader = Reader()
        ledger = Ledger(reader)
        ledger.after = lambda: setattr(reader, "revoked", True)
        app, headers = read_app(reader, ledger)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local-asgi") as client:
            response = await client.get("/galaxy/conversations/" + reader.row["id"], headers=headers)
        self.assertEqual(response.status_code, 403)
        self.assertNotIn("controlled local history", response.text)
        self.assertEqual(reader.calls, 3)

    async def test_source_session_change_at_final_check_cannot_release_old_materials(self):
        reader = Reader()
        ledger = Ledger(reader)
        ledger.after = lambda: setattr(reader, "changed", True)
        app, headers = read_app(reader, ledger)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local-asgi") as client:
            response = await client.get("/galaxy/conversations/" + reader.row["id"], headers=headers)
        self.assertEqual(response.status_code, 403)
        self.assertNotIn("controlled local history", response.text)

    async def test_actual_agno_database_owned_history_survives_thread_offload(self):
        reader = Reader()
        with tempfile.TemporaryDirectory() as directory:
            db = SqliteDb(db_file=str(Path(directory) / "read.sqlite3"), id="local-threaded-history")
            try:
                principal = "conversation:" + reader.row["id"]
                db.upsert_session(AgentSession(session_id=reader.row["sessionId"], agent_id="galaxy-conversation-governance", user_id=principal))
                db.upsert_run(RunOutput(run_id="persisted-owned-run", agent_id="galaxy-conversation-governance",
                    session_id=reader.row["sessionId"], user_id=principal,
                    status=RunStatus.completed, content="persisted local history", created_at=int(time.time())), session_id=reader.row["sessionId"], user_id=principal)
                app, headers = read_app(reader, db, run_view)
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local-asgi") as client:
                    response = await client.get("/galaxy/conversations/" + reader.row["id"], headers=headers)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["runs"][0]["runId"], "persisted-owned-run")
                self.assertEqual(response.json()["runs"][0]["content"], "persisted local history")
                self.assertEqual(response.json()["readExpiresAt"], reader.lease)
            finally:
                db.db_engine.dispose()

    async def test_async_model_gate_copies_real_agno_scope_and_does_not_block_loop(self):
        reader = Reader()
        reader.block_call = 1
        model = with_current_authority(LocalModel(), reader)
        principal = "conversation:" + reader.row["id"]
        authority = RunAuthorization(provider=GalaxyAuthorization(reader), context=AuthorizationContext(principal_id=principal), enforce_tools=False)
        marker = REQUEST_CONTEXT.set("trusted-model-run")
        try:
            with authorization_scope(lambda: authority):
                call = asyncio.create_task(model.ainvoke())
                try:
                    self.assertTrue(await asyncio.to_thread(reader.entered.wait, 1))
                    await asyncio.wait_for(asyncio.sleep(0), timeout=0.5)
                    self.assertFalse(call.done())
                    self.assertEqual(model.calls, 0)
                finally:
                    reader.release.set()
                response = await call
            self.assertEqual(response.content, "local-result")
            self.assertEqual(model.calls, 1)
            self.assertEqual(reader.contexts, ["trusted-model-run"] * 2)
            self.assertTrue(all(ident != threading.get_ident() for ident in reader.threads))
        finally:
            REQUEST_CONTEXT.reset(marker)

    async def test_async_and_stream_postchecks_still_reject_revoked_authority(self):
        for stream in (False, True):
            with self.subTest(stream=stream):
                reader = Reader()
                model = with_current_authority(LocalModel(on_call=lambda: setattr(reader, "revoked", True)), reader)
                authority = RunAuthorization(provider=GalaxyAuthorization(reader), context=AuthorizationContext(principal_id="conversation:" + reader.row["id"]), enforce_tools=False)
                with authorization_scope(lambda: authority):
                    with self.assertRaises(AuthorityDenied):
                        if stream:
                            async for _ in model.ainvoke_stream():
                                pass
                        else:
                            await model.ainvoke()
                self.assertEqual(reader.calls, 2)
                self.assertEqual(model.calls, 1)

    async def test_missing_agno_authority_never_enters_model(self):
        model = with_current_authority(LocalModel(), Reader())
        with self.assertRaises(AuthorityDenied):
            await model.ainvoke()
        self.assertEqual(model.calls, 0)

    async def test_sync_model_entry_keeps_same_thread_and_pre_post_checks(self):
        reader = Reader()
        model = with_current_authority(LocalModel(), reader)
        authority = RunAuthorization(provider=GalaxyAuthorization(reader), context=AuthorizationContext(principal_id="conversation:" + reader.row["id"]), enforce_tools=False)
        with authorization_scope(lambda: authority):
            self.assertEqual(model.invoke().content, "local-result")
        self.assertEqual(reader.calls, 2)
        self.assertEqual(reader.threads, [threading.get_ident()] * 2)


if __name__ == "__main__":
    unittest.main()
