package personalmcp

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/notifications"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (s Services) commonConsumers(out map[string]Consumer) {
	if p := s.Devices; p != nil {
		out["galaxy_consents_query"] = func(ctx context.Context, a deviceauth.Actor, q Object, _ *string) (any, error) {
			var after *string
			if v, ok := q["after"].(string); ok {
				after = &v
			}
			return p.ListConsents(ctx, a, after)
		}
		out["galaxy_consent_submit"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return postgres.InTx(ctx, p.Pool, func(tx pgx.Tx) (deviceauth.ConsentCapture, error) {
				return p.CaptureConsentWithin(ctx, tx, a, str(q, "signed"), deviceauth.ConsentOptions{HTTPRequestID: id})
			})
		}
		out["galaxy_consent_revoke"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.RevokeConsent(ctx, a, str(q, "id"), id)
		}
	}
	if p := s.Evidence; p != nil {
		rawWrite(out, "galaxy_evidence_submit", p.Submit)
		out["galaxy_evidence_get"] = func(ctx context.Context, a deviceauth.Actor, q Object, _ *string) (any, error) {
			return p.Get(ctx, a, str(q, "id"))
		}
	}
	if p := s.Proofs; p != nil {
		rawWrite(out, "galaxy_proof_submit", p.Publish)
		out["galaxy_proof_get"] = func(ctx context.Context, a deviceauth.Actor, q Object, _ *string) (any, error) {
			return p.Get(ctx, &a, str(q, "id"), false)
		}
		out["galaxy_proof_revoke"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.Revoke(ctx, a, str(q, "id"), requestID(id))
		}
	}
	if p := s.Inbox; p != nil {
		out["galaxy_inbox_query"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.Query(ctx, notifications.Actor{Actor: a, HTTPRequestID: id}, q)
		}
		out["galaxy_notifications_query"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.LegacyQuery(ctx, notifications.Actor{Actor: a, HTTPRequestID: id}, q)
		}
		out["galaxy_inbox_options"] = func(ctx context.Context, a deviceauth.Actor, _ Object, id *string) (any, error) {
			return p.Options(ctx, notifications.Actor{Actor: a, HTTPRequestID: id})
		}
		out["galaxy_inbox_options_save"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.SaveOptions(ctx, notifications.Actor{Actor: a, HTTPRequestID: id}, q)
		}
	}
	if p := s.LegacySearch; p != nil {
		out["galaxy_search_query"] = func(ctx context.Context, a deviceauth.Actor, q Object, _ *string) (any, error) {
			raw, e := rawInput(q)
			if e != nil {
				return nil, e
			}
			return p.QueryWire(ctx, &a, raw)
		}
	}
	if p := s.Opportunities; p != nil {
		out["galaxy_discovery_query"] = func(ctx context.Context, a deviceauth.Actor, q Object, _ *string) (any, error) {
			return p.QueryLegacy(ctx, &a, q)
		}
		out["galaxy_discovery_preferences"] = func(ctx context.Context, a deviceauth.Actor, _ Object, id *string) (any, error) {
			return p.Preferences(ctx, a, id)
		}
		out["galaxy_discovery_preferences_save"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.SavePreferences(ctx, a, q, id)
		}
	}
}
