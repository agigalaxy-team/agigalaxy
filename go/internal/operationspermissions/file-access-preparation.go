package operationspermissions

import (
	"context"

	"github.com/jackc/pgx/v5"
)

func fileAccessPreparationReader(authority Authority) *preparationReader {
	if a, ok := authority.(*BusinessAuthority); ok && a != nil {
		authority = a.Human
	}
	p, _ := authority.(*preparationReader)
	if p == nil || p.service == nil {
		return nil
	}
	return p
}

// FileAccessPreparationReaderMatches recognizes only the server-owned reader
// and its original prepare proof; it does not authorize a write.
func FileAccessPreparationReaderMatches(authority Authority, actor Actor) bool {
	p := fileAccessPreparationReader(authority)
	return p != nil && p.AcceptsPreparation(actor)
}

// RequireConfirmedFileAccessWithin binds the prepared source to a fresh portal
// confirmation of the same person and fixed AI. Stored proofs cannot confirm.
func RequireConfirmedFileAccessWithin(ctx context.Context, tx pgx.Tx, authority Authority, original, confirmed Actor, action string) (Actor, error) {
	p := fileAccessPreparationReader(authority)
	if p == nil || !p.AcceptsPreparation(original) || !p.AcceptsPreparation(confirmed) || p.AcceptsStoredPreparation(confirmed) || (action != "files.access.stop" && action != "files.access.restore") {
		return Actor{}, fail("operations_agentos_scope_denied", 403)
	}
	o, e := p.service.humanContext(original)
	if e != nil {
		return Actor{}, e
	}
	c, e := p.service.humanContext(confirmed)
	if e != nil {
		return Actor{}, e
	}
	if o.owner != c.owner || o.operatorID != c.operatorID || o.endpoint != c.endpoint || o.domain != c.domain || o.accountID != c.accountID {
		return Actor{}, fail("operations_agentos_scope_denied", 403)
	}
	if _, e = p.RequireWithin(ctx, tx, original, "files.read"); e != nil {
		return Actor{}, e
	}
	if _, e = p.RequireWithin(ctx, tx, confirmed, "files.read"); e != nil {
		return Actor{}, e
	}
	fresh, e := p.RequireWithin(ctx, tx, confirmed, action)
	if e != nil {
		return Actor{}, e
	}
	if _, e = p.ReadScopedPrincipalWithin(ctx, tx, fresh); e != nil {
		return Actor{}, e
	}
	return fresh, nil
}
