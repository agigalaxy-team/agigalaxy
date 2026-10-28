package historyv2

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// SearchWithin is the original typed Search consumer, where omitted subject
// means all current-authorized candidates. Only the source router picks caseOnly.
func (s *Service) SearchWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, raw []byte, caseOnly bool) (Object, error) {
	o, e := ParseSearchQuery(raw)
	if e != nil {
		return nil, e
	}
	if a != nil {
		if s.Devices == nil {
			return nil, fault.New("history_unavailable", 503)
		}
		if e = s.Devices.AuthorizeWithin(ctx, tx, *a, "history"); e != nil {
			return nil, e
		}
	}
	if _, present := o.Values()["subjectId"]; !present {
		o.Set("subjectId", nil)
	}
	if caseOnly {
		o.Set("recordKind", "case-history")
	}
	return s.query(ctx, tx, a, o)
}

// SourceFingerprint grants no access; it retains the same visible-source bytes
// and material check-time exclusion used by the original History consumers.
func SourceFingerprint(v any) (string, error) { return fingerprint(v) }
func VisibleValue(v any) any                  { return visible(v) }
