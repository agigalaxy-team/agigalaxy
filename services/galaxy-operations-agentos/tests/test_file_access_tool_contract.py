"""New eighteenth typed card; actual Agno/Pydantic, explicit Node recorder."""
import json
import unittest
from uuid import uuid4

from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall
from pydantic import TypeAdapter, ValidationError

from galaxy_agentos.conversation_tools import PreparedOperation, conversation_tools


class RecordingNode:
    def __init__(self):
        self.calls=[]

    def conversation_tool(self,user_id,name,arguments,**context):
        self.calls.append((user_id,name,arguments,context))
        return {"state":"prepared","effectExecuted":False}


class FileAccessToolContract(unittest.TestCase):
    def test_file_access_is_explicit_human_preparation_not_scan_delete_or_retention(self):
        schema=TypeAdapter(PreparedOperation)
        self.assertIn("file-access",schema.json_schema()["discriminator"]["mapping"])
        stop={"kind":"file-access","targetKind":"chat","targetId":str(uuid4()),
            "action":"stop","until":1900000000,"reason":"明确合成访问停止原因"}
        restore={"kind":"file-access","targetKind":"forum","targetId":str(uuid4()),
            "action":"restore","reason":"明确合成解除原因"}
        node=RecordingNode();tools=conversation_tools(node)
        context=RunContext(run_id=str(uuid4()),session_id=str(uuid4()),
            user_id="conversation:"+str(uuid4()),metadata={"operationId":str(uuid4())})
        function=Function.from_callable(tools[4])
        for index,value in enumerate([stop,restore,{**restore,"until":None}]):
            operation=schema.validate_python(value)
            call=FunctionCall(function=function,call_id="file-review-"+str(index))
            result=json.loads(tools[4](context,call,operation))
            self.assertEqual(result,{"state":"prepared","effectExecuted":False})
            user,name,arguments,actual_context=node.calls[-1]
            self.assertEqual(name,"prepare-operation")
            self.assertEqual(arguments,{key:item for key,item in value.items() if key!="until" or item is not None})
            self.assertEqual(actual_context,{"run_id":context.run_id,"call_id":call.call_id,
                "session_id":context.session_id,"turn_id":context.metadata["operationId"]})
        bad=[{k:v for k,v in stop.items()if k!="until"},
            {**stop,"until":None},{**stop,"until":True},{**stop,"until":253402300800},
            {**restore,"until":stop["until"]},
            {**stop,"targetKind":"private-url"},{**stop,"action":"delete"},
            {**stop,"expectedVersion":"forged"},{**stop,"expectedRevision":0},
            {**stop,"operationId":str(uuid4())},{**stop,"retentionDays":1},
            {**stop,"scanBypass":True},{**stop,"storageKey":"forged"},
            {**stop,"reason":"x"},{**stop,"reason":"x"*1601}]
        for value in bad:
            with self.assertRaises(ValidationError):schema.validate_python(value)
        self.assertEqual(len(node.calls),3)
        self.assertIn("neither a revoke/delete",tools[4].__doc__)
        self.assertNotIn("run_context",function.parameters["properties"])
        self.assertNotIn("fc",function.parameters["properties"])


if __name__=="__main__":unittest.main(verbosity=2)
