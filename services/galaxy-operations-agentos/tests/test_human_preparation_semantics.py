import json
import unittest
from uuid import uuid4
from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall
from pydantic import TypeAdapter, ValidationError
from galaxy_agentos.conversation_tools import ContentCuration, PreparedOperation, conversation_tools

class HumanPreparationSemantics(unittest.TestCase):
    def test_empty_automatic_work_does_not_remove_human_preparation_or_explicit_null(self):
        calls=[]
        available={'items':[],'basis':{'scope':'owned-explicit-authorized-work','complete':True,'availability':'available'},'humanPreparation':{'tool':'prepare-operation','availableKinds':['content-curation'],'requiresAuthorizedExecution':False,'requiresHumanConfirmation':True,'objectEligibility':'checked-when-preparing'}}
        class Gateway:
            def conversation_tool(self,user_id,tool,arguments,**binding):
                calls.append({'user':user_id,'tool':tool,'arguments':arguments,**binding})
                return available if tool=='list-authorized-work' else {'state':'prepared','card':{'kind':'content-curation','requiredAction':'content.curate'}}
        tools=conversation_tools(Gateway());listing,prepare=tools[2],tools[-1]
        schema=ContentCuration.model_json_schema()['properties']['topic']
        self.assertIn('Explicit topic=null clears',schema['description'])
        self.assertIn('Omit topic',schema['description'])
        self.assertIn('originalTopic',schema['description'])
        function=Function.from_callable(prepare)
        # Check the actual Agno-exposed tool schema, not only model metadata.
        function.process_entrypoint()
        wire_schema=json.dumps(function.parameters,ensure_ascii=False)
        self.assertIn('Explicit topic=null clears',wire_schema)
        self.assertIn('not require a pre-existing execution',prepare.__doc__)
        self.assertIn('not the set of actions',listing.__doc__)
        context=RunContext(run_id=str(uuid4()),user_id='conversation:'+str(uuid4()),session_id=str(uuid4()),metadata={'operationId':str(uuid4()),'userPublicReferences':{'items':[],'complete':True}})
        listed=json.loads(listing(context,FunctionCall(function=Function.from_callable(listing),call_id='empty-directory')))
        self.assertEqual(listed,available)
        post=str(uuid4());base={'kind':'content-curation','targetKind':'post','targetId':post,'reason':'清除本次运营分类覆盖'}
        value=TypeAdapter(PreparedOperation).validate_python({**base,'topic':None})
        prepared=json.loads(prepare(context,FunctionCall(function=function,call_id='clear-only-category'),operation=value))
        self.assertEqual(prepared['state'],'prepared')
        self.assertEqual(calls[-1]['tool'],'prepare-operation')
        self.assertEqual(calls[-1]['arguments'],{**base,'topic':None})
        self.assertEqual(calls[-1]['turn_id'],context.metadata['operationId'])
        self.assertEqual(calls[-1]['run_id'],context.run_id)
        self.assertEqual(calls[-1]['session_id'],context.session_id)
        self.assertEqual(calls[-1]['call_id'],'clear-only-category')
        keep=TypeAdapter(PreparedOperation).validate_python({**base,'pinned':False})
        prepare(context,FunctionCall(function=function,call_id='keep-category'),operation=keep)
        self.assertNotIn('topic',calls[-1]['arguments'],'omission is not converted into a clearing intent')
        self.assertEqual(calls[-1]['arguments']['pinned'],False)
        with self.assertRaises(ValidationError):TypeAdapter(PreparedOperation).validate_python(base)
        self.assertEqual([x['tool']for x in calls],['list-authorized-work','prepare-operation','prepare-operation'])
        self.assertTrue(all(x['tool']!='run-authorized-work'for x in calls))
