
CREATE TABLE room_shared_summaries (
 share_id UUID PRIMARY KEY,
 subject_id TEXT NOT NULL REFERENCES subjects(id),
 room_id UUID NOT NULL REFERENCES chat_rooms(room_id),
 member_revision INTEGER NOT NULL CHECK(member_revision>0),
 request_hash TEXT NOT NULL,
 notice_hash TEXT NOT NULL,
 message_id UUID REFERENCES chat_message_refs(message_id),
 supersedes_share_id UUID REFERENCES room_shared_summaries(share_id),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','published','retracted','expired')),
 content JSONB NOT NULL,
 source_facts JSONB NOT NULL DEFAULT '[]',
 created_at TIMESTAMPTZ NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 retracted_at TIMESTAMPTZ,
 CHECK(expires_at>created_at),
 CHECK(supersedes_share_id IS NULL OR supersedes_share_id<>share_id),
 UNIQUE(message_id)
);
CREATE INDEX room_shared_summaries_room ON room_shared_summaries(room_id,created_at,share_id);
CREATE INDEX room_shared_summaries_owner ON room_shared_summaries(subject_id,share_id);
CREATE INDEX room_shared_summaries_expiry ON room_shared_summaries(expires_at) WHERE state IN ('pending','published');
CREATE INDEX room_shared_summaries_sources ON room_shared_summaries USING GIN(source_facts);
