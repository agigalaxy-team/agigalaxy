package operationspermissions

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// OriginalAIReceiptQueryReaderMatches recognizes only the service-owned query
// reader and its in-process human×fixed-AI query proof.
func OriginalAIReceiptQueryReaderMatches(authority Authority, actor Actor) bool {
	reader, ok := authority.(*queryReader)
	return ok && reader.AcceptsQuery(actor)
}

// WithOriginalAIReceiptReadWithin preserves the query proof and rechecks both
// intersected read permissions before and after the transaction-local callback.
func (s *Service) WithOriginalAIReceiptReadWithin(ctx context.Context, tx pgx.Tx, actor Actor, businessRead string, read func(Actor, Authority) (Object, error)) (Object, error) {
	if businessRead != "feedback.read" && businessRead != "content.read" && businessRead != "files.read" || read == nil {
		return nil, fail("operations_agentos_scope_denied", 403)
	}
	fresh, e := s.RequireQueryWithin(ctx, tx, actor, "autonomy.read")
	if e != nil {
		return nil, e
	}
	fresh, e = s.RequireQueryWithin(ctx, tx, fresh, businessRead)
	if e != nil {
		return nil, e
	}
	result, e := read(fresh, s.QueryReader())
	if e != nil {
		return nil, e
	}
	fresh, e = s.RequireQueryWithin(ctx, tx, fresh, "autonomy.read")
	if e != nil {
		return nil, e
	}
	if _, e = s.RequireQueryWithin(ctx, tx, fresh, businessRead); e != nil {
		return nil, e
	}
	return result, nil
}
