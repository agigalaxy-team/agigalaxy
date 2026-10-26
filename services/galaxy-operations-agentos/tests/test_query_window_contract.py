"""One query-window Agno SDK leaf; explicit fresh gateway double, no model."""
import json
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
        gateway = Gateway()
        tools = conversation_tools(gateway, domain="discovery")
        fn, function = tools[0], exported(tools[0])
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
        count = len(gateway.calls)
        omitted = call("recommendations", "overview", {}, "missing-window")
        self.assertEqual(omitted["state"], "invalid-request")
        self.assertEqual(omitted["reason"], "agentos_query_window_required")
        self.assertEqual(len(gateway.calls), count)
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
            self.assertEqual(result["allowedDays"], _QUERY_FILTER_CONTRACTS[(module, view)]["allowedDays"])
            self.assertNotIn("PRIVATE_MARKER", json.dumps(result))
            self.assertEqual(len(gateway.calls), count)

        # A clearer schema is not an authorization cache: valid reads still
        # enter the original bound gateway and propagate its current denial.
        gateway.allowed = False
        with self.assertRaises(AuthorityDenied):
            call("recommendations", "overview", {"days": 7}, "fresh-denial")
        self.assertEqual(gateway.calls[-1]["call_id"], "fresh-denial")



if __name__ == "__main__":
    unittest.main()
