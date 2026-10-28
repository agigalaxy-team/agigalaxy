package objectremoval

import (
	"context"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ReadStateWithin reads technical metadata only. The owning caller must first
// authorize its source; this lookup never qualifies removal or accesses storage.
func (s *Service) ReadStateWithin(ctx context.Context, tx pgx.Tx, domain, id string) (Object, error) {
	if domain != "chat" && domain != "forum" && domain != "outcome" {
		return nil, fail("not_found", 404)
	}
	if _, e := uuid.Parse(id); e != nil {
		return nil, fail("not_found", 404)
	}
	r, e := load(ctx, tx, s.Endpoint, Descriptor{Domain: domain, ObjectID: id}, false)
	if e != nil || r == nil {
		return nil, e
	}
	state := text(r, "state")
	var operation any
	if r["operation_id"] != nil {
		operation = r["operation_id"]
	}
	return Object{"state": state, "operationId": operation, "objectRemoved": state == "absent", "checkedAt": r["checked_at"], "completedAt": r["completed_at"]}, nil
}

// CleanupState preserves the existing business projection while exposing an
// unresolved removal as unknown rather than a fresh pending dispatch.
func CleanupState(metadata Object) string {
	switch text(metadata, "state") {
	case "absent":
		return "removed"
	case "reserved", "result-unknown", "legacy-unknown":
		return "result-unknown"
	default:
		return "pending"
	}
}
