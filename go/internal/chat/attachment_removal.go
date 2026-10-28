package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (f *AttachmentService) removalService() *objectremoval.Service {
	if f.Removals != nil {
		return f.Removals
	}
	return &objectremoval.Service{Pool: f.Chat.Pool, Endpoint: f.Chat.Endpoint, Now: f.Chat.now}
}
func chatRemovalDescriptor(r Object) objectremoval.Descriptor {
	return objectremoval.Descriptor{Domain: "chat", ObjectID: str(r, "id"), StorageKey: str(r, "storage_key"), KeyID: str(r, "encryption_key_id"), ByteSize: num(r, "byte_size"), SHA256: str(r, "sha256")}
}
func (f *AttachmentService) removeObject(ctx context.Context, id string) (Object, error) {
	removals := f.removalService()
	var claim *objectremoval.Reservation
	_, e := postgres.InTx(ctx, f.Chat.Pool, func(tx pgx.Tx) (Object, error) {
		r, e := f.row(ctx, tx, id, true)
		if e != nil {
			return nil, e
		}
		if r == nil || !truth(r, "purge_pending") || r["purged_at"] != nil || r["lease_until"] != nil && millis(r["lease_until"]) > f.Chat.now().UnixMilli() {
			return Object{}, nil
		}
		allowed, e := f.automatic(ctx, tx, r)
		if e != nil {
			return nil, e
		}
		barrier, e := filegovernance.AutomaticRemovalBarrierWithin(ctx, tx, f.Chat.Endpoint, "chat", id, f.Chat.now())
		if e != nil {
			return nil, e
		}
		if truth(barrier, "busy") {
			return Object{}, nil
		}
		legacy := true // Pre-ledger source flags cannot prove that no DELETE was sent.
		if !allowed && !legacy {
			status, e := removals.StatusWithin(ctx, tx, chatRemovalDescriptor(r))
			if e != nil {
				return nil, e
			}
			if status.State == "not-recorded" {
				return Object{}, nil
			}
		}
		if allowed {
			claim, e = removals.ReserveWithin(ctx, tx, chatRemovalDescriptor(r), legacy)
		} else {
			claim, e = removals.ObserveWithin(ctx, tx, chatRemovalDescriptor(r))
		}
		return Object{}, e
	})
	if e != nil {
		return nil, e
	}
	if claim == nil {
		return Object{}, nil
	}
	var external error
	result, e := postgres.InTx(ctx, f.Chat.Pool, func(tx pgx.Tx) (Object, error) {
		r, e := f.row(ctx, tx, id, true)
		if e != nil {
			return nil, e
		}
		if r == nil || !truth(r, "purge_pending") || r["purged_at"] != nil || r["lease_until"] != nil && millis(r["lease_until"]) > f.Chat.now().UnixMilli() {
			return Object{}, nil
		}
		allowed, e := f.automatic(ctx, tx, r)
		if e != nil {
			return nil, e
		}
		fresh := claim
		if !allowed {
			if _, e := removals.NotDispatchedWithin(ctx, tx, claim, ""); e != nil {
				return nil, e
			}
			fresh = nil
		}
		status, e := removals.ResolveWithin(ctx, tx, f.Store, chatRemovalDescriptor(r), fresh)
		if e != nil && status.State == "" {
			return nil, e
		}
		external = e
		if !status.ObjectRemoved {
			return Object{"pending": true}, nil
		}
		if _, e = tx.Exec(ctx, "UPDATE chat_attachments SET state='erased',name='',media_type='',purge_pending=false,purged_at=$2 WHERE id=$1", id, f.Chat.now()); e != nil {
			return nil, e
		}
		return Object{"removed": true}, nil
	})
	if _, markError := postgres.InTx(ctx, f.Chat.Pool, func(tx pgx.Tx) (bool, error) {
		code := ""
		if e != nil {
			code = "attachment_cleanup_not_dispatched"
		}
		return removals.NotDispatchedWithin(ctx, tx, claim, code)
	}); markError != nil && e == nil {
		return nil, markError
	}
	if e != nil {
		return nil, e
	}
	return result, external
}

// EraseSubject is called only after the lifecycle owner has committed its
// approved database phase. Unknown store operations remain pending and cannot
// be turned into another DELETE by repeating the lifecycle adapter.
func (f *AttachmentService) EraseSubject(ctx context.Context, subject string) (Object, error) {
	if !subjectPattern.MatchString(subject) {
		return nil, fail("invalid_chat_request", 400)
	}
	if e := f.configured(); e != nil {
		return nil, e
	}
	if !objectremoval.Capable(f.Store) {
		return nil, fail("attachment_cleanup_unavailable", 503)
	}
	if _, e := f.Chat.Pool.Exec(ctx, "UPDATE chat_attachments SET revoked_at=COALESCE(revoked_at,$2),purge_pending=true WHERE subject_id=$1 AND purged_at IS NULL", subject, f.Chat.now()); e != nil {
		return nil, e
	}
	r, e := postgres.InTx(ctx, f.Chat.Pool, func(tx pgx.Tx) ([]Object, error) {
		return rows(ctx, tx, "SELECT jsonb_build_object('id',id) FROM chat_attachments WHERE subject_id=$1 AND purge_pending=true AND purged_at IS NULL ORDER BY created_at LIMIT 100", subject)
	})
	if e != nil {
		return nil, e
	}
	for _, v := range r {
		if _, e = f.removeObject(ctx, str(v, "id")); e != nil {
			return nil, e
		}
	}
	var remaining int64
	if e = f.Chat.Pool.QueryRow(ctx, "SELECT count(*) FROM chat_attachments WHERE subject_id=$1 AND purged_at IS NULL", subject).Scan(&remaining); e != nil {
		return nil, e
	}
	return Object{"subjectId": subject, "pendingObjects": remaining, "complete": remaining == 0, "physicalBlockErasure": "storage-garbage-collection"}, nil
}
