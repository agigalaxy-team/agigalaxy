"""Provider tool registration and per-run domain discovery contracts."""
import json
import unittest
from uuid import uuid4

from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall
from pydantic import TypeAdapter

from galaxy_agentos.conversation_tool_contracts import PreparedOperation
from galaxy_agentos.conversation_tools import conversation_tools, preparation_tool_catalog, preparation_tools
from galaxy_agentos.conversation_turn_state import turn_state


class Gateway:
    def __init__(self):
        self.calls = []

    def conversation_tool(self, user, tool, arguments, **binding):
        self.calls.append((user, tool, arguments, binding))
        return {'state': 'prepared', 'card': {'state': 'prepared', 'cardId': str(uuid4())}}


class DomainPreparationContract(unittest.TestCase):
    def test_catalog_covers_original_union_and_registered_schemas(self):
        catalog = preparation_tool_catalog()
        expected = set(TypeAdapter(PreparedOperation).json_schema()['discriminator']['mapping'])
        kinds = [kind for entry in catalog.values() for kind in entry['kinds']]
        self.assertEqual(set(kinds), expected)
        self.assertEqual(len(kinds), len(set(kinds)))
        registered = preparation_tools(Gateway())
        self.assertEqual({fn.__name__ for fn in registered}, {name for entry in catalog.values() for name in entry['tools']})
        for fn in registered:
            native = Function.from_callable(fn)
            native.process_entrypoint()
            entry = next(entry for entry in catalog.values() if fn.__name__ in entry['tools'])
            schema = json.dumps(native.parameters)
            for kind in entry['kinds']:
                self.assertIn(json.dumps(kind), schema)
            self.assertNotIn('run_context', native.parameters['properties'])
            self.assertNotIn('fc', native.parameters['properties'])

    def test_discovery_is_per_run_and_does_not_call_gateway(self):
        gateway = Gateway()
        tools = conversation_tools(gateway)
        self.assertEqual([fn.__name__ for fn in tools[:2]], ['query_operations', 'read_operation_object'])
        self.assertNotIn('prepare_operation', [fn.__name__ for fn in tools])
        load = next(fn for fn in tools if fn.__name__ == 'load_business_tools')
        context = RunContext(run_id=str(uuid4()), user_id='conversation:' + str(uuid4()),
            session_id=str(uuid4()), metadata={'operationId': str(uuid4())})
        call = FunctionCall(function=Function.from_callable(load), call_id='load-domains')
        result = json.loads(load(context, call, domains=['analytics', 'feedback_accounts']))
        self.assertEqual(result['loadedDomains'], ['analytics', 'feedback_accounts'])
        self.assertEqual(result['tools'], ['prepare_feedback_accounts_operation'])
        self.assertIn('analytics', result['readGuidance'])
        self.assertEqual(turn_state(context)['loadedBusinessDomains'], result['loadedDomains'])
        self.assertEqual(gateway.calls, [])
        self.assertEqual(preparation_tools(gateway, domains=['analytics']), [])
        with self.assertRaises(ValueError):
            preparation_tools(gateway, domains=['unknown'])

    def test_preparation_preserves_bound_call_and_operation(self):
        gateway = Gateway()
        prepare = preparation_tools(gateway, domains=['feedback_accounts'])[0]
        native = Function.from_callable(prepare)
        native.process_entrypoint()
        context = RunContext(run_id=str(uuid4()), user_id='conversation:' + str(uuid4()),
            session_id=str(uuid4()), metadata={'operationId': str(uuid4())})
        native._run_context = context
        body = {'kind': 'feedback-update', 'targetId': str(uuid4()), 'state': 'processing'}
        call = FunctionCall(function=native, call_id='original-call', arguments={'operation': body})
        self.assertTrue(call.execute())
        self.assertTrue(json.loads(call.result)['preparationFeedback']['cardPrepared'])
        self.assertEqual(gateway.calls[-1][1:3], ('prepare-operation', body))
        self.assertEqual(gateway.calls[-1][3]['turn_id'], context.metadata['operationId'])


if __name__ == '__main__':
    unittest.main()
