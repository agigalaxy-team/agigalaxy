import unittest
from copy import deepcopy
from types import SimpleNamespace
from uuid import uuid4

from agno.run.status_persist import RunPersistOutcome
from galaxy_agentos.duty_storage import duty_database


class DutyFinalReport(unittest.TestCase):
    def setUp(self):
        task, run, session = str(uuid4()), str(uuid4()), str(uuid4())
        self.fields = {'run_id':run, 'session_id':session, 'agent_id':'galaxy-duty', 'user_id':'autonomy:'+task,
            'status':'COMPLETED', 'content':'最终处理完成', 'reasoning_content':'PRIVATE_REASONING',
            'metadata':{'taskId':task, 'operationId':task, 'planId':str(uuid4()), 'planVersion':1,
                'promptVersion':1, 'domain':'overview', 'aiAccountId':str(uuid4()), 'modelSettingsVersion':'v1'}}
        self.reports = []
        self.gateway = SimpleNamespace(duty_report=lambda user, data: self.reports.append((user, data)))
        class Db:
            id = 'isolated-double'
            outcome = RunPersistOutcome.UPDATED
            row = None
            stored = None
            def update_run_in_session(self, *args, fields, **kwargs):
                self.stored = deepcopy(fields)
                if self.outcome == RunPersistOutcome.UPDATED:
                    self.row = {'run_id':args[1], 'session_id':args[0], 'agent_id':'galaxy-duty',
                        'user_id':fields['user_id'], 'status':fields['status'], 'run_data':deepcopy(fields)}
                return self.outcome
            def get_run(self, **kwargs): return self.row
            def upsert_run(self, fields, *args, **kwargs):
                self.stored = deepcopy(fields)
                self.row = {'run_id':fields['run_id'], 'session_id':fields['session_id'], 'agent_id':'galaxy-duty',
                    'user_id':fields['user_id'], 'status':fields['status'], 'run_data':deepcopy(fields)}
                return None
            def append_run_to_session_if_absent(self, *args, run_dict, **kwargs):
                self.upsert_run(run_dict)
                return True
        self.db = Db()
        self.projected = duty_database(self.db, self.gateway)

    def update(self, fields):
        return self.projected.update_run_in_session(fields['session_id'], fields['run_id'], fields=fields)

    def test_completed_original_is_reported_after_persist_but_not_stored(self):
        self.update(self.fields)
        self.assertEqual(self.reports[-1][1]['finalAnalysis'], {'state':'available', 'text':'最终处理完成'})
        self.assertIsNone(self.db.stored['content'])
        self.assertIsNone(self.db.stored['reasoning_content'])

    def test_oversize_and_noncompleted_never_leak_text(self):
        self.fields['content'] = '中' * 4001
        self.update(self.fields)
        self.assertEqual(self.reports[-1][1]['finalAnalysis'], {'state':'too-large', 'byteLength':12003})
        for state in ('ERROR', 'PAUSED', 'CANCELLED'):
            self.fields['status'] = state
            self.update(self.fields)
            self.assertNotIn('finalAnalysis', self.reports[-1][1])

    def test_failed_persist_and_wrong_original_row_do_not_report_final(self):
        self.db.outcome = RunPersistOutcome.STALE_ATTEMPT
        self.update(self.fields)
        self.assertFalse(self.reports)
        self.db.outcome = RunPersistOutcome.UPDATED
        original = self.db.get_run
        def wrong(**kwargs):
            row = deepcopy(original(**kwargs))
            row['run_id'] = str(uuid4())
            return row
        self.db.get_run = wrong
        self.update(self.fields)
        self.assertNotIn('finalAnalysis', self.reports[-1][1])

    def test_upsert_and_append_use_the_same_original_binding(self):
        self.projected.upsert_run(self.fields, self.fields['session_id'], self.fields['user_id'])
        self.assertEqual(self.reports[-1][1]['finalAnalysis']['text'], self.fields['content'])
        self.projected.append_run_to_session_if_absent(self.fields['session_id'], run_dict=self.fields, user_id=self.fields['user_id'])
        self.assertEqual(self.reports[-1][1]['finalAnalysis']['text'], self.fields['content'])
