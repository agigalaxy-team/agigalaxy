package access

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
)

// AccountQuotaSession resolves the current real portal session without fetching
// its profile or linked identities. It grants no business access to the caller.
func (g *Gateway) AccountQuotaSession(r *http.Request) (accountID string, expiresAt int64, err error) {
	current, expiry, err := g.readAccountSession(r, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", 0, nil
	}
	if err != nil {
		return "", 0, err
	}
	return current.ID, expiry, nil
}

func (g *Gateway) AccountCookieName() string { return g.cookie("account") }
