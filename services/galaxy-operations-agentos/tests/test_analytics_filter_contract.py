"""New filter guidance after a real unsupported-date query; no model/network."""
import json
import unittest
from uuid import uuid4

from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall

from galaxy_agentos.conversation_tools import QueryFilters, conversation_tools


class RecordingNode:
    def __init__(self):
        self.calls = []

    def conversation_tool(self, user_id, name, arguments, **context):
        self.calls.append((user_id, name, arguments, context))
        return {"state": "available", "effectExecuted": False}


class AnalyticsFilterContract(unittest.TestCase):
    def test_fixed_query_contract_does_not_retry_calendar_dates_as_business_reads(self):
        node = RecordingNode()
        tools = conversation_tools(node)
        context = RunContext(run_id=str(uuid4()), session_id=str(uuid4()),
            user_id="conversation:" + str(uuid4()), metadata={"operationId": str(uuid4())})
        query, read = tools[:2]
        qcall = FunctionCall(function=Function.from_callable(query), call_id="date-filter-query")
        rcall = FunctionCall(function=Function.from_callable(read), call_id="date-filter-read")
        account = str(uuid4())
        invalid = [
            ("paths", {"day": "2026-10-23", "scope": "accounts", "accountId": account}),
            ("paths", {"accountId": account}),
            ("overview", {"accountId": account}),
            ("business", {"days": "all"}),
            ("account", {}),
            ("account", {"accountId": account, "scope": "accounts"}),
        ]
        for view, filters in invalid:
            result = json.loads(query(context, qcall, "analytics", view, QueryFilters(**filters)))
            self.assertEqual(result["state"], "invalid-request")
            self.assertFalse(result.get("calendarDateSupported", False))
            self.assertFalse(result["effectExecuted"])
            self.assertTrue("allowedFilters" in result or result.get("windowRequired") is True)
        for kind, filters in [("account-summary", {"day": "2026-10-23"}),
                ("account-summary", {"days": 1}), ("account", {"days": 7})]:
            result = json.loads(read(context, rcall, kind, account, QueryFilters(**filters)))
            self.assertEqual(result["state"], "invalid-request")
            self.assertEqual(result["allowedDays"], [7, 28] if kind == "account-summary" else [])
        self.assertEqual(node.calls, [])
        query(context, qcall, "analytics", "paths", QueryFilters(days=7, scope="accounts", accountId=account))
        query(context, qcall, "analytics", "account", QueryFilters(accountId=account, days=7))
        read(context, rcall, "account-summary", account, QueryFilters(days=28))
        self.assertEqual(len(node.calls), 3)
        self.assertEqual(node.calls[0][2]["filters"], {"days": 7, "scope": "accounts", "accountId": account})
        self.assertEqual(node.calls[2][2], {"kind": "account-summary", "id": account, "filters": {"days": 28}})
        for _, _, _, forwarded in node.calls:
            self.assertEqual(forwarded["run_id"], context.run_id)
            self.assertEqual(forwarded["session_id"], context.session_id)
            self.assertEqual(forwarded["turn_id"], context.metadata["operationId"])
        # The legitimate audit day remains available, rather than removing the
        # shared field from every fixed module to hide the analytics mismatch.
        query(context, qcall, "audit", "list", QueryFilters(day="2026-10-23"))
        self.assertEqual(node.calls[-1][2]["filters"], {"day": "2026-10-23"})
        self.assertIn("not silently substitute", query.__doc__)
        self.assertIn("lifetime metrics", read.__doc__)


if __name__ == "__main__":
    unittest.main(verbosity=2)
