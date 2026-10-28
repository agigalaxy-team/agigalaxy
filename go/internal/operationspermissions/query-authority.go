package operationspermissions

import (
	"context"
	"github.com/jackc/pgx/v5"
	"net/http"
)

// RequireQueryWithin rechecks the original in-process human×fixed-AI query
// context. It cannot turn a caller-supplied actor or an execution/duty proof into
// a reader, and retains the same current role intersection and proof owner.
func (s *Service) RequireQueryWithin(ctx context.Context, tx pgx.Tx, actor Actor, action string) (Actor, error) {
	c, e := s.humanContext(actor)
	if e != nil {
		return Actor{}, e
	}
	if c.purpose != "query" {
		return Actor{}, fail("operations_agentos_scope_denied", 403)
	}
	return s.requireHumanAI(ctx, tx, actor, action)
}

type queryReader struct{ service *Service }

// QueryReader is a server-bound read authority for real typed-query consumers.
// It never authenticates an HTTP request or loads an arbitrary stored person.
func (s *Service) QueryReader() Authority { return &queryReader{service: s} }
func (q *queryReader) AcceptsQuery(a Actor) bool {
	if q == nil || q.service == nil {
		return false
	}
	c, e := q.service.humanContext(a)
	return e == nil && c.purpose == "query"
}
func (q *queryReader) RequireWithin(ctx context.Context, tx pgx.Tx, a Actor, action string) (Actor, error) {
	return q.service.RequireQueryWithin(ctx, tx, a, action)
}
func (q *queryReader) EffectiveWithin(ctx context.Context, tx pgx.Tx, a Actor) (Actor, error) {
	return q.service.RequireQueryWithin(ctx, tx, a, "workbench.read")
}
func (q *queryReader) PersonWithin(context.Context, pgx.Tx, string, bool) (Actor, error) {
	return Actor{}, fail("operations_permission_denied", 403)
}
func (q *queryReader) AuthorizeOperations(*http.Request, bool, string) (Actor, error) {
	return Actor{}, fail("operations_permission_denied", 403)
}
