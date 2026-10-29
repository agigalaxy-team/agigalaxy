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

// QueryPrincipalAuthority proves an in-process query context before exposing
// the current human's locked identity metadata to an owning read domain.
// It grants neither an HTTP session nor authority for a write.
type QueryPrincipalAuthority interface {
	AcceptsQueryPrincipal(Actor) bool
	ReadQueryPrincipalWithin(context.Context, pgx.Tx, Actor) (map[string]string, error)
}

// StoredPreparationAuthority marks a durable person in the prepare-only
// context; it is never a confirmed human action authority.
type StoredPreparationAuthority interface {
	AcceptsStoredPreparation(Actor) bool
}

// ScopedPrincipalAuthority is a restricted read-context capability. Query and
// preparation proofs remain distinct; neither is an HTTP identity.
type ScopedPrincipalAuthority interface {
	AcceptsScopedPrincipal(Actor) bool
	ReadScopedPrincipalWithin(context.Context, pgx.Tx, Actor) (map[string]string, error)
}

type portalPrincipalReader interface {
	ReadOperationsPrincipalWithin(context.Context, pgx.Tx, Actor) (map[string]string, error)
}
type storedPrincipalReader interface {
	ReadStoredPersonPrincipalWithin(context.Context, pgx.Tx, string) (map[string]string, error)
}

func (q *queryReader) AcceptsQueryPrincipal(a Actor) bool { return q.AcceptsQuery(a) }

// ReadQueryPrincipalWithin rechecks the full current human × fixed-AI query
// proof before locking and returning the actual principal identity. A stored
// proof is resolved only by the configured current-person authority.
func (q *queryReader) ReadQueryPrincipalWithin(ctx context.Context, tx pgx.Tx, a Actor) (map[string]string, error) {
	if q == nil || q.service == nil || !q.AcceptsQuery(a) {
		return nil, fail("operations_agentos_scope_denied", 403)
	}
	return q.service.readScopedPrincipalWithin(ctx, tx, a, "query")
}

func (q *queryReader) AcceptsScopedPrincipal(a Actor) bool { return q.AcceptsQuery(a) }
func (q *queryReader) ReadScopedPrincipalWithin(ctx context.Context, tx pgx.Tx, a Actor) (map[string]string, error) {
	return q.ReadQueryPrincipalWithin(ctx, tx, a)
}

// readScopedPrincipalWithin verifies the exact fixed-AI purpose and its current
// authority before resolving the real person's principal under the row lock.
func (s *Service) readScopedPrincipalWithin(ctx context.Context, tx pgx.Tx, a Actor, purpose string) (map[string]string, error) {
	c, err := s.humanContext(a)
	if err != nil {
		return nil, err
	}
	if c.purpose != purpose || purpose != "query" && purpose != "prepare" {
		return nil, fail("operations_agentos_scope_denied", 403)
	}
	fresh, err := s.requireHumanAI(ctx, tx, a, "workbench.read")
	if err != nil {
		return nil, err
	}
	if _, stored := fresh.Proof.(*storedHumanProof); stored {
		reader, ok := s.StoredAuthority.(storedPrincipalReader)
		if !ok {
			return nil, fail("operations_authorization_unavailable", 503)
		}
		return reader.ReadStoredPersonPrincipalWithin(ctx, tx, fresh.ID)
	}
	reader, ok := s.Authority.(portalPrincipalReader)
	if !ok {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	return reader.ReadOperationsPrincipalWithin(ctx, tx, fresh)
}
