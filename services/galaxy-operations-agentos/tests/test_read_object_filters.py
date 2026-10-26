import json
import unittest
from uuid import uuid4

from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall
from pydantic import ValidationError
from galaxy_agentos.conversation_tools import AccountSummaryReadFilters, QueryFilters, conversation_tools


class ReadObjectFilters(unittest.TestCase):
    def test_actual_dynamic_read_and_exported_schema_match_current_node_contract(self):
        calls = []
        class Gateway:
            def conversation_tool(self, user, tool, arguments, **binding):
                calls.append({'tool': tool, 'arguments': arguments, **binding})
                return {'availability': 'available', 'data': {'source': 'local explicit transport double'}}
        tools = conversation_tools(Gateway())
        self.assertEqual([fn.__name__ for fn in tools], ['query_operations', 'read_operation_object', 'list_authorized_work', 'run_authorized_work', 'read_ai_delegation', 'prepare_operation'])
        def exported(fn):
            f = Function.from_callable(fn)
            f.process_entrypoint()
            return f
        functions = [exported(fn) for fn in tools]
        schema = functions[1].parameters
        encoded = json.dumps(schema, ensure_ascii=False, separators=(',', ':'))
        self.assertNotIn('QueryFilters', encoded)
        filters = schema.get('$defs', {}).get('AccountSummaryReadFilters')
        if filters is None:
            choices = schema['properties']['filters'].get('anyOf', [schema['properties']['filters']])
            filters = next(item for item in choices if item.get('type') == 'object')
        self.assertEqual(set(filters['properties']), {'days'})
        self.assertFalse(filters['additionalProperties'])
        day = filters['properties']['days']
        choices = day.get('anyOf', [day])
        integer = next(item for item in choices if item.get('type') == 'integer')
        self.assertEqual(integer['enum'], [7, 28])
        for invalid in [1, 90, '7', 7.0, True]:
            with self.assertRaises(ValidationError):
                AccountSummaryReadFilters(days=invalid)
        with self.assertRaises(ValidationError):
            AccountSummaryReadFilters(query='not a read filter')
        context = RunContext(run_id=str(uuid4()), user_id='local-read-contract', session_id=str(uuid4()), metadata={'operationId': str(uuid4())})
        read = tools[1]
        def invoke(kind, filters):
            return json.loads(read(context, FunctionCall(function=functions[1], call_id='read-filters-'+str(len(calls))), kind=kind, id=str(uuid4()), filters=filters))
        for filters, expected in [(None, None), (AccountSummaryReadFilters(), {}), (AccountSummaryReadFilters(days=None), {}), (AccountSummaryReadFilters(days=7), {'days': 7}), (AccountSummaryReadFilters(days=28), {'days': 28})]:
            invoke('account-summary', filters)
            if expected is None:
                self.assertNotIn('filters', calls[-1]['arguments'])
            else:
                self.assertEqual(calls[-1]['arguments']['filters'], expected)
            self.assertEqual(calls[-1]['turn_id'], context.metadata['operationId'])
            self.assertEqual(calls[-1]['session_id'], context.session_id)
            self.assertEqual(calls[-1]['run_id'], context.run_id)
        invoke('feedback', AccountSummaryReadFilters())
        self.assertEqual(calls[-1]['arguments']['filters'], {})
        count = len(calls)
        invalid = invoke('feedback', AccountSummaryReadFilters(days=7))
        self.assertEqual(len(calls), count)
        self.assertEqual(invalid['reason'], 'agentos_tool_arguments_invalid')
        self.assertEqual(invalid['allowedFilters'], [])
        self.assertFalse(invalid['effectExecuted'])
        self.assertTrue(all(item['tool'] == 'read-operation-object' for item in calls))
