import json
import unittest
from uuid import uuid4
from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall
from pydantic import TypeAdapter, ValidationError
from galaxy_agentos.conversation_tools import Module, View, ReadKind, QueryFilters, conversation_tools


class QueryCoverageContract(unittest.TestCase):
    def test_closed_new_read_modules_preserve_native_context_and_do_not_add_effect_tools(self):
        class Gateway:
            def __init__(self): self.calls = []
            def conversation_tool(self, user_id, name, arguments, **binding):
                self.calls.append((user_id, name, arguments, binding))
                return {"availability": "available", "data": None}
        gateway = Gateway()
        tools = conversation_tools(gateway)
        self.assertEqual(len(tools), 5, "No new effect or general-routing tool")
        turn, run, session = str(uuid4()), str(uuid4()), str(uuid4())
        context = RunContext(run_id=run, session_id=session, user_id="conversation:"+str(uuid4()), metadata={"operationId":turn})
        values = QueryFilters(page=2, pageSize=20, source="registered", business="not-formed", login="enabled", emailVerified="no", participation="restricted", registeredFrom="2026-10-01T00:00:00Z", registeredTo="2026-10-24T23:59:59Z", sort="registered-desc")
        self.assertEqual(TypeAdapter(Module).validate_python("registered-users"), "registered-users")
        query_call = FunctionCall(function=Function.from_callable(tools[0]), call_id="trusted-registration-call")
        tools[0](context, query_call, module="registered-users", view="list", filters=values)
        packet = gateway.calls[-1]
        self.assertEqual(packet[2], {"module":"registered-users", "view":"list", "filters":values.model_dump(mode="json", exclude_unset=True, exclude_none=True)})
        for index, view in enumerate(["overview", "general", "mail", "service-connections", "advanced"]):
            self.assertEqual(TypeAdapter(View).validate_python(view), view)
            self.assertEqual(TypeAdapter(Module).validate_python("system-settings"), "system-settings")
            call = FunctionCall(function=Function.from_callable(tools[0]), call_id="trusted-system-call-"+str(index))
            tools[0](context, call, module="system-settings", view=view)
        self.assertEqual(TypeAdapter(ReadKind).validate_python("registered-user"), "registered-user")
        read_call = FunctionCall(function=Function.from_callable(tools[1]), call_id="trusted-registration-object")
        object_id = str(uuid4())
        tools[1](context, read_call, kind="registered-user", id=object_id)
        self.assertEqual(gateway.calls[-1][2], {"kind":"registered-user", "id":object_id})
        self.assertEqual(len(gateway.calls), 7)
        for user_id, name, arguments, binding in gateway.calls:
            self.assertEqual(user_id, context.user_id)
            self.assertIn(name, {"query-operations", "read-operation-object"})
            self.assertEqual(binding["run_id"], run)
            self.assertEqual(binding["session_id"], session)
            self.assertEqual(binding["turn_id"], turn)
            self.assertTrue(binding["call_id"].startswith("trusted-"))
            self.assertNotIn("role", arguments)
            self.assertNotIn("operatorId", arguments)
        for invalid in ["credentials", "runtime-env", "identity-admin"]:
            with self.assertRaises(ValidationError): TypeAdapter(Module).validate_python(invalid)
        for invalid in ["password-reset", "system-settings-apply"]:
            with self.assertRaises(ValidationError): TypeAdapter(ReadKind).validate_python(invalid)
        for invalid in [{"pageSize":40}, {"credentialRef":"system-key:private"}, {"rawPath":"/private"}]:
            with self.assertRaises(ValidationError): QueryFilters.model_validate(invalid)
        schema = json.dumps(Function.from_callable(tools[0]).parameters)
        self.assertIn("registered-users", schema)
        self.assertIn("system-settings", schema)
        self.assertIn("registeredFrom", schema)
        self.assertNotIn("credentialRef", schema)


if __name__ == "__main__": unittest.main()
