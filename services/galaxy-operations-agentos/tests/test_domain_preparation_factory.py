"""One actual Agno SDK leaf, explicit in-process gateway, no model or data."""
import ast
from dataclasses import dataclass
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import typing
import unittest
from uuid import uuid4

from agno.db.sqlite import SqliteDb
from agno.models.base import Model
from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall
from pydantic import TypeAdapter, ValidationError

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


def exported(fn):
    value = Function.from_callable(fn)
    value.process_entrypoint()
    return value


def kind_schemas(schema):
    result = {}
    def visit(value):
        if isinstance(value, dict):
            field = value.get('properties', {}).get('kind', {})
            kind = field.get('const')
            if kind is None and len(field.get('enum', [])) == 1:
                kind = field['enum'][0]
            if isinstance(kind, str):
                result[kind] = value
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    visit(schema)
    return result


def size(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode())


class FixedDomainPreparationContract(unittest.TestCase):
    def test_actual_factory_schema_fields_isolation_and_bound_function_calls(self):
        before_tools_path = Path(os.environ['GALAXY_PREPARE_BEFORE_SOURCE'])
        expected = json.loads(os.environ['GALAXY_PREPARE_EXPECTED_DOMAINS'])
        spec = importlib.util.spec_from_file_location('galaxy_agentos._before_fixed_domain', before_tools_path)
        before = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = before
        spec.loader.exec_module(before)
        gateway = Gateway()
        old_tools = before.conversation_tools(gateway)
        old = [exported(fn) for fn in old_tools]
        original_kinds = kind_schemas(old[-1].parameters)
        self.assertEqual(len(original_kinds), 19)
        self.assertEqual(set(expected), {'overview', 'governance', 'messaging', 'discovery', 'maintenance'})

        # The Agent integration may change only this one factory argument;
        # instructions, history, model/hook/storage wiring remain identical.
        before_agents = ast.parse(before_tools_path.with_name('conversations.py').read_text(encoding='utf-8'))
        import galaxy_agentos.conversations as agents_module
        candidate_agents = ast.parse(Path(agents_module.__file__).read_text(encoding='utf-8'))
        factory_calls = [node for node in ast.walk(candidate_agents) if isinstance(node, ast.Call)
                         and isinstance(node.func, ast.Name) and node.func.id == 'conversation_tools']
        self.assertEqual(len(factory_calls), 1)
        self.assertEqual([(item.arg, ast.dump(item.value)) for item in factory_calls[0].keywords], [('domain', "Name(id='domain', ctx=Load())")])
        factory_calls[0].keywords = []
        self.assertEqual(ast.dump(candidate_agents, include_attributes=False), ast.dump(before_agents, include_attributes=False))

        labels = dict.fromkeys(expected, '本地固定岗位')
        measured = {}
        prepared = {}
        with tempfile.TemporaryDirectory(prefix='galaxy-domain-sdk-') as directory:
            agents = conversation_agents(settings=None, db=SqliteDb(db_file=str(Path(directory) / 'unused.db')),
                gateway=gateway, domains=labels, active_domains=frozenset(labels), model_factory=NoModel)
            self.assertEqual(len(agents), 5)
            for domain, agent in zip(labels, agents):
                tools = agent.tools
                self.assertEqual([fn.__name__ for fn in tools], ['current_summary', *[fn.__name__ for fn in old_tools]])
                functions = [exported(fn) for fn in tools]
                for index in range(5):
                    self.assertEqual(tools[index + 1].__doc__, old_tools[index].__doc__)
                for index in range(4):
                    self.assertEqual(functions[index + 1].parameters, old[index].parameters)
                self.assertEqual(functions[0].parameters.get('properties'), {})
                current = kind_schemas(functions[-1].parameters)
                self.assertEqual(set(current), set(expected[domain]))
                for kind in current:
                    self.assertEqual(current[kind], original_kinds[kind])
                if domain == 'overview':
                    self.assertEqual(functions[-1].parameters, old[-1].parameters)
                prepared[domain] = (tools[-1], functions[-1])
                measured[domain] = {'kinds': list(expected[domain]), 'kindCount': len(current),
                    'prepareParametersBytes': size(functions[-1].parameters),
                    'allSixParametersBytes': sum(size(fn.parameters) for fn in functions),
                    'otherFiveSchemasEqual': True, 'preservedKindFieldsEqual': True}

            # Keep the instances alive across interleaved domain construction;
            # no shared annotation or global PreparedOperation may be mutated.
            for domain, (tool, function) in reversed(list(prepared.items())):
                self.assertEqual(exported(tool).parameters, function.parameters)
                self.assertEqual(set(kind_schemas(function.parameters)), set(expected[domain]))
            self.assertEqual(exported(conversation_tools(gateway)[-1]).parameters, old[-1].parameters)
            for invalid in ['', 'unknown', [], {}, 1]:
                with self.assertRaises(ValueError):
                    conversation_tools(gateway, domain=invalid)

            ident = str(uuid4())
            examples = {
                'overview': {'kind': 'rule-publish', 'key': 'forum-quota', 'reason': '本地参数核对'},
                'governance': {'kind': 'content-curation', 'targetKind': 'post', 'targetId': ident, 'topic': None, 'reason': '清除覆盖保留空值'},
                'messaging': {'kind': 'messaging-state', 'targetId': ident, 'action': 'pause'},
                'discovery': {'kind': 'recommendation-direction', 'themeKey': 'category:technology', 'direction': 'keep', 'reason': '本地单方向核对'},
                'maintenance': {'kind': 'file-access', 'targetKind': 'forum', 'targetId': ident, 'action': 'stop', 'until': 1900000000, 'reason': '明确本地期限'},
            }
            context = RunContext(run_id=str(uuid4()), user_id='isolated-domain-owner', session_id=str(uuid4()), metadata={'operationId': str(uuid4())})
            for domain, body in examples.items():
                tool, function = prepared[domain]
                argument_type = tool.__annotations__['operation']
                operation = TypeAdapter(argument_type).validate_python(body)
                call = FunctionCall(function=function, call_id='domain-' + domain, arguments={'operation': body})
                result = json.loads(tool(context, call, operation=operation))
                self.assertEqual(result['state'], 'prepared')
                self.assertEqual(gateway.calls[-1], {'user': context.user_id, 'tool': 'prepare-operation',
                    'arguments': body, 'run_id': context.run_id, 'call_id': call.call_id,
                    'session_id': context.session_id, 'turn_id': context.metadata['operationId']})
                for kind in set(original_kinds) - set(expected[domain]):
                    with self.assertRaises(ValidationError):
                        TypeAdapter(argument_type).validate_python({'kind': kind})

            # A fixed type is not an authorization cache: every real transport
            # invocation still reaches the current gateway and its fresh denial.
            gateway.allowed = False
            tool, function = prepared['discovery']
            value = TypeAdapter(tool.__annotations__['operation']).validate_python(examples['discovery'])
            with self.assertRaises(AuthorityDenied):
                tool(context, FunctionCall(function=function, call_id='fresh-current-denial'), operation=value)
            self.assertEqual(gateway.calls[-1]['call_id'], 'fresh-current-denial')

        self.assertEqual(len(gateway.calls), 6)
        print(json.dumps({'newUniqueLeaf': 1, 'actualAgnoSdk': True,
            'baseline': {'prepareKindCount': len(original_kinds), 'prepareParametersBytes': size(old[-1].parameters),
                'allFiveParametersBytes': sum(size(fn.parameters) for fn in old)},
            'domains': measured, 'toolAndQueryNamesPreserved': True, 'instructionsAndAgentWiringUnchanged': True,
            'globalAndPerDomainInstancesIsolated': True, 'gatewayDoubleCalls': len(gateway.calls),
            'currentDenialPropagates': True, 'providerCalls': 0, 'businessWrites': 0,
            'wireOrTokenMeasurement': False}, ensure_ascii=False))


if __name__ == '__main__':
    unittest.main()
