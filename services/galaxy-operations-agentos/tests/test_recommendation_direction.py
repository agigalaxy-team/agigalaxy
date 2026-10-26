import json
import unittest
from uuid import uuid4

from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall
from pydantic import ValidationError
from galaxy_agentos.conversation_tools import RecommendationDirection, conversation_tools


class RecommendationDirectionContract(unittest.TestCase):
    def test_typed_direction_preserves_human_preparation_and_current_context(self):
        calls = []
        class Gateway:
            def conversation_tool(self, user, tool, arguments, **binding):
                calls.append({'tool': tool, 'arguments': arguments, **binding})
                return {'state': 'prepared', 'decision': 'human-confirmation-required'}
        tools = conversation_tools(Gateway())
        def exported(fn):
            function = Function.from_callable(fn)
            function.process_entrypoint()
            return function
        functions = [exported(fn) for fn in tools]
        def kinds(schema):
            found = {}
            def visit(value):
                if isinstance(value, dict):
                    literal = value.get('properties', {}).get('kind', {})
                    name = literal.get('const')
                    if name is None and len(literal.get('enum', [])) == 1:
                        name = literal['enum'][0]
                    if isinstance(name, str):
                        found[name] = value
                    for child in value.values():
                        visit(child)
                elif isinstance(value, list):
                    for child in value:
                        visit(child)
            visit(schema)
            return found
        current = kinds(functions[-1].parameters)
        schema = current['recommendation-direction']
        self.assertEqual(set(schema['properties']), {'kind', 'themeKey', 'direction', 'reason'})
        self.assertFalse(schema['additionalProperties'])
        self.assertEqual(set(schema['required']), set(schema['properties']))
        context = RunContext(run_id=str(uuid4()), user_id='local-recommendation-owner', session_id=str(uuid4()), metadata={'operationId': str(uuid4())})
        for key in ['category:technology', 'tag:'+str(uuid4()), 'theme:'+str(uuid4())]:
            body = {'kind': 'recommendation-direction', 'themeKey': key, 'direction': 'increase', 'reason': '只调整当前主题方向'}
            result = json.loads(tools[-1](context, FunctionCall(function=functions[-1], call_id='direction-'+str(len(calls))), operation=RecommendationDirection(**body)))
            self.assertEqual(result['state'], 'prepared')
            self.assertEqual(calls[-1]['tool'], 'prepare-operation')
            self.assertEqual(calls[-1]['arguments'], body)
            self.assertEqual(calls[-1]['session_id'], context.session_id)
            self.assertEqual(calls[-1]['run_id'], context.run_id)
            self.assertEqual(calls[-1]['turn_id'], context.metadata['operationId'])
            self.assertEqual(len(calls[-1]['arguments']), 4)
        for patch in [{'enabled': True}, {'controls': {}}, {'expectedVersion': 99}, {'operationId': str(uuid4())}, {'themeKey': 'https://foreign.invalid/target'}, {'direction': 'boost'}, {'themeKey': 'category:invented'}]:
            with self.assertRaises(ValidationError):
                RecommendationDirection(**{'kind': 'recommendation-direction', 'themeKey': 'category:technology', 'direction': 'increase', 'reason': '明确业务请求', **patch})
        self.assertIn('does not mean ranking is active', tools[-1].__doc__)
        self.assertEqual(len(calls), 3)
