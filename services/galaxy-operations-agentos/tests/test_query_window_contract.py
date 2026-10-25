"""One query-window Agno SDK leaf; explicit fresh gateway double, no model."""
import ast
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from uuid import uuid4

from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall
from pydantic import TypeAdapter
from galaxy_agentos.conversation_tools import conversation_tools, _QUERY_FILTER_CONTRACTS
from galaxy_agentos.gateway import AuthorityDenied


class Gateway:
    def __init__(self):
        self.calls = []
        self.allowed = True

    def conversation_tool(self, user, tool, arguments, **binding):
        self.calls.append({"user": user, "tool": tool, "arguments": arguments, **binding})
        if not self.allowed:
            raise AuthorityDenied("explicit-fresh-query-denial")
        return {"state": "available", "data": {"period": {"days": arguments.get("filters", {}).get("days", 30)}}}


def exported(fn):
    value = Function.from_callable(fn)
    value.process_entrypoint()
    return value


class QueryWindowContract(unittest.TestCase):
    def test_actual_exported_schema_bound_calls_and_node_filter_contract(self):
        before_path = Path(os.environ["GALAXY_QUERY_BEFORE_SOURCE"])
        expected = json.loads(os.environ["GALAXY_QUERY_NODE_CONTRACT"])["contracts"]
        spec = importlib.util.spec_from_file_location("galaxy_agentos._before_query_windows", before_path)
        before = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = before
        spec.loader.exec_module(before)
        gateway = Gateway()
        old_tools = before.conversation_tools(gateway, domain="discovery")
        tools = conversation_tools(gateway, domain="discovery")
        self.assertEqual([fn.__name__ for fn in tools], [fn.__name__ for fn in old_tools])
        self.assertEqual(len(tools), 5)
        for old, current in zip(old_tools[1:], tools[1:]):
            self.assertEqual(exported(current).parameters, exported(old).parameters)
        fn, function = tools[0], exported(tools[0])
        serialized = json.dumps(function.parameters, ensure_ascii=False)
        self.assertIn("recommendations/overview accepts 7,30,90 (default 30)", serialized)
        self.assertIn("content/list accepts 7,28,all (default 7)", serialized)
        self.assertIn("one mixed page", serialized)
        self.assertIn("server cap 20", fn.__doc__)
        for route, actual in _QUERY_FILTER_CONTRACTS.items():
            node = expected["/".join(route)]
            self.assertEqual(set(actual["allowedFilters"]), set(node["allowedFilters"]))
            self.assertEqual(actual["allowedDays"], node["allowedDays"])
            self.assertEqual(actual["defaultDays"], node["defaultDays"])
            if "allowedKinds" in node:
                self.assertEqual(actual["allowedKinds"], node["allowedKinds"])

        # Only the one data-window instruction is added. Model/config/history/
        # authority and factory/domain wiring are byte-equivalent as AST.
        old_agent = ast.parse(before_path.with_name("conversations.py").read_text(encoding="utf-8"))
        import galaxy_agentos.conversations as agents
        current_agent = ast.parse(Path(agents.__file__).read_text(encoding="utf-8"))
        added = []
        for node in ast.walk(current_agent):
            if isinstance(node, ast.List):
                found = [value for value in node.elts if isinstance(value, ast.Constant)
                         and isinstance(value.value, str) and value.value.startswith("用户指定时间范围或分别要多个视图/内容类型时")]
                for value in found:
                    added.append(value.value)
                    node.elts.remove(value)
        self.assertEqual(len(added), 1)
        self.assertIn("未尝试不能说接口没有取得", added[0])
        self.assertIn("不能只替换时区标签", added[0])
        self.assertEqual(ast.dump(current_agent, include_attributes=False), ast.dump(old_agent, include_attributes=False))

        context = RunContext(run_id=str(uuid4()), user_id="isolated-query-owner", session_id=str(uuid4()),
                             metadata={"operationId": str(uuid4())})
        adapter = TypeAdapter(fn.__annotations__["filters"])
        def call(module, view, filters, ident):
            value = adapter.validate_python(filters) if filters is not None else None
            fc = FunctionCall(function=function, call_id=ident, arguments={"module": module, "view": view, "filters": filters})
            return json.loads(fn(context, fc, module=module, view=view, filters=value))

        valid = [
            ("recommendations", "overview", {"days": 7}),
            ("analytics", "overview", {"days": 7}),
            ("content", "list", {"kind": "post", "days": 7, "limit": 20, "visibility": "visible"}),
            ("content", "list", {"kind": "reply", "days": 7, "limit": 20, "visibility": "visible"}),
        ]
        for index, (module, view, filters) in enumerate(valid):
            result = call(module, view, filters, "valid-" + str(index))
            self.assertEqual(result["state"], "available")
            recorded = gateway.calls[-1]
            self.assertEqual(recorded, {"user": context.user_id, "tool": "query-operations",
                "arguments": {"module": module, "view": view, "filters": filters},
                "run_id": context.run_id, "call_id": "valid-" + str(index),
                "session_id": context.session_id, "turn_id": context.metadata["operationId"]})

        # Omission remains omission, not a hidden rewrite of the user's window.
        call("recommendations", "overview", {}, "documented-default")
        self.assertEqual(gateway.calls[-1]["arguments"]["filters"], {})
        count = len(gateway.calls)
        for module, view, filters in [
            ("recommendations", "overview", {"days": 28}),
            ("recommendations", "overview", {"state": "PRIVATE_MARKER"}),
            ("search", "overview", {"days": 28}),
            ("content", "list", {"days": 30}),
            ("content", "list", {"kind": "all"}),
        ]:
            result = call(module, view, filters, "invalid-filter")
            self.assertEqual(result["state"], "invalid-request")
            self.assertFalse(result["effectExecuted"])
            self.assertEqual(result["allowedDays"], expected[module + "/" + view]["allowedDays"])
            self.assertNotIn("PRIVATE_MARKER", json.dumps(result))
            self.assertEqual(len(gateway.calls), count)

        # A clearer schema is not an authorization cache: valid reads still
        # enter the original bound gateway and propagate its current denial.
        gateway.allowed = False
        with self.assertRaises(AuthorityDenied):
            call("recommendations", "overview", {"days": 7}, "fresh-denial")
        self.assertEqual(gateway.calls[-1]["call_id"], "fresh-denial")
        print(json.dumps({"newUniqueLeaf": 1, "actualAgnoSdk": True,
            "nodeContractsMatch": True, "requestedWindowsForwarded": True,
            "twoKindSamplesForwardedIndependently": True, "omittedDefaultsNotRewritten": True,
            "invalidArgumentsNoGatewayCall": True, "freshDenialPreserved": True,
            "gatewayDoubleCalls": len(gateway.calls), "providerCalls": 0, "businessWrites": 0,
            "modelPlanningQualityProven": False}, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
