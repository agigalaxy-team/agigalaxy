package chat

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// SummarySourceWithin is the original personal-summary metadata predicate.
// The summary owner supplies its already-authorized binding actor; no archive
// body is read and no publication permission or extra scope is introduced.
func (s *Service) SummarySourceWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, ref Object) (Object, error) {
	owner, e := actorRef(Actor{Device: &a})
	if e != nil {
		return nil, e
	}
	return s.summarySourceWithin(ctx, tx, owner, ref)
}

// SummaryErasureSourceWithin is restricted to maintenance of an already locked
// persistent owner fragment. It checks that owner's current metadata access;
// a subject reference is not promoted into a device credential or HTTP reader.
func (s *Service) SummaryErasureSourceWithin(ctx context.Context, tx pgx.Tx, ownerSubject string, ref Object) (Object, error) {
	if !subjectPattern.MatchString(ownerSubject) {
		return nil, fail("invalid_chat_request", 400)
	}
	return s.summarySourceWithin(ctx, tx, ownerSubject, ref)
}
func (s *Service) summarySourceWithin(ctx context.Context, tx pgx.Tx, ownerSubject string, ref Object) (Object, error) {
	no := Object{"available": false}
	if _, e := s.requireRoomRef(ctx, tx, ownerSubject, str(ref, "roomId"), true, false); e != nil {
		if fault.Status(e) == 403 || fault.Status(e) == 404 {
			return no, nil
		}
		return nil, e
	}
	if str(ref, "messageId") == "" {
		return Object{"available": true}, nil
	}
	r, e := row(ctx, tx, `SELECT jsonb_build_object('subject_id',m.subject_id,'state',m.state,'revision',m.revision,'expires_at',m.expires_at,'sequence',m.sequence::text,'edit_pending',EXISTS(SELECT 1 FROM chat_message_operations o WHERE o.message_id=m.message_id AND o.state='pending'),'author_pending',EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=m.subject_id AND d.state IN ('requested','review-needed','approved','partial','primary-erased')),'operations_blocked',`+operationsBlocked+`) FROM chat_message_refs m WHERE m.message_id=$1 AND m.room_id=$2 FOR SHARE OF m`, ref["messageId"], ref["roomId"])
	if e != nil {
		return nil, e
	}
	if r == nil || str(r, "state") != "accepted" || num(r, "revision") != num(ref, "revision") || millis(r["expires_at"]) <= s.now().UnixMilli() {
		return no, nil
	}
	if truth(r, "operations_blocked") || truth(r, "edit_pending") || truth(r, "author_pending") && str(r, "subject_id") != ownerSubject {
		return Object{"available": false, "temporarilyUnavailable": true}, nil
	}
	return Object{"available": true, "expiresAt": iso(r["expires_at"]), "authorId": r["subject_id"], "revision": r["revision"], "sequence": fmt.Sprint(r["sequence"])}, nil
}
