"""One actual Agno SDK leaf, explicit in-process gateway, no model or data."""
from dataclasses import dataclass
import json
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from agno.db.sqlite import SqliteDb
from agno.models.base import Model
from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall

from galaxy_agentos.conversation_tools import conversation_tools
from galaxy_agentos.conversations import conversation_agents
from galaxy_agentos.gateway import AuthorityDenied


@dataclass
class NoModel(Model):
    id: str = 'local-schema-only'
    name: str = 'NoProvider'
    provider: str = 'NoNetwork'

    def invoke(self, *args, **kwargs): raise AssertionError('model invocation forbidden')
    async def ainvoke(self, *args, **kwargs): raise AssertionError('model invocation forbidden')
    def invoke_stream(self, *args, **kwargs): raise AssertionError('model invocation forbidden')
    async def ainvoke_stream(self, *args, **kwargs): raise AssertionError('model invocation forbidden')
    def _parse_provider_response(self, response, **kwargs): return response
    def _parse_provider_response_delta(self, response): return response


class Gateway:
    def __init__(self):
        self.calls = []
        self.allowed = True

    def conversation_tool(self, user, tool, arguments, **binding):
        self.calls.append({'user': user, 'tool': tool, 'arguments': arguments, **binding})
        if not self.allowed:
            raise AuthorityDenied('explicit-current-denial')
        return {'state': 'prepared' if tool == 'prepare-operation' else 'available'}


class FixedDomainPreparationContract(unittest.TestCase):
    def test_all_domains_share_real_schemas_and_fresh_gateway_checks(self):
        labels = dict.fromkeys(['overview', 'governance', 'messaging', 'discovery', 'maintenance'], 'local role')
        gateway = Gateway()
        with tempfile.TemporaryDirectory() as directory:
            db = SqliteDb(db_file=str(Path(directory) / 'unused.db'))
            try:
                agents = conversation_agents(settings=None, db=db, gateway=gateway,
                    domains=labels, active_domains=frozenset(labels), model_factory=NoModel)
                schemas = []
                for domain, agent in zip(labels, agents):
                    functions = agent.tools
                    self.assertEqual([fn.name for fn in functions], ['current_summary', 'query_operations',
                        'read_operation_object', 'list_authorized_work', 'run_authorized_work',
                        'read_task_operation', 'read_ai_delegation', 'plan_turn', 'assess_turn', 'prepare_operation'])
                    self.assertEqual(functions[0].parameters['properties'], {})
                    schemas.append(functions[-1].parameters)
                    context = RunContext(run_id=str(uuid4()), user_id='conversation:'+str(uuid4()),
                        session_id=str(uuid4()), metadata={'operationId':str(uuid4())})
                    fn = functions[-1]; fn._run_context = context
                    body = {'kind':'feedback-update', 'targetId':str(uuid4()), 'state':'processing'}
                    call = FunctionCall(function=fn, call_id='domain-'+domain, arguments={'operation':body})
                    call.execute()
                    self.assertEqual(json.loads(call.result)['state'], 'prepared')
                    self.assertEqual(gateway.calls[-1]['arguments'], body)
                    self.assertEqual(gateway.calls[-1]['turn_id'], context.metadata['operationId'])
                self.assertTrue(all(schema == schemas[0] for schema in schemas))
                gateway.allowed = False
                call = FunctionCall(function=fn, call_id='fresh-denial', arguments={'operation':body})
                call.execute()
                self.assertEqual(json.loads(call.result)['state'], 'denied')
                self.assertFalse(json.loads(call.result)['effectExecuted'])
                for invalid in ['', 'unknown', [], {}, 1]:
                    with self.assertRaises(ValueError):
                        conversation_tools(gateway, domain=invalid)
            finally:
                db.db_engine.dispose()


if __name__ == '__main__':
    unittest.main()
