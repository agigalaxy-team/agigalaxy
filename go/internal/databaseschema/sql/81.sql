
CREATE TABLE chat_directory_clock (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 value bigint NOT NULL CHECK(value>=0)
);
INSERT INTO chat_directory_clock(singleton,value) VALUES(true,0);
CREATE FUNCTION public.galaxy_chat_next_directory_order() RETURNS bigint
 LANGUAGE sql VOLATILE AS $$
 UPDATE public.chat_directory_clock SET value=value+1 WHERE singleton=true RETURNING value;
$$;
ALTER TABLE chat_rooms ADD COLUMN created_order bigint;
WITH ordered AS (SELECT room_id,row_number() OVER(ORDER BY created_at,room_id) AS ordinal FROM chat_rooms)
 UPDATE chat_rooms r SET created_order=o.ordinal FROM ordered o WHERE r.room_id=o.room_id;
UPDATE chat_directory_clock SET value=(SELECT COALESCE(MAX(created_order),0) FROM chat_rooms);
ALTER TABLE chat_rooms ALTER COLUMN created_order SET NOT NULL;
ALTER TABLE chat_rooms ALTER COLUMN created_order SET DEFAULT public.galaxy_chat_next_directory_order();
CREATE UNIQUE INDEX chat_room_creation_order ON chat_rooms(created_order);
ALTER TABLE chat_memberships ADD COLUMN joined_order bigint;
WITH ordered AS (SELECT room_id,subject_id,row_number() OVER(ORDER BY joined_at,room_id,subject_id) AS ordinal FROM chat_memberships)
 UPDATE chat_memberships m SET joined_order=c.value+o.ordinal FROM ordered o,chat_directory_clock c
 WHERE m.room_id=o.room_id AND m.subject_id=o.subject_id;
UPDATE chat_directory_clock SET value=GREATEST(value,(SELECT COALESCE(MAX(joined_order),0) FROM chat_memberships));
ALTER TABLE chat_memberships ALTER COLUMN joined_order SET NOT NULL;
ALTER TABLE chat_memberships ALTER COLUMN joined_order SET DEFAULT public.galaxy_chat_next_directory_order();
CREATE FUNCTION public.galaxy_chat_rejoin_directory_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.left_at IS NULL AND (OLD.left_at IS NOT NULL OR NEW.joined_at IS DISTINCT FROM OLD.joined_at) THEN
  NEW.joined_order:=public.galaxy_chat_next_directory_order();
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER chat_rejoin_directory_order BEFORE UPDATE OF joined_at,left_at ON chat_memberships
 FOR EACH ROW EXECUTE FUNCTION public.galaxy_chat_rejoin_directory_order();
ALTER TABLE chat_message_refs ADD COLUMN accepted_order bigint;
ALTER TABLE chat_message_refs ADD COLUMN accepted_at timestamptz;
-- The old archive ID proves acceptance, but its acceptance time was not stored.
-- Preserve that distinction; sent_at is never copied into accepted_at.
WITH ordered AS (SELECT message_id,row_number() OVER(ORDER BY sequence) AS ordinal FROM chat_message_refs WHERE archive_id IS NOT NULL)
 UPDATE chat_message_refs m SET accepted_order=c.value+o.ordinal FROM ordered o,chat_directory_clock c WHERE m.message_id=o.message_id;
UPDATE chat_directory_clock SET value=GREATEST(value,(SELECT COALESCE(MAX(accepted_order),0) FROM chat_message_refs));
CREATE UNIQUE INDEX chat_message_acceptance_order ON chat_message_refs(accepted_order) WHERE accepted_order IS NOT NULL;
CREATE INDEX chat_room_acceptance_order ON chat_message_refs(room_id,accepted_order DESC) WHERE accepted_order IS NOT NULL;
ALTER TABLE chat_cursors ADD COLUMN accepted_order bigint NOT NULL DEFAULT 0 CHECK(accepted_order>=0);
-- Compatibility with the original human declaration "read through sequence".
UPDATE chat_cursors c SET accepted_order=COALESCE((SELECT MAX(m.accepted_order) FROM chat_message_refs m
 WHERE m.room_id=c.room_id AND m.sequence<=c.sequence),0) WHERE c.cursor_kind='human' AND c.agent_ref='';
CREATE TABLE chat_human_message_reads (
 room_id uuid NOT NULL REFERENCES chat_rooms(room_id),subject_id text NOT NULL REFERENCES subjects(id),
 message_id uuid NOT NULL REFERENCES chat_message_refs(message_id),read_at timestamptz NOT NULL,
 PRIMARY KEY(room_id,subject_id,message_id)
);
