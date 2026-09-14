// A room invitation uses the same verified Account daily budget as a task
// invitation. The destination remains explicitly typed; no artificial Task.
export const communityRoomInvitesMigrationSql = `
ALTER TABLE community_write_receipts ADD COLUMN room_id uuid;
ALTER TABLE community_write_receipts ADD CONSTRAINT community_invitation_target
  CHECK (NOT (room_id IS NOT NULL AND task_id IS NOT NULL));
CREATE INDEX community_room_invitation_response ON community_write_receipts(room_id,recipient_id)
  WHERE category='invitation' AND responded_at IS NULL;
`;
