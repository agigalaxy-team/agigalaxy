import { communityForumV1MigrationSql } from './community-forum-v1-schema.mjs';
import {taskMaterialV1MigrationSql} from './task-material-v1-schema.mjs';
import { searchIndexMigrationSql } from './search-index-schema-v1.mjs';
import {identityGroupV2MigrationSql} from './identity-group-v2-schema.mjs';
import {watchControlV2MigrationSql} from './watch-control-v2-schema.mjs';
import {informationWatchesV2MigrationSql} from './information-watches-v2-schema.mjs';
import {qualificationRequestsV2MigrationSql} from './qualification-requests-v2-schema.mjs';
import { builderSearchIndexMigrationSql } from './search-index-builders-v1.mjs';
import { identityControlMigrationSql } from './identity-control-schema-v2.mjs';
import { caseFactsV2MigrationSql } from './case-facts-v2-migration.mjs';
import { accountQuotaMigrationSql } from './account-quota-schema-v2.mjs';
import { taskParticipationMigrationSql } from './task-participation-schema-v2.mjs';
import { evidenceVerificationV2MigrationSql } from './evidence-verification-v2-migration.mjs';
import { chatMigrationSql } from './chat-schema-v2.mjs';
import { lifecycleV2MigrationSql } from './lifecycle-v2-migration.mjs';
import { capsuleV2MigrationSql } from './capsule-schema-v2.mjs';
import { communityRoomInvitesMigrationSql } from './community-room-invites-v2.mjs';
import { chatContentBudgetMigrationSql } from './chat-content-budget-v2.mjs';
import { personalNotificationsMigrationSql } from './personal-notifications-schema-v2.mjs';
import { projectsV2MigrationSql } from './projects-schema-v2.mjs';
import { contactsV2MigrationSql } from './contacts-schema-v2.mjs';
import { experienceReviewMigrationSql } from './experience-review-schema.mjs';
import { chatSharedSummariesMigrationSql } from './chat-shared-summaries-schema-v2.mjs';
import { recruitmentV2MigrationSql } from './recruitment-schema-v2.mjs';
import { contributionSharingV2MigrationSql } from './contribution-sharing-v2-schema.mjs';
import { contextGrantsV2MigrationSql } from './context-grants-v2.mjs';
import { ciObservationV2MigrationSql } from './ci-observation-v2-schema.mjs';
import { taskCommentsV2MigrationSql } from './task-comments-v2-schema.mjs';
import { choiceSnapshotV2MigrationSql } from './choice-snapshot-schema-v2.mjs';
import { configurationV2MigrationSql } from './configuration-v2-schema.mjs';
import { builderSupportV2MigrationSql } from './builder-support-v2-schema.mjs';
import {chatAttachmentsMigrationSql} from './chat-attachments-schema.mjs';
// Existing SQL is immutable; append new versions rather than editing these.
export const migrations = [{ version: 1, sql: `
CREATE TABLE subjects (
  id text PRIMARY KEY,
  public_key text NOT NULL,
  genesis_proof jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE binding_challenges (
  id uuid PRIMARY KEY,
  subject_id text NOT NULL,
  payload jsonb NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bindings (
  id uuid PRIMARY KEY,
  subject_id text NOT NULL REFERENCES subjects(id),
  challenge_id uuid NOT NULL UNIQUE REFERENCES binding_challenges(id),
  request_hash text NOT NULL,
  audience text NOT NULL,
  scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array'),
  receipt text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE access_credentials (
  token_hash text PRIMARY KEY,
  binding_id uuid NOT NULL REFERENCES bindings(id),
  scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  object_id text NOT NULL,
  request_id text NOT NULL,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  deduplication_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','completed','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 5),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_pending ON jobs (available_at) WHERE state = 'pending';
CREATE INDEX bindings_subject ON bindings (subject_id);
CREATE INDEX audit_object ON audit_events (object_id, sequence);
` }, { version: 2, sql: `
CREATE TABLE session_challenges (
  id uuid PRIMARY KEY,
  binding_id uuid NOT NULL REFERENCES bindings(id),
  challenge_hash text NOT NULL UNIQUE,
  credential_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
` }, { version: 3, sql: `
CREATE TABLE consents (
  id uuid PRIMARY KEY,
  subject_id text NOT NULL REFERENCES subjects(id),
  binding_id uuid NOT NULL REFERENCES bindings(id),
  intent jsonb NOT NULL,
  signature_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consents_owner ON consents(subject_id, created_at, id);
` }, { version: 4, sql: `
CREATE TABLE cases (
  id uuid PRIMARY KEY,
  subject_id text NOT NULL REFERENCES subjects(id),
  local_ref text NOT NULL,
  source_ref text NOT NULL,
  version integer NOT NULL CHECK (version>0),
  state text NOT NULL CHECK (state IN ('open','resolution-proposed','withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(subject_id,local_ref),
  UNIQUE(subject_id,source_ref)
);
CREATE TABLE case_events (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES cases(id),
  subject_id text NOT NULL REFERENCES subjects(id),
  kind text NOT NULL CHECK (kind IN ('case','attempt','result','revision','withdrawal')),
  version integer NOT NULL,
  consent_id uuid NOT NULL REFERENCES consents(id),
  payload jsonb NOT NULL,
  payload_text text NOT NULL,
  payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(case_id,version)
);
CREATE INDEX case_events_parent ON case_events(case_id,version);
` }, { version: 5, sql: `
ALTER TABLE jobs ADD COLUMN lease_id uuid;
CREATE TABLE evidence_submissions (
  id uuid PRIMARY KEY,
  subject_id text NOT NULL REFERENCES subjects(id),
  case_id uuid NOT NULL REFERENCES cases(id),
  result_id uuid NOT NULL REFERENCES case_events(id),
  consent_id uuid NOT NULL REFERENCES consents(id),
  source_key text NOT NULL,
  payload_text text NOT NULL,
  payload_hash text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','observed','unavailable','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(subject_id,source_key)
);
CREATE TABLE verification_attempts (
  id uuid PRIMARY KEY,
  evidence_id uuid NOT NULL REFERENCES evidence_submissions(id),
  job_id uuid NOT NULL REFERENCES jobs(id),
  attempt integer NOT NULL,
  observation jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id,attempt)
);
CREATE INDEX verification_evidence ON verification_attempts(evidence_id,created_at,id);
` }, { version: 6, sql: `
ALTER TABLE verification_attempts ADD COLUMN ordinal bigint GENERATED ALWAYS AS IDENTITY;
CREATE TABLE proofs (
  id uuid PRIMARY KEY,
  subject_id text NOT NULL REFERENCES subjects(id),
  evidence_id uuid NOT NULL REFERENCES evidence_submissions(id),
  observation_id uuid NOT NULL REFERENCES verification_attempts(id),
  consent_id uuid NOT NULL REFERENCES consents(id),
  payload_text text NOT NULL,
  payload_hash text NOT NULL,
  signed text NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proofs_owner ON proofs(subject_id,created_at,id);
` }, { version: 7, sql: `
ALTER TABLE audit_events ADD COLUMN context_version integer NOT NULL DEFAULT 0 CHECK (context_version IN (0,1));
ALTER TABLE audit_events ADD COLUMN client_id text;
ALTER TABLE audit_events ADD COLUMN audience text;
ALTER TABLE audit_events ADD COLUMN scope text;
ALTER TABLE audit_events ADD COLUMN consent_id uuid;
ALTER TABLE audit_events ADD COLUMN binding_id uuid;
ALTER TABLE audit_events ADD COLUMN http_request_id uuid;
ALTER TABLE audit_events ADD COLUMN idempotency_key text;
ALTER TABLE audit_events ADD CONSTRAINT audit_context_complete CHECK (context_version=0 OR
  (client_id IS NOT NULL AND audience IS NOT NULL AND scope IS NOT NULL AND consent_id IS NOT NULL
   AND binding_id IS NOT NULL AND idempotency_key IS NOT NULL));
` }, { version: 8, sql: `
ALTER TABLE audit_events DROP CONSTRAINT audit_context_complete;
ALTER TABLE audit_events ADD CONSTRAINT audit_context_complete CHECK (context_version=0 OR
  (client_id IS NOT NULL AND audience IS NOT NULL AND scope IS NOT NULL
   AND binding_id IS NOT NULL AND idempotency_key IS NOT NULL AND
   ((action IN ('binding.create','binding.revoke','session.create') AND consent_id IS NULL) OR
    (action NOT IN ('binding.create','binding.revoke','session.create') AND consent_id IS NOT NULL))));
` }, { version: 9, sql: `
ALTER TABLE audit_events ADD COLUMN binding_scopes jsonb;
ALTER TABLE audit_events ADD CONSTRAINT audit_binding_scopes_array CHECK
  (binding_scopes IS NULL OR jsonb_typeof(binding_scopes) = 'array');
` }, { version: 10, sql: `
ALTER TABLE audit_events ADD COLUMN credential_scopes jsonb;
ALTER TABLE audit_events ADD CONSTRAINT audit_credential_scopes_array CHECK
  (credential_scopes IS NULL OR jsonb_typeof(credential_scopes) = 'array');
` }, { version: 11, sql: `
ALTER TABLE audit_events ADD COLUMN caller_binding_id uuid;
ALTER TABLE audit_events ADD COLUMN caller_client_id text;
ALTER TABLE audit_events ADD COLUMN caller_audience text;
ALTER TABLE audit_events ADD COLUMN caller_binding_scopes jsonb;
ALTER TABLE audit_events ADD CONSTRAINT audit_caller_complete CHECK (
  (caller_binding_id IS NULL AND caller_client_id IS NULL AND caller_audience IS NULL AND caller_binding_scopes IS NULL)
  OR (caller_binding_id IS NOT NULL AND caller_client_id IS NOT NULL AND caller_audience IS NOT NULL
      AND caller_binding_scopes IS NOT NULL AND jsonb_typeof(caller_binding_scopes) = 'array'));
` }, { version: 12, sql: `
CREATE TABLE assistance_requests (
  id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES cases(id), requester_id text NOT NULL REFERENCES subjects(id),
  version integer NOT NULL CHECK(version>0), snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE assistance_events (
  id uuid PRIMARY KEY, assistance_id uuid NOT NULL REFERENCES assistance_requests(id),
  subject_id text NOT NULL REFERENCES subjects(id), version integer NOT NULL CHECK(version>0),
  consent_id uuid NOT NULL REFERENCES consents(id), payload_text text NOT NULL, payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(assistance_id,version)
);
CREATE INDEX assistance_case ON assistance_requests(case_id,id);
` }, { version: 13, sql: `
CREATE TABLE context_grants (
  id uuid PRIMARY KEY, assistance_id uuid NOT NULL REFERENCES assistance_requests(id),
  subject_id text NOT NULL REFERENCES subjects(id), participant_id text NOT NULL REFERENCES subjects(id),
  consent_id uuid NOT NULL REFERENCES consents(id), payload_text text NOT NULL, payload_hash text NOT NULL,
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE context_acceptances (
  id uuid PRIMARY KEY, grant_id uuid NOT NULL UNIQUE REFERENCES context_grants(id),
  subject_id text NOT NULL REFERENCES subjects(id), consent_id uuid NOT NULL REFERENCES consents(id),
  payload_text text NOT NULL, payload_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX context_assistance ON context_grants(assistance_id,id);
` }, { version: 14, sql: `
CREATE TABLE notification_preferences (
  subject_id text PRIMARY KEY REFERENCES subjects(id), revision integer NOT NULL DEFAULT 0,
  settings jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_reads (
  subject_id text NOT NULL REFERENCES subjects(id), kind text NOT NULL CHECK(kind IN ('assistance','context','context-accept')),
  event_id uuid NOT NULL, read_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(subject_id,kind,event_id)
);
` }, { version: 15, sql: `
CREATE TABLE moderation_reports (
  id uuid PRIMARY KEY, assistance_id uuid NOT NULL REFERENCES assistance_requests(id), reporter_id text NOT NULL REFERENCES subjects(id),
  participant_ids jsonb NOT NULL, consent_id uuid NOT NULL REFERENCES consents(id), payload_text text NOT NULL,payload_hash text NOT NULL,
  version integer NOT NULL DEFAULT 1,state text NOT NULL DEFAULT 'open',paused boolean NOT NULL DEFAULT false,
  appeal_count integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE moderation_events (
  id uuid PRIMARY KEY,report_id uuid NOT NULL REFERENCES moderation_reports(id),subject_id text NOT NULL REFERENCES subjects(id),
  consent_id uuid NOT NULL REFERENCES consents(id),version integer NOT NULL,payload_text text NOT NULL,payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(report_id,version)
);
CREATE INDEX moderation_assistance ON moderation_reports(assistance_id,paused,id);
` }, { version: 16, sql: `
CREATE TABLE capsules (
  id uuid PRIMARY KEY,subject_id text NOT NULL REFERENCES subjects(id),revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE capsule_events (
  id uuid PRIMARY KEY,capsule_id uuid NOT NULL REFERENCES capsules(id),subject_id text NOT NULL REFERENCES subjects(id),
  revision integer NOT NULL,version_id uuid NOT NULL,kind text NOT NULL,
  consent_id uuid NOT NULL REFERENCES consents(id),payload_text text NOT NULL,payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(capsule_id,revision)
);
CREATE TABLE capsule_uses (
  id uuid PRIMARY KEY,capsule_id uuid NOT NULL REFERENCES capsules(id),version_id uuid NOT NULL REFERENCES capsule_events(id),
  subject_id text NOT NULL REFERENCES subjects(id),case_id uuid NOT NULL REFERENCES cases(id),
  attempt_id uuid REFERENCES case_events(id),result_id uuid REFERENCES case_events(id),prior_use_id uuid REFERENCES capsule_uses(id),
  kind text NOT NULL CHECK(kind IN ('reference','apply','reverify')),observed_revision integer NOT NULL,
  consent_id uuid NOT NULL REFERENCES consents(id),payload_text text NOT NULL,payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),UNIQUE NULLS NOT DISTINCT(version_id,case_id,kind,result_id)
);
CREATE INDEX capsule_owner ON capsules(subject_id,id);
CREATE INDEX capsule_use_case ON capsule_uses(case_id,id);
ALTER TABLE notification_reads DROP CONSTRAINT notification_reads_kind_check;
ALTER TABLE notification_reads ADD CONSTRAINT notification_reads_kind_check CHECK(kind IN ('assistance','context','context-accept','capsule'));
` }, { version: 17, sql: `
CREATE TABLE builders (
  id uuid PRIMARY KEY,owner_id text NOT NULL REFERENCES subjects(id),type text NOT NULL CHECK(type IN ('worker','bridge','hub')),
  revision integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE builder_events (
  id uuid PRIMARY KEY,builder_id uuid NOT NULL REFERENCES builders(id),subject_id text NOT NULL REFERENCES subjects(id),
  revision integer NOT NULL,kind text NOT NULL CHECK(kind IN ('declare','maintenance','heartbeat','compatibility')),
  consent_id uuid NOT NULL REFERENCES consents(id),payload_text text NOT NULL,payload_hash text NOT NULL,
  received_at bigint NOT NULL,UNIQUE(builder_id,revision)
);
CREATE INDEX builders_owner ON builders(owner_id,id);
CREATE INDEX builders_type ON builders(type,id);
` }, { version: 18, sql: `
ALTER TABLE builder_events DROP CONSTRAINT builder_events_kind_check;
ALTER TABLE builder_events ADD CONSTRAINT builder_events_kind_check
  CHECK(kind IN ('declare','maintenance','heartbeat','compatibility','node-control','node-control-revoke'));
` }, { version: 19, sql: `
CREATE UNIQUE INDEX audit_http_failure_request ON audit_events(http_request_id,action)
  WHERE action IN ('http.rejected','http.failed');
` }, { version: 20, sql: `
CREATE TABLE audit_access_grants (
  id uuid PRIMARY KEY,reviewer_id text NOT NULL REFERENCES subjects(id),reviewer_binding_id uuid NOT NULL REFERENCES bindings(id),
  reader_id text NOT NULL REFERENCES subjects(id),payload_text text NOT NULL,payload_hash text NOT NULL,signature text NOT NULL,
  expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),CHECK(reviewer_id<>reader_id)
);
CREATE INDEX audit_grants_reader ON audit_access_grants(reader_id,id);
CREATE TABLE audit_reads (
  id uuid PRIMARY KEY,actor_id text NOT NULL REFERENCES subjects(id),subject_id text NOT NULL,
  grant_id uuid REFERENCES audit_access_grants(id),action text NOT NULL CHECK(action IN ('query','export')),
  selection jsonb NOT NULL,result_hash text NOT NULL,result_count integer NOT NULL,created_at timestamptz NOT NULL
);
CREATE INDEX audit_actor_sequence ON audit_events(actor,sequence);
CREATE INDEX audit_binding_sequence ON audit_events(binding_id,sequence);
ALTER TABLE audit_events DROP CONSTRAINT audit_context_complete;
ALTER TABLE audit_events ADD CONSTRAINT audit_context_complete CHECK (context_version=0 OR
  (client_id IS NOT NULL AND audience IS NOT NULL AND scope IS NOT NULL
   AND binding_id IS NOT NULL AND idempotency_key IS NOT NULL AND
   ((action IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export') AND consent_id IS NULL) OR
    (action NOT IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export') AND consent_id IS NOT NULL))));
` }, { version: 21, sql: `
CREATE TABLE recovery_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), recovery_id uuid NOT NULL,
  snapshot_id text NOT NULL,status text NOT NULL CHECK(status IN ('quarantined','ready')),
  created_at timestamptz NOT NULL DEFAULT now(),activated_at timestamptz
);
` }, { version: 22, sql: `
CREATE TABLE data_exports (
  id uuid PRIMARY KEY,subject_id text NOT NULL REFERENCES subjects(id),binding_id uuid NOT NULL REFERENCES bindings(id),
  datasets jsonb NOT NULL,bounds jsonb NOT NULL,selection_cutoff timestamptz NOT NULL,expires_at timestamptz NOT NULL,
  revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX data_exports_expiry ON data_exports(expires_at);
CREATE INDEX data_exports_owner ON data_exports(binding_id,expires_at);
CREATE TABLE data_export_reads (
  id uuid PRIMARY KEY,export_id uuid REFERENCES data_exports(id) ON DELETE SET NULL,subject_id text NOT NULL REFERENCES subjects(id),
  dataset text NOT NULL,after_cursor text NOT NULL,result_hash text NOT NULL,result_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE audit_events DROP CONSTRAINT audit_context_complete;
ALTER TABLE audit_events ADD CONSTRAINT audit_context_complete CHECK (context_version=0 OR
  (client_id IS NOT NULL AND audience IS NOT NULL AND scope IS NOT NULL AND binding_id IS NOT NULL AND idempotency_key IS NOT NULL AND
  ((action IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke') AND consent_id IS NULL) OR
   (action NOT IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke') AND consent_id IS NOT NULL))));
 ` }, { version: 23, sql: `
ALTER TABLE data_exports ADD COLUMN views jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(views)='array');
` }, { version: 24, sql: `
CREATE TABLE deletion_requests (
  id uuid PRIMARY KEY,subject_id text NOT NULL,binding_id uuid NOT NULL,requester_public_key text NOT NULL,
  payload_text text NOT NULL,payload_hash text NOT NULL,signature text NOT NULL,
  state text NOT NULL CHECK(state IN ('requested','review-needed','approved','rejected','cancelled')),
  revision integer NOT NULL CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX deletion_active_subject ON deletion_requests(subject_id) WHERE state IN ('requested','review-needed','approved');
CREATE TABLE deletion_events (
  id uuid PRIMARY KEY,request_id uuid NOT NULL REFERENCES deletion_requests(id),revision integer NOT NULL CHECK(revision>0),
  actor_kind text NOT NULL CHECK(actor_kind IN ('subject','operator')),actor_ref text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('request','cancel','needs-information','approve','reject')),
  payload_text text NOT NULL,payload_hash text NOT NULL,signature text,created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(request_id,revision),CHECK((actor_kind='subject')=(signature IS NOT NULL))
);
ALTER TABLE audit_events DROP CONSTRAINT audit_context_complete;
ALTER TABLE audit_events ADD CONSTRAINT audit_context_complete CHECK (context_version=0 OR
  (client_id IS NOT NULL AND audience IS NOT NULL AND scope IS NOT NULL AND binding_id IS NOT NULL AND idempotency_key IS NOT NULL AND
  ((action IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel') AND consent_id IS NULL) OR
   (action NOT IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel') AND consent_id IS NOT NULL))));
` }, { version: 25, sql: `
ALTER TABLE deletion_requests ADD COLUMN execution_result jsonb;
ALTER TABLE deletion_requests DROP CONSTRAINT deletion_requests_state_check;
ALTER TABLE deletion_requests ADD CONSTRAINT deletion_requests_state_check CHECK(state IN ('requested','review-needed','approved','rejected','cancelled','partial','primary-erased'));
DROP INDEX deletion_active_subject;
CREATE UNIQUE INDEX deletion_active_subject ON deletion_requests(subject_id) WHERE state IN ('requested','review-needed','approved','partial','primary-erased');
ALTER TABLE deletion_events DROP CONSTRAINT deletion_events_kind_check;
ALTER TABLE deletion_events ADD CONSTRAINT deletion_events_kind_check CHECK(kind IN ('request','cancel','needs-information','approve','reject','execute'));
CREATE TABLE deletion_executions (
  id uuid PRIMARY KEY,request_id uuid NOT NULL REFERENCES deletion_requests(id),subject_id text NOT NULL,
  command_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
` }, { version: 26, sql: `
CREATE TABLE deletion_replays (
  id uuid PRIMARY KEY,recovery_id uuid NOT NULL UNIQUE,source_digest text NOT NULL,
  command_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
` }, { version: 27, sql: `
ALTER TABLE deletion_requests ADD COLUMN minimized_at timestamptz;
ALTER TABLE deletion_events ADD COLUMN payload_minimized boolean NOT NULL DEFAULT false;
ALTER TABLE deletion_events ADD COLUMN retained_payload jsonb;
ALTER TABLE deletion_events ADD COLUMN retained_hash text;
ALTER TABLE deletion_events ADD CONSTRAINT deletion_retained_payload CHECK (
  (NOT payload_minimized AND retained_payload IS NULL AND retained_hash IS NULL) OR
  (payload_minimized AND actor_kind='operator' AND signature IS NULL AND payload_text='' AND retained_payload IS NOT NULL AND retained_hash IS NOT NULL AND retained_hash ~ '^[a-f0-9]{64}$'));
ALTER TABLE deletion_events DROP CONSTRAINT deletion_events_kind_check;
ALTER TABLE deletion_events ADD CONSTRAINT deletion_events_kind_check CHECK(kind IN ('request','cancel','needs-information','approve','reject','execute','minimize'));
` }, { version: 28, sql: `
CREATE TABLE runtime_config_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,id uuid NOT NULL UNIQUE,
  endpoint text NOT NULL,component text NOT NULL CHECK(component IN ('api','worker')),
  command_hash text NOT NULL CHECK(command_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),event_hash text NOT NULL CHECK(event_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runtime_config_history ON runtime_config_events(endpoint,component,sequence);
` }, { version: 29, sql: `
CREATE TABLE incident_notices (
  id uuid PRIMARY KEY,subject_id text NOT NULL REFERENCES subjects(id),
  runtime_config_id uuid NOT NULL REFERENCES runtime_config_events(id),
  incident_id text NOT NULL,incident_revision integer NOT NULL CHECK(incident_revision>0),
  operator_ref text NOT NULL,title text NOT NULL,summary text NOT NULL,
  command_hash text NOT NULL CHECK(command_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_notices_subject ON incident_notices(subject_id,id);
ALTER TABLE notification_reads DROP CONSTRAINT notification_reads_kind_check;
ALTER TABLE notification_reads ADD CONSTRAINT notification_reads_kind_check CHECK(kind IN ('assistance','context','context-accept','capsule','incident'));
` }, { version: 30, sql: `
CREATE TABLE profile_statements (
  id uuid PRIMARY KEY,subject_id text NOT NULL REFERENCES subjects(id),
  revision integer NOT NULL CHECK(revision>0),consent_id uuid NOT NULL REFERENCES consents(id),
  payload_text text NOT NULL,payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(subject_id,revision)
);
` }, { version: 31, sql: `
ALTER TABLE moderation_reports ALTER COLUMN assistance_id DROP NOT NULL;
ALTER TABLE moderation_reports ADD COLUMN case_id uuid REFERENCES cases(id);
ALTER TABLE moderation_reports ADD CONSTRAINT moderation_exact_target CHECK (
  (assistance_id IS NOT NULL AND case_id IS NULL) OR (assistance_id IS NULL AND case_id IS NOT NULL));
CREATE INDEX moderation_case ON moderation_reports(case_id,paused,id);
` },{version:32,sql:searchIndexMigrationSql},{version:33,sql:builderSearchIndexMigrationSql},{version:34,sql:`
ALTER TABLE builder_events DROP CONSTRAINT builder_events_kind_check;
ALTER TABLE builder_events ADD CONSTRAINT builder_events_kind_check
  CHECK(kind IN ('declare','maintenance','heartbeat','compatibility','node-control','node-control-revoke','work-evidence','work-evidence-revoke'));
`},{version:35,sql:`
ALTER TABLE builder_events DROP CONSTRAINT builder_events_kind_check;
ALTER TABLE builder_events ADD CONSTRAINT builder_events_kind_check
  CHECK(kind IN ('declare','maintenance','heartbeat','compatibility','node-control','node-control-revoke','work-evidence','work-evidence-revoke','probe-request'));
CREATE TABLE builder_probes (
  id uuid PRIMARY KEY,request_id uuid NOT NULL REFERENCES builder_events(id),job_id uuid NOT NULL REFERENCES jobs(id),
  attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3),observation jsonb NOT NULL CHECK(jsonb_typeof(observation)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(request_id,attempt)
);
`},{version:36,sql:`
ALTER TABLE audit_events DROP CONSTRAINT audit_context_complete;
ALTER TABLE audit_events ADD CONSTRAINT audit_context_complete CHECK (context_version=0 OR
  (client_id IS NOT NULL AND audience IS NOT NULL AND scope IS NOT NULL AND binding_id IS NOT NULL AND idempotency_key IS NOT NULL AND
  ((action IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel','context.query') AND consent_id IS NULL) OR
   (action NOT IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel','context.query') AND consent_id IS NOT NULL))));
`},{version:37,sql:`
ALTER TABLE audit_events DROP CONSTRAINT audit_context_complete;
ALTER TABLE audit_events ADD CONSTRAINT audit_context_complete CHECK (context_version=0 OR
  (client_id IS NOT NULL AND audience IS NOT NULL AND scope IS NOT NULL AND binding_id IS NOT NULL AND idempotency_key IS NOT NULL AND
  ((action IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel','context.query','notification.preferences','notification.read') AND consent_id IS NULL) OR
   (action NOT IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel','context.query','notification.preferences','notification.read') AND consent_id IS NOT NULL))));
`},{version:38,sql:`
CREATE TABLE honor_rule_versions (
  sequence bigserial UNIQUE NOT NULL,endpoint text NOT NULL,rule_id text NOT NULL,rule_version text NOT NULL,
  definition_hash text NOT NULL CHECK(definition_hash ~ '^[a-f0-9]{64}$'),
  definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
  introduced_config_id uuid NOT NULL REFERENCES runtime_config_events(id),created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(endpoint,rule_id,rule_version)
);
CREATE INDEX honor_rule_versions_history ON honor_rule_versions(endpoint,sequence);
`},{version:39,sql:`
ALTER TABLE notification_preferences ADD COLUMN archived_before timestamptz;
CREATE INDEX notification_reads_retention ON notification_reads(subject_id,read_at);
CREATE INDEX assistance_invitation_rate ON assistance_events(subject_id,created_at)
  WHERE payload_text::jsonb->'event'->>'kind'='invite';
ALTER TABLE audit_events DROP CONSTRAINT audit_context_complete;
ALTER TABLE audit_events ADD CONSTRAINT audit_context_complete CHECK (context_version=0 OR
  (client_id IS NOT NULL AND audience IS NOT NULL AND scope IS NOT NULL AND binding_id IS NOT NULL AND idempotency_key IS NOT NULL AND
  ((action IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel','context.query','notification.preferences','notification.read','notification.archive') AND consent_id IS NULL) OR
   (action NOT IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel','context.query','notification.preferences','notification.read','notification.archive') AND consent_id IS NOT NULL))));
`},{version:40,sql:`
CREATE TABLE external_identity_links (
  id uuid PRIMARY KEY,subject_id text NOT NULL REFERENCES subjects(id),binding_id uuid NOT NULL REFERENCES bindings(id),
  endpoint text NOT NULL,provider_id text NOT NULL,issuer text NOT NULL,external_subject text NOT NULL,client_id text NOT NULL,
  payload_text text NOT NULL,payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz
);
CREATE UNIQUE INDEX external_identity_active_account ON external_identity_links(endpoint,issuer,external_subject) WHERE revoked_at IS NULL;
CREATE INDEX external_identity_owner ON external_identity_links(subject_id,endpoint,id);
ALTER TABLE audit_events DROP CONSTRAINT audit_context_complete;
ALTER TABLE audit_events ADD CONSTRAINT audit_context_complete CHECK (context_version=0 OR
  (client_id IS NOT NULL AND audience IS NOT NULL AND scope IS NOT NULL AND binding_id IS NOT NULL AND idempotency_key IS NOT NULL AND
  ((action IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel','context.query','notification.preferences','notification.read','notification.archive','identity.link','identity.unlink') AND consent_id IS NULL) OR
   (action NOT IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel','context.query','notification.preferences','notification.read','notification.archive','identity.link','identity.unlink') AND consent_id IS NOT NULL))));
`},{version:41,sql:`
ALTER TABLE audit_events DROP CONSTRAINT audit_context_complete;
ALTER TABLE audit_events ADD CONSTRAINT audit_context_complete CHECK (context_version=0 OR
  (client_id IS NOT NULL AND audience IS NOT NULL AND scope IS NOT NULL AND binding_id IS NOT NULL AND idempotency_key IS NOT NULL AND
  ((action IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel','context.query','notification.preferences','notification.read','notification.archive','identity.link','identity.unlink','oauth.access') AND consent_id IS NULL) OR
   (action NOT IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel','context.query','notification.preferences','notification.read','notification.archive','identity.link','identity.unlink','oauth.access') AND consent_id IS NOT NULL))));
`}];


import {hubsV2MigrationSql} from './hubs-v2-schema.mjs';
import {workerPackUsesV2MigrationSql} from './worker-pack-uses-v2-schema.mjs';
import {trustPackagePermissionsMigrationSql} from './trust-package-permissions-schema-v1.mjs';
import {targetGovernanceV2MigrationSql} from './target-governance-v2-schema.mjs';
import {outcomeMaterialV2MigrationSql} from './outcome-material-v2-schema.mjs';
import {capsuleApplicationOriginV2MigrationSql} from './capsule-application-origin-v2-schema.mjs';
import {moderationNotificationsV2MigrationSql} from './moderation-notifications-v2-schema.mjs';
import {chatRoomGovernanceV2MigrationSql} from './chat-room-governance-v2-schema.mjs';
migrations.push({ version: 42, sql: identityControlMigrationSql },
  { version: 43, sql: caseFactsV2MigrationSql }, { version: 44, sql: accountQuotaMigrationSql },
  { version: 45, sql: taskParticipationMigrationSql }, { version: 46, sql: evidenceVerificationV2MigrationSql },
  { version: 47, sql: chatMigrationSql }, { version: 48, sql: lifecycleV2MigrationSql },
  { version: 49, sql: capsuleV2MigrationSql }, { version: 50, sql: communityRoomInvitesMigrationSql },
  { version: 51, sql: chatContentBudgetMigrationSql }, { version: 52, sql: personalNotificationsMigrationSql },
  { version: 53, sql: projectsV2MigrationSql }, { version: 54, sql: contactsV2MigrationSql },
  { version: 55, sql: experienceReviewMigrationSql }, { version: 56, sql: chatSharedSummariesMigrationSql },
  { version: 57, sql: recruitmentV2MigrationSql }, { version: 58, sql: contributionSharingV2MigrationSql },
  { version: 59, sql: contextGrantsV2MigrationSql }, { version: 60, sql: ciObservationV2MigrationSql },
  { version: 61, sql: taskCommentsV2MigrationSql }, {version:62,sql:choiceSnapshotV2MigrationSql}, {version:63,sql:configurationV2MigrationSql},
  {version:64,sql:builderSupportV2MigrationSql},{version:65,sql:chatAttachmentsMigrationSql},{version:66,sql:qualificationRequestsV2MigrationSql},
  {version:67,sql:trustPackagePermissionsMigrationSql},{version:68,sql:hubsV2MigrationSql},{version:69,sql:workerPackUsesV2MigrationSql},{version:70,sql:informationWatchesV2MigrationSql},
  {version:71,sql:targetGovernanceV2MigrationSql},{version:72,sql:identityGroupV2MigrationSql},{version:73,sql:watchControlV2MigrationSql},{version:74,sql:outcomeMaterialV2MigrationSql},
  {version:75,sql:`
ALTER TABLE audit_events DROP CONSTRAINT audit_context_complete;
ALTER TABLE audit_events ADD CONSTRAINT audit_context_complete CHECK (context_version=0 OR
 (client_id IS NOT NULL AND audience IS NOT NULL AND scope IS NOT NULL AND binding_id IS NOT NULL AND idempotency_key IS NOT NULL AND
 ((action IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.binary','data.export.revoke','data.deletion.request','data.deletion.cancel','context.query','notification.preferences','notification.read','notification.archive','identity.link','identity.unlink','oauth.access','trust.permission.grant','trust.permission.revoke','identity.group.approval') AND consent_id IS NULL) OR
 (action NOT IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.binary','data.export.revoke','data.deletion.request','data.deletion.cancel','context.query','notification.preferences','notification.read','notification.archive','identity.link','identity.unlink','oauth.access','trust.permission.grant','trust.permission.revoke','identity.group.approval') AND consent_id IS NOT NULL))));
`},{version:76,sql:capsuleApplicationOriginV2MigrationSql},
  // Development-only registration: these next-batch inputs are not in the
  // immutable published 0.1.1/schema76 release and await focused acceptance.
  {version:77,sql:moderationNotificationsV2MigrationSql},
  {version:78,sql:chatRoomGovernanceV2MigrationSql},
  {version:79,sql:communityForumV1MigrationSql},{version:80,sql:taskMaterialV1MigrationSql});

export function assertSupportedSchema(versions) {
  const actual = versions.map(row => row.version ?? row);
  const expected = migrations.map(row => row.version);
  if (actual.join(',') !== expected.join(',')) throw new Error('Migrations required');
}
