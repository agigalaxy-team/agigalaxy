import asyncio
import json
import time
import unittest
from types import SimpleNamespace
from urllib.parse import parse_qs
from uuid import uuid4

import httpx
import jwt
from agno.agent import Agent
from agno.agent._messages import execute_instructions
from agno.models.openai import OpenAIChat
from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall
from pydantic import TypeAdapter, ValidationError

from galaxy_agentos.app import PrivateSurface
from galaxy_agentos.conversation_references import (
    user_public_references, current_public_references,
    selected_query_reference, reference_aware_instructions,
)
from galaxy_agentos.conversation_tools import QueryFilters, PreparedOperation, conversation_tools
from galaxy_agentos.gateway import GalaxyGateway


class CanonicalPublicReferences(unittest.TestCase):
    def test_canonical_version_reply_and_ambiguity_are_current_turn_restrictions(self):
        conversation, session, turn, post, first, second, reply = (str(uuid4()) for _ in range(7))
        url = f'https://agigalaxy.org/app/community/posts/{post}/versions/{first}'
        next_url = url.replace(first, second)
        reply_url = f'https://agigalaxy.org/app/community/replies/{reply}'
        ref = {'kind': 'post', 'id': post, 'versionId': first}
        reply_ref = {'kind': 'reply', 'id': reply}
        message = f'请核对 {url}，只为这个明确版本准备人工分类卡。'
        parsed = user_public_references(message)
        self.assertEqual(parsed['items'], [ref])
        self.assertEqual(user_public_references(reply_url)['items'], [reply_ref])
        self.assertEqual(user_public_references(f'https://agigalaxy.org/app/community?post={post}')['items'], [{'kind': 'post', 'id': post}])
        self.assertEqual(user_public_references(url + ' ' + url)['items'], [ref])
        both = user_public_references(url + ' ' + next_url)
        self.assertEqual(both['items'], [ref, {**ref, 'versionId': second}], 'different versions remain distinct')
        for wrong in [url + '?', url + '?x=1', url + '#', url + '#section',
                url + '/', url.replace('https:', 'http:'),
                url.replace('agigalaxy.org', 'agigalaxy.org.evil.invalid'),
                url.replace('agigalaxy.org', 'user@agigalaxy.org'),
                url.replace('agigalaxy.org', 'agigalaxy.org:443'),
                url.replace('/posts/', '/%70osts/'), reply_url + '?post=' + post]:
            self.assertEqual(user_public_references(wrong)['items'], [], wrong)
        self.assertEqual(selected_query_reference(url, {'userPublicReferences': both}), ref)
        self.assertIsNone(selected_query_reference(post, {'userPublicReferences': both}))
        self.assertEqual(current_public_references({'userPublicReferences': both}), both['items'])
        self.assertEqual(current_public_references({'userPublicReferences': {**parsed, 'items': [{**reply_ref, 'versionId': first}]}}), [])

        captured = []
        class SurfaceGateway:
            def authorize(self, user_id, operation):
                return {'execution': {'id': conversation, 'mode': 'conversation', 'domain': 'governance', 'sessionId': session}}
        async def inner(scope, receive, send):
            captured.append(parse_qs((await receive())['body'].decode(), keep_blank_values=True))
            await send({'type': 'http.response.start', 'status': 200, 'headers': []})
            await send({'type': 'http.response.body', 'body': b'{}'})
        settings = SimpleNamespace(verification_key='synthetic-canonical-link-key-1234567890',
            service_key='synthetic-never-sent', audience='galaxy-agentos', issuer='galaxy-operations',
            authority_url='https://authority.synthetic.invalid/v1/internal/agentos')
        surface = PrivateSurface(inner, settings, {'gateway': SurfaceGateway(), 'configuredDomains': {'governance'}})
        now = int(time.time())
        token = jwt.encode({'sub': 'conversation:' + conversation, 'iat': now, 'exp': now + 60,
            'iss': settings.issuer, 'aud': settings.audience}, settings.verification_key, algorithm='HS256')
        async def submit():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=surface), base_url='http://synthetic.invalid') as client:
                headers = {'Authorization': 'Bearer ' + token, 'Idempotency-Key': turn}
                data = {'message': message, 'session_id': session, 'background': 'true', 'stream': 'false'}
                self.assertEqual((await client.post('/agents/galaxy-conversation-governance/runs', headers=headers, data=data)).status_code, 200)
                self.assertEqual((await client.post('/agents/galaxy-conversation-governance/runs', headers=headers,
                    data={**data, 'metadata': json.dumps({'userPublicReferences': parsed})})).status_code, 403)
        asyncio.run(submit())
        metadata = json.loads(captured[0]['metadata'][0])
        self.assertEqual(metadata['userPublicReferences'], parsed)
        self.assertEqual(captured[0]['message'], [message])
        calls = []
        changed_version = False
        def transport(request):
            calls.append(json.loads(request.content))
            if changed_version:
                return httpx.Response(409, json={'error': 'operations_agentos_source_changed', 'raw': 'UNSAFE_UPSTREAM_TEXT_MUST_NOT_LEAVE_GATEWAY'})
            return httpx.Response(200, json={'availability': 'available', 'data': {'versionId': first}})
        gateway = GalaxyGateway(settings, transport=httpx.MockTransport(transport))
        self.addCleanup(gateway.close)
        tools = conversation_tools(gateway)
        context = RunContext(run_id=str(uuid4()), user_id='conversation:' + conversation,
            session_id=session, metadata=metadata)
        query = FunctionCall(function=Function.from_callable(tools[0]), call_id='canonical-selected-version')
        tools[0](context, query, module='content', view='list', filters=QueryFilters(query=url, limit=100))
        self.assertEqual(calls[-1]['tool'], 'read-operation-object')
        self.assertEqual(calls[-1]['arguments'], {'kind': 'post', 'id': post})
        self.assertEqual(calls[-1]['publicReference'], ref)
        self.assertEqual(calls[-1]['turnId'], turn)
        tools[0](context, query, module='content', view='list', filters=QueryFilters(targetId=post, limit=100))
        self.assertEqual(calls[-1]['tool'], 'read-operation-object')
        self.assertEqual(calls[-1]['publicReference'], ref, 'targetId cannot bypass a linked version by using the list tool')
        tools[0](context, query, module='content', view='list', filters=QueryFilters(targetId=post, topic='learning', limit=5, days=7))
        self.assertEqual(calls[-1]['tool'], 'query-operations', 'semantic list filters remain intact')

        read = FunctionCall(function=Function.from_callable(tools[1]), call_id='canonical-read')
        tools[1](context, read, kind='post', id=post)
        self.assertEqual(calls[-1]['publicReference'], ref)
        operation = TypeAdapter(PreparedOperation).validate_python({'kind': 'content-curation',
            'targetKind': 'post', 'targetId': post, 'topic': 'learning', 'reason': '本轮明确版本分类核对'})
        prepare = FunctionCall(function=Function.from_callable(tools[-1]), call_id='canonical-prepare')
        tools[-1](context, prepare, operation=operation)
        self.assertEqual(calls[-1]['publicReference'], ref)
        self.assertNotIn('publicReference', calls[-1]['arguments'])
        self.assertNotIn('versionId', calls[-1]['arguments'], 'model does not supply the CAS or source restriction')
        changed_version = True
        changed = json.loads(tools[1](context, read, kind='post', id=post))
        self.assertIsNone(changed['analysisConstraints']['requestedDays'])
        self.assertEqual({key: value for key, value in changed.items() if key != 'analysisConstraints'}, {'state': 'changed', 'reason': 'agentos_public_reference_version_changed',
            'nextStep': 'select-current-version', 'effectState': 'not-confirmed'})
        self.assertNotIn('UNSAFE_', json.dumps(changed))
        changed_version = False
        with self.assertRaises(ValidationError):
            TypeAdapter(PreparedOperation).validate_python({**operation.model_dump(mode='json'), 'publicReference': ref})

        count = len(calls)
        ambiguous = RunContext(run_id=str(uuid4()), user_id=context.user_id, session_id=session,
            metadata={**metadata, 'userPublicReferences': both})
        feedback = json.loads(tools[-1](ambiguous, prepare, operation=operation))
        self.assertEqual(feedback['reason'], 'agentos_public_reference_ambiguous')
        self.assertEqual(len(calls), count, 'different versions cannot be silently selected for a card')
        feedback = json.loads(tools[1](ambiguous, read, kind='post', id=post))
        self.assertEqual(feedback['reason'], 'agentos_public_reference_ambiguous')
        self.assertEqual(len(calls), count)
        feedback = json.loads(tools[0](ambiguous, query, module='content', view='list', filters=QueryFilters(targetId=post)))
        self.assertEqual(feedback['reason'], 'agentos_public_reference_ambiguous')
        self.assertEqual(len(calls), count)
        other = TypeAdapter(PreparedOperation).validate_python({**operation.model_dump(mode='json'), 'targetId': str(uuid4())})
        self.assertEqual(json.loads(tools[-1](context, prepare, operation=other))['reason'], 'agentos_public_reference_mismatch')
        self.assertEqual(len(calls), count)
        incomplete = RunContext(run_id=str(uuid4()), user_id=context.user_id, session_id=session,
            metadata={**metadata, 'userPublicReferences': {**parsed, 'complete': False}})
        self.assertEqual(json.loads(tools[-1](incomplete, prepare, operation=operation))['reason'], 'agentos_public_reference_ambiguous')
        self.assertEqual(len(calls), count)

        reply_context = RunContext(run_id=str(uuid4()), user_id=context.user_id, session_id=session,
            metadata={**metadata, 'userPublicReferences': user_public_references(reply_url)})
        tools[1](reply_context, read, kind='reply', id=reply)
        self.assertEqual(calls[-1]['arguments'], {'kind': 'reply', 'id': reply})
        self.assertEqual(calls[-1]['publicReference'], reply_ref)
        next_turn = RunContext(run_id=str(uuid4()), user_id=context.user_id, session_id=session,
            metadata={**metadata, 'userPublicReferences': user_public_references('这一轮没有给新链接')})
        tools[1](next_turn, read, kind='post', id=post)
        self.assertNotIn('publicReference', calls[-1], 'a later turn cannot inherit earlier link metadata')
        instructions = execute_instructions(agent=Agent(model=OpenAIChat(id='never-called', api_key='synthetic')),
            instructions=reference_aware_instructions(['original-authority']), session_state={}, run_context=context)
        self.assertEqual(instructions[0], 'original-authority')
        self.assertIn('不能转对新版本准备卡', instructions[-1])


if __name__ == '__main__':
    unittest.main()
