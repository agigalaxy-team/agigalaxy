import importlib.util
import json
import os
import sys
import unittest
from uuid import uuid4

from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall
from pydantic import ValidationError
from galaxy_agentos.conversation_tools import RecommendationDirection, conversation_tools


class RecommendationDirectionContract(unittest.TestCase):
    def test_typed_direction_is_the_only_new_preparation_and_keeps_actual22_tools(self):
        calls = []
        class Gateway:
            def conversation_tool(self, user, tool, arguments, **binding):
                calls.append({'tool': tool, 'arguments': arguments, **binding})
                return {'state': 'prepared', 'decision': 'human-confirmation-required'}
        tools = conversation_tools(Gateway())
        spec = importlib.util.spec_from_file_location('galaxy_agentos._recommendation_before', os.environ['GALAXY_RECOMMENDATION_BEFORE'])
        before = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = before
        spec.loader.exec_module(before)
        old_tools = before.conversation_tools(Gateway())
        def exported(fn):
            function = Function.from_callable(fn)
            function.process_entrypoint()
            return function
        functions = [exported(fn) for fn in tools]
        old_functions = [exported(fn) for fn in old_tools]
        self.assertEqual([fn.__name__ for fn in tools], [fn.__name__ for fn in old_tools])
        for index in range(4):
            self.assertEqual(functions[index].parameters, old_functions[index].parameters)
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
        current, old = kinds(functions[4].parameters), kinds(old_functions[4].parameters)
        self.assertEqual(len(old), 18)
        self.assertEqual(set(current) - set(old), {'recommendation-direction'})
        for kind, schema in old.items():
            self.assertEqual(current[kind], schema)
        schema = current['recommendation-direction']
        self.assertEqual(set(schema['properties']), {'kind', 'themeKey', 'direction', 'reason'})
        self.assertFalse(schema['additionalProperties'])
        self.assertEqual(set(schema['required']), set(schema['properties']))
        context = RunContext(run_id=str(uuid4()), user_id='local-recommendation-owner', session_id=str(uuid4()), metadata={'operationId': str(uuid4())})
        for key in ['category:technology', 'tag:'+str(uuid4()), 'theme:'+str(uuid4())]:
            body = {'kind': 'recommendation-direction', 'themeKey': key, 'direction': 'increase', 'reason': '只调整当前主题方向'}
            result = json.loads(tools[4](context, FunctionCall(function=functions[4], call_id='direction-'+str(len(calls))), operation=RecommendationDirection(**body)))
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
        self.assertIn('does not mean ranking is active', tools[4].__doc__)
        self.assertEqual(len(calls), 3)
        print(json.dumps({'actualSdk': True, 'originalPreparedKindsUnchanged': len(old), 'newPreparedKinds': 1,
                          'otherFourToolSchemasEqual': True, 'gateway': 'explicit in-process double', 'providerCalls': 0, 'businessWrites': 0}))
