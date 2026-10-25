"""Negative cases run without Agno, psycopg, network or a database."""
import unittest
from database_contract import test_database_target, verify_test_database_target, TestDatabaseConfigurationError


def configured():
    return {"GALAXY_AGENTOS_TEST_DATABASE_URL": "postgresql+psycopg://galaxy_agentos_test_role:synthetic@127.0.0.1:55439/galaxy_agentos_test_db",
            "GALAXY_AGENTOS_TEST_DATABASE_NAME": "galaxy_agentos_test_db", "GALAXY_AGENTOS_TEST_ROLE": "galaxy_agentos_test_role",
            "GALAXY_AGENTOS_TEST_SCHEMA": "galaxy_agentos_test_schema"}


class DatabaseContractTest(unittest.TestCase):
    def test_runtime_url_never_fills_missing_test_configuration(self):
        with self.assertRaisesRegex(TestDatabaseConfigurationError, "explicit_configuration_required"):
            test_database_target({"GALAXY_AGENTOS_DATABASE_URL": "RUNTIME_SENTINEL_MUST_NEVER_BE_USED"})

    def test_every_explicit_field_is_required(self):
        for name in configured():
            env = configured(); del env[name]
            with self.subTest(name=name), self.assertRaises(TestDatabaseConfigurationError):
                test_database_target(env)

    def test_runtime_and_ambiguous_targets_fail_before_connect(self):
        for url in ("postgresql+psycopg://runtime@127.0.0.1:55439/production", configured()["GALAXY_AGENTOS_TEST_DATABASE_URL"]+"?options=-csearch_path=public",
                    configured()["GALAXY_AGENTOS_TEST_DATABASE_URL"].replace("127.0.0.1", "service.example.invalid")):
            env=configured();env["GALAXY_AGENTOS_TEST_DATABASE_URL"]=url
            with self.subTest(url=url), self.assertRaises(TestDatabaseConfigurationError):test_database_target(env)
        env=configured();env["GALAXY_AGENTOS_DATABASE_URL"]=env["GALAXY_AGENTOS_TEST_DATABASE_URL"]
        with self.assertRaisesRegex(TestDatabaseConfigurationError,"runtime_target_forbidden"):test_database_target(env)

    def test_actual_identity_or_superuser_is_rejected_read_only(self):
        target=test_database_target(configured())
        for row in [("production",target.role,target.role,False,False,False,False,False),
                    (target.database,target.role,target.role,True,False,False,False,False)]:
            calls=[]
            class Probe:
                def __enter__(self):return self
                def __exit__(self,*_):pass
                def cursor(self):return self
                def execute(self,*args):calls.append(args)
                def fetchone(self):return row
            def connect(*args,**kwargs):
                self.assertEqual(kwargs["options"],"-c default_transaction_read_only=on")
                return Probe()
            with self.assertRaisesRegex(TestDatabaseConfigurationError,"actual_identity_denied"):
                verify_test_database_target(target,connect=connect)
            self.assertEqual(len(calls),1)
            self.assertNotIn("synthetic",repr(target))


if __name__=="__main__":unittest.main(verbosity=2)
