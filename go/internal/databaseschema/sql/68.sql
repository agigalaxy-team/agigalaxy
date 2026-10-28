
CREATE TABLE hub_heads_v2 (
 id uuid PRIMARY KEY REFERENCES builders(id),owner_id text NOT NULL REFERENCES subjects(id),
 version integer NOT NULL DEFAULT 0 CHECK(version>=0),state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','suspended'))
);
CREATE TABLE hub_events_v2 (
 id uuid PRIMARY KEY,hub_id uuid NOT NULL REFERENCES hub_heads_v2(id),subject_id text NOT NULL REFERENCES subjects(id),
 kind text NOT NULL CHECK(kind IN ('charter','invite','accept','decline','exit','remove','suspend','resume','intake-open','intake-reply','intake-close')),
 charter_version integer,object_id uuid,object_version integer NOT NULL,
 consent_id uuid NOT NULL REFERENCES consents(id),payload_text text NOT NULL,payload_hash text NOT NULL,received_at bigint NOT NULL
);
CREATE UNIQUE INDEX hub_charter_version_v2 ON hub_events_v2(hub_id,charter_version) WHERE kind='charter';
CREATE INDEX hub_events_owner_v2 ON hub_events_v2(subject_id,id);
CREATE INDEX hub_events_object_v2 ON hub_events_v2(hub_id,object_id,object_version);
CREATE TABLE hub_memberships_v2 (
 id uuid PRIMARY KEY,hub_id uuid NOT NULL REFERENCES hub_heads_v2(id),subject_id text NOT NULL REFERENCES subjects(id),
 version integer NOT NULL CHECK(version>=1),charter_version integer NOT NULL,state text NOT NULL CHECK(state IN ('invited','active','declined','exited','removed')),
 scopes jsonb NOT NULL,invite_id uuid NOT NULL REFERENCES hub_events_v2(id),decision_id uuid REFERENCES hub_events_v2(id),expires_at bigint NOT NULL
);
CREATE UNIQUE INDEX hub_active_member_v2 ON hub_memberships_v2(hub_id,subject_id) WHERE state IN ('invited','active');
CREATE TABLE hub_intake_v2 (
 id uuid PRIMARY KEY,hub_id uuid NOT NULL REFERENCES hub_heads_v2(id),subject_id text NOT NULL REFERENCES subjects(id),
 version integer NOT NULL CHECK(version>=1),state text NOT NULL CHECK(state IN ('open','closed')),created_at bigint NOT NULL,expires_at bigint NOT NULL
);
-- Intake event and thread are created in one transaction. The deferred edge
-- also preserves a minimal thread when another author retains a reply.
ALTER TABLE hub_events_v2 ADD COLUMN intake_id uuid REFERENCES hub_intake_v2(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE hub_events_v2 ADD CONSTRAINT hub_intake_event_v2 CHECK
 ((intake_id IS NOT NULL)=(kind IN ('intake-open','intake-reply','intake-close')) AND (intake_id IS NULL OR intake_id=object_id));
CREATE TABLE hub_peering_agreements_v2 (
 id uuid PRIMARY KEY,hub_id uuid NOT NULL REFERENCES hub_heads_v2(id),subject_id text NOT NULL REFERENCES subjects(id),
 version integer NOT NULL,agreement_hash text NOT NULL,state text NOT NULL CHECK(state IN ('local-approved','exited')),
 event_id uuid NOT NULL,expires_at bigint NOT NULL
);
CREATE TABLE hub_peering_events_v2 (
 id uuid PRIMARY KEY,hub_id uuid NOT NULL REFERENCES hub_heads_v2(id),subject_id text NOT NULL REFERENCES subjects(id),
 kind text NOT NULL CHECK(kind IN ('peer-approve','peer-exit','source-grant','source-revoke')),
 object_id uuid NOT NULL,consent_id uuid NOT NULL REFERENCES consents(id),payload_text text NOT NULL,payload_hash text NOT NULL,received_at bigint NOT NULL
);
ALTER TABLE hub_peering_agreements_v2 ADD CONSTRAINT hub_peering_event_v2 FOREIGN KEY(event_id) REFERENCES hub_peering_events_v2(id);
CREATE TABLE hub_peering_grants_v2 (
 id uuid PRIMARY KEY REFERENCES hub_peering_events_v2(id),hub_id uuid NOT NULL REFERENCES hub_heads_v2(id),subject_id text NOT NULL REFERENCES subjects(id),
 agreement_id uuid NOT NULL REFERENCES hub_peering_agreements_v2(id),agreement_version integer NOT NULL,requester_ids jsonb NOT NULL,
 expires_at bigint NOT NULL,revoked_at bigint,last_state text NOT NULL DEFAULT 'uninspected'
);
CREATE TABLE hub_peering_changes_v2 (
 sequence bigserial PRIMARY KEY,grant_id uuid NOT NULL REFERENCES hub_peering_grants_v2(id),agreement_id uuid NOT NULL REFERENCES hub_peering_agreements_v2(id),
 subject_id text NOT NULL REFERENCES subjects(id),state text NOT NULL,observed_at bigint NOT NULL
);
CREATE INDEX hub_peering_changes_agreement_v2 ON hub_peering_changes_v2(agreement_id,sequence);
CREATE TABLE hub_peering_receipts_v2 (
 query_id uuid NOT NULL,side text NOT NULL CHECK(side IN ('incoming','outgoing')),agreement_id uuid NOT NULL REFERENCES hub_peering_agreements_v2(id),
 subject_id text NOT NULL,request_hash text NOT NULL,response_hash text,state text NOT NULL CHECK(state IN ('pending','delivered','unknown')),
 created_at bigint NOT NULL,checked_at bigint NOT NULL,PRIMARY KEY(query_id,side)
);
ALTER TABLE hub_heads_v2 ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE hub_memberships_v2 ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE hub_peering_agreements_v2 ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE hub_peering_grants_v2 ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
