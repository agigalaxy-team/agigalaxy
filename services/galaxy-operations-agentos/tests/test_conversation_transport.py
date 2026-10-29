from contextlib import ExitStack
"""Actual Agno/ASGI/SQLite transport and ownership, with an explicit local model.

The queue row is a synthetic native-SQL fixture, not a durable worker proof.
Production's real queue key ABI was separately read in native-queue-binding-abi.
"""
import asyncio
from dataclasses import dataclass
import json
from pathlib import Path
import socket
import tempfile
import time
import unittest
from unittest.mock import patch
from uuid import uuid4

from agno.agent import Agent
from agno.db.sqlite import SqliteDb
from agno.models.base import Model
from agno.models.response import ModelResponse
from agno.os import AgentOS, Authorization
from fastapi.testclient import TestClient
import jwt
from sqlalchemy import Column, MetaData, Table, Text

from galaxy_agentos.app import PrivateSurface, run_view
from galaxy_agentos.authorization import GalaxyAuthorization
from galaxy_agentos.config import Settings
from galaxy_agentos.conversation_transport import install_conversation_transport_read
from galaxy_agentos.conversations import install_conversation_read
from galaxy_agentos.gateway import AuthorityDenied


@dataclass
class LocalModel(Model):
    id: str = 'synthetic-stream-model'
    name: str = 'LocalOnly'
    provider: str = 'ExplicitSynthetic'
    calls: int = 0

    def invoke(self, *args, **kwargs):
        self.calls += 1
        return ModelResponse(role='assistant', content='完整的本地回复 🌌。')

    async def ainvoke(self, *args, **kwargs):
        return self.invoke(*args, **kwargs)

    def invoke_stream(self, *args, **kwargs):
        self.calls += 1
        for text in ['完整的', '本地回复 ', '🌌。']:
            yield ModelResponse(role='assistant', content=text)

    async def ainvoke_stream(self, *args, **kwargs):
        for item in self.invoke_stream(*args, **kwargs):
            yield item

    def _parse_provider_response(self, response, **kwargs):
        return response

    def _parse_provider_response_delta(self, response):
        return response


class CurrentReader:
    def __init__(self, row):
        self.row, self.revoked = row, False

    def authorize(self, user_id, **kwargs):
        if self.revoked or user_id != 'conversation:' + self.row['id']:
            raise AuthorityDenied('synthetic_current_reader_denied')
        if kwargs.get('resource_type') not in {None, 'agents'} or kwargs.get('resource_id') not in {None, 'galaxy-conversation-governance'}:
            raise AuthorityDenied('synthetic_scope_denied')
        return {'allowed': True, 'execution': self.row, 'resourceIds': ['galaxy-conversation-governance'], 'readExpiresAt': int(time.time()) + 30}


class ConversationTransportTest(unittest.TestCase):
    def test_original_lookup_and_stream_replay_keep_session_binding_and_never_submit_or_cancel_a_different_run(self):
        original_connect = socket.socket.connect
        network_attempts = []

        def closed_connect(sock, address):
            if sock.family in {socket.AF_INET, socket.AF_INET6} and address[0] not in {'127.0.0.1', '::1'}:
                network_attempts.append(True)
                raise AssertionError('No provider or external network is allowed in this native leaf')
            return original_connect(sock, address)

        with tempfile.TemporaryDirectory() as directory, ExitStack() as cleanup, patch.object(socket.socket, 'connect', closed_connect):
            db = SqliteDb(db_file=str(Path(directory) / 'transport.sqlite3'), id='synthetic-conversation-transport')
            cleanup.callback(db.db_engine.dispose)
            settings = Settings(database_url='postgresql+psycopg://not-connected.invalid/synthetic',
                authority_url='http://127.0.0.1:1/v1/internal/agentos/', service_key='synthetic-service-key-not-production',
                verification_key='synthetic-signing-key-not-production-at-least-32')
            row = {'id': str(uuid4()), 'sessionId': str(uuid4()), 'domain': 'governance', 'mode': 'conversation', 'actions': [], 'resourceIds': []}
            gateway, model = CurrentReader(row), LocalModel()
            agent = Agent(id='galaxy-conversation-governance', model=model, db=db, store_events=True,
                telemetry=False, markdown=True)
            native = AgentOS(id='synthetic-transport', db=db, agents=[agent], user_isolation=True,
                authorization=Authorization(verification_keys=[settings.verification_key], algorithm='HS256',
                    verify_audience=True, audience=settings.audience, issuer=settings.issuer,
                    authorization_provider=GalaxyAuthorization(gateway)), telemetry=False, tracing=False, scheduler=False)
            app = native.get_app()
            # SQLite does not implement Agno's production jobs table. Keep
            # real run/session persistence and model execution; supply only
            # the seven-column queue metadata fixture used by the new reader.
            metadata = MetaData()
            jobs = Table('synthetic_queue_metadata', metadata, *(Column(name, Text, primary_key=name == 'id') for name in
                ['id', 'idempotency_key', 'user_id', 'session_id', 'component_type', 'component_id', 'status']))
            class QueueMetadataFixture:
                Session = db.Session
                def _get_table(self, table_type, create_table_if_not_found=False):
                    return jobs if table_type == 'jobs' else db._get_table(table_type, create_table_if_not_found)
                def __getattr__(self, name):
                    return getattr(db, name)
            runtime = {'os': native, 'db': QueueMetadataFixture(), 'gateway': gateway, 'configuredDomains': {'governance'}}
            install_conversation_read(app, runtime, run_view)
            install_conversation_transport_read(app, runtime, run_view)
            app.add_middleware(PrivateSurface, settings=settings, runtime=runtime)
            now = int(time.time())
            token = jwt.encode({'sub': 'conversation:' + row['id'], 'iat': now, 'exp': now + 120,
                'aud': settings.audience, 'iss': settings.issuer}, settings.verification_key, algorithm='HS256')
            headers = {'Authorization': 'Bearer ' + token}
            operation = str(uuid4())
            with TestClient(app) as client:
                response = client.post('/agents/galaxy-conversation-governance/runs', headers={**headers, 'Idempotency-Key': operation},
                    data={'message': '本地完整回复', 'stream': 'true', 'background': 'true', 'session_id': row['sessionId']})
                self.assertEqual(response.status_code, 200)
                frames = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
                run_id = next(frame['run_id'] for frame in frames if frame.get('run_id'))
                self.assertEqual(model.calls, 1)
                with db.Session() as session:
                    metadata.create_all(bind=session.get_bind())
                    session.execute(jobs.insert().values(id=run_id, idempotency_key=operation, component_type='agent',
                        component_id=agent.id, user_id='conversation:' + row['id'], session_id=row['sessionId'],
                        status='completed'))
                    session.commit()
                original = client.get('/galaxy/conversations/' + row['id'] + '/operations/' + operation, headers=headers)
                self.assertEqual(original.status_code, 200)
                self.assertEqual(original.json()['operationId'], operation)
                self.assertEqual(original.json()['conversationId'], row['id'])
                self.assertEqual(original.json()['sessionId'], row['sessionId'])
                self.assertEqual(original.json()['runId'], run_id)
                self.assertEqual(original.json()['state'], 'COMPLETED')
                self.assertEqual(original.json()['native']['content'], '完整的本地回复 🌌。')
                missing = client.get('/galaxy/conversations/' + row['id'] + '/operations/' + str(uuid4()), headers=headers)
                self.assertEqual(missing.json()['state'], 'unknown')
                self.assertIsNone(missing.json()['runId'])
                self.assertIsNone(missing.json()['native'])
                resumed = client.post('/agents/' + agent.id + '/runs/' + run_id + '/resume', headers=headers,
                    data={'session_id': row['sessionId'], 'last_event_index': '1'})
                self.assertEqual(resumed.status_code, 200)
                self.assertIn('text/event-stream', resumed.headers['content-type'])
                replay = [json.loads(line[6:]) for line in resumed.text.splitlines() if line.startswith('data: ')]
                self.assertTrue(replay, 'Actual native stored-event replay was reached')
                indexed = [item['event_index'] for item in replay if 'event_index' in item]
                self.assertTrue(all(index > 1 for index in indexed))
                self.assertEqual(model.calls, 1, 'Resume and original lookup never invoke the model')
                cancelled = client.post('/agents/' + agent.id + '/runs/' + run_id + '/cancel?session_id=' + row['sessionId'], headers=headers, data={})
                self.assertEqual(cancelled.status_code, 200)
                current = client.get('/galaxy/conversations/' + row['id'] + '/operations/' + operation, headers=headers)
                self.assertEqual(current.json()['state'], 'COMPLETED', 'Cancelling an already completed run does not undo its result')
                for data in [
                    {'session_id': str(uuid4())},
                    {'session_id': row['sessionId'], 'metadata': '{}'},
                    {'session_id': row['sessionId'], 'last_event_index': '-1'},
                ]:
                    denied = client.post('/agents/' + agent.id + '/runs/' + run_id + '/resume', headers=headers, data=data)
                    self.assertEqual(denied.status_code, 403)
                other = asyncio.run(agent.arun('另一名合成主体', session_id=str(uuid4()), user_id='conversation:' + str(uuid4()), stream=False))
                foreign = client.post('/agents/' + agent.id + '/runs/' + other.run_id + '/resume', headers=headers, data={'session_id': row['sessionId']})
                self.assertIn(foreign.status_code, {403, 404})
                foreign_cancel = client.post('/agents/' + agent.id + '/runs/' + other.run_id + '/cancel?session_id=' + row['sessionId'], headers=headers, data={})
                self.assertIn(foreign_cancel.status_code, {403, 404})
                calls = model.calls
                gateway.revoked = True
                self.assertEqual(client.get('/galaxy/conversations/' + row['id'] + '/operations/' + operation, headers=headers).status_code, 403)
                self.assertEqual(client.post('/agents/' + agent.id + '/runs/' + run_id + '/resume', headers=headers, data={'session_id': row['sessionId']}).status_code, 403)
                self.assertEqual(model.calls, calls)
            self.assertEqual(network_attempts, [])


if __name__ == '__main__':
    unittest.main()
