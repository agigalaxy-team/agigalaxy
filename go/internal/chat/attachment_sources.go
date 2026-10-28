package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/jackc/pgx/v5"
)

// InspectAttachmentWithin returns current original-file metadata to an already
// authenticated material transaction. It performs no byte read or new scope.
func (f *AttachmentService) InspectAttachmentWithin(ctx context.Context, tx pgx.Tx, a Actor, id string) (Object, error) {
	if !validID(id) {
		return nil, fail("invalid_attachment_request", 400)
	}
	r, _, e := f.roomRow(ctx, tx, a, id, "", false, false)
	if e != nil {
		return nil, e
	}
	if e = f.readable(ctx, tx, a, r, false); e != nil {
		return nil, e
	}
	return r, nil
}

// SelectAttachmentWithin is the original Outcome selected-copy source read.
// Its caller still owns exact source/version checks and reuse consent.
func (f *AttachmentService) SelectAttachmentWithin(ctx context.Context, tx pgx.Tx, a Actor, id string) (Object, []byte, error) {
	if f.Store == nil || f.Scanner == nil {
		return nil, nil, fail("outcome_attachment_copy_unavailable", 503)
	}
	r, e := f.InspectAttachmentWithin(ctx, tx, a, id)
	if e != nil {
		return nil, nil, e
	}
	bytes, e := f.Store.Get(ctx, str(r, "storage_key"), str(r, "encryption_key_id"), num(r, "byte_size"))
	if e != nil {
		return nil, nil, e
	}
	if bytes == nil || attachments.Digest(bytes) != str(r, "sha256") {
		return nil, nil, fail("outcome_source_integrity_failed", 502)
	}
	if _, e = f.InspectAttachmentWithin(ctx, tx, a, id); e != nil {
		return nil, nil, e
	}
	return r, bytes, nil
}

type AttachmentCaseSelection struct {
	AttachmentID, RoomID, MessageID string
	Revision                        int64
	AssertCase                      func(context.Context, pgx.Tx) (Object, error)
}

// SelectedCaseContentWithin accepts only the governance domain's explicit case
// selector. It does not establish a room identity or grant history permission.
func (f *AttachmentService) SelectedCaseContentWithin(ctx context.Context, tx pgx.Tx, selection AttachmentCaseSelection) (AttachmentContent, error) {
	empty := AttachmentContent{}
	if e := f.configured(); e != nil {
		return empty, e
	}
	if selection.AssertCase == nil {
		return empty, fail("attachment_unavailable", 404)
	}
	current := func() (Object, error) {
		selected, e := selection.AssertCase(ctx, tx)
		if e != nil {
			return nil, e
		}
		if str(selected, "roomId") != selection.RoomID || str(selected, "messageId") != selection.MessageID || num(selected, "revision") != selection.Revision {
			return nil, fail("attachment_unavailable", 404)
		}
		r, e := f.row(ctx, tx, selection.AttachmentID, false)
		if e != nil {
			return nil, e
		}
		if r == nil || str(r, "room_id") != selection.RoomID || str(r, "message_id") != selection.MessageID || f.status(r) != "available" {
			return nil, fail("attachment_content_unavailable", 404)
		}
		pending, e := f.authorPending(ctx, tx, r)
		if e != nil {
			return nil, e
		}
		if pending {
			return nil, fail("attachment_content_unavailable", 404)
		}
		if e = f.assertAccess(ctx, tx, str(r, "id")); e != nil {
			return nil, e
		}
		message, e := row(ctx, tx, "SELECT to_jsonb(m) FROM chat_message_refs m WHERE message_id=$1 AND room_id=$2 FOR SHARE", selection.MessageID, selection.RoomID)
		if e != nil {
			return nil, e
		}
		if message == nil || str(message, "state") != "accepted" || num(message, "revision") != selection.Revision || millis(message["expires_at"]) <= f.Chat.now().UnixMilli() {
			return nil, fail("attachment_message_unavailable", 404)
		}
		return r, nil
	}
	r, e := current()
	if e != nil {
		return empty, e
	}
	bytes, e := f.Store.Get(ctx, str(r, "storage_key"), str(r, "encryption_key_id"), num(r, "byte_size"))
	if e != nil {
		return empty, e
	}
	if bytes == nil || attachments.Digest(bytes) != str(r, "sha256") {
		return empty, fail("attachment_storage_integrity_failed", 502)
	}
	r, e = current()
	if e != nil {
		return empty, e
	}
	return AttachmentContent{Bytes: bytes, Name: str(r, "name"), MediaType: str(r, "media_type"), SHA256: str(r, "sha256"), AttachmentID: str(r, "id")}, nil
}
