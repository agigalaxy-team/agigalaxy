package operationscommunity

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// QualifyPublicExecutionWithin is the original scope.publicContent source
// qualification. The execution owner proves its prepared execution separately;
// this anonymous current-source fact never creates a write grant.
func (s *Service) QualifyPublicExecutionWithin(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	if e := s.ready(); e != nil {
		return nil, e
	}
	for _, kind := range []string{"post", "reply"} {
		source, e := s.Forum.OperationsContentSourceWithin(ctx, tx, kind, id, false)
		if e != nil {
			if fault.Status(e) == 404 {
				continue
			}
			return nil, e
		}
		if !yes(source, "candidate") || !yes(source, "available") {
			return nil, fail("operations_agentos_object_ineligible", 403)
		}
		head := obj(source, "head")
		version := head["head_version"]
		if kind == "reply" {
			version = head["revision"]
		}
		return Object{"kind": kind, "id": id, "version": version}, nil
	}
	return nil, nil
}
