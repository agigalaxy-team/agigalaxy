from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

import httpx
from galaxy_model_gateway.metadata import safe_record
from galaxy_model_gateway.usage import UsageStore


class ModelFailureMetadataTest(unittest.TestCase):
    def test_01_callback_retains_typed_category_and_observed_http_without_prose_or_ddl(self):
        secret = 'PRIVATE_PROMPT_PROVIDER_BODY_AND_AUTHORIZATION'
        class Error(Exception):
            def __str__(self):
                raise AssertionError('exception prose must never be read')
        class RateLimitError(Error):
            status_code = 429
            response = httpx.Response(429, text=secret, request=httpx.Request('POST','https://provider.invalid/v1',headers={'Authorization':secret}))
        class APITimeoutError(Error):
            status_code = None
        class Unknown(Error):
            status_code = True
        start = datetime(2033,1,1,tzinfo=timezone.utc)
        call = {'galaxy_call_id':'12345678-1234-4234-8234-123456789abc','galaxy_scenario':'governance','galaxy_model_alias':'galaxy-selected','galaxy_config_version':'human-v1'}
        kwargs = {'litellm_params':{'metadata':call},'messages':[secret],'traceback_exception':secret,'original_response':secret}
        failures = []
        for error, expected in [(RateLimitError(), {'stage':'model-request','category':'rate-limit','reportedStatus':429,'httpStatus':429}), (APITimeoutError(), {'stage':'model-request','category':'timeout','reportedStatus':None,'httpStatus':None}), (Unknown(), {'stage':'model-request','category':'unknown','reportedStatus':None,'httpStatus':None})]:
            with self.subTest(category=expected['category']):
                row = safe_record({**kwargs,'exception':error}, None, start, start+timedelta(seconds=2), failed=True)
                self.assertEqual(row['failure'], expected)
                self.assertEqual(row['code'], 'model_gateway_request_failed')
                self.assertNotIn(secret, json.dumps(row))
                self.assertIsNone(row['inputTokens'])
                failures.append(row)
        self.assertNotIn('failure', safe_record(kwargs, {'usage':{'prompt_tokens':4,'completion_tokens':1,'total_tokens':5}}, start, start, failed=False))
        with tempfile.TemporaryDirectory(prefix='galaxy-safe-model-failure-') as folder:
            db_file = Path(folder)/'usage.sqlite3'
            store = UsageStore(db_file, now=lambda:start+timedelta(seconds=3))
            store.start(call)
            store.finish(failures[0])
            with sqlite3.connect(db_file) as db:
                self.assertNotIn('failure', {row[1] for row in db.execute('PRAGMA table_info(calls)')})
                row = db.execute('SELECT state,input_tokens,total_tokens FROM calls WHERE call_id=?',(call['galaxy_call_id'],)).fetchone()
                self.assertEqual(row, ('failed',None,None), 'existing durable call/usage schema stays compatible and unknown')


if __name__ == '__main__':
    unittest.main()
