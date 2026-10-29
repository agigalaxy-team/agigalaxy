from types import SimpleNamespace
import unittest
from galaxy_agentos.run_view import run_view

class RunViewTimeTests(unittest.TestCase):
    def test_only_matching_completed_event_is_published(self):
        run = SimpleNamespace(run_id='run-a',status='COMPLETED',content='answer',agent_id='galaxy-conversation-overview',metadata={},events=[SimpleNamespace(event='RunCompleted',run_id='run-a',created_at=123,event_index=0)],metrics=None,input=None,created_at=100,regenerated_from=None)
        self.assertEqual(run_view(run)['completedAt'],123)
        run.events[0].run_id='other';self.assertIsNone(run_view(run)['completedAt'])
        run.events[0].run_id='run-a';run.status='ERROR';self.assertIsNone(run_view(run)['completedAt'])
        run.status='COMPLETED';run.events=[];self.assertIsNone(run_view(run)['completedAt'])
        run.events=[SimpleNamespace(event='ToolCallCompleted',run_id='run-a',created_at=125,event_index=0)];self.assertIsNone(run_view(run)['completedAt'])
