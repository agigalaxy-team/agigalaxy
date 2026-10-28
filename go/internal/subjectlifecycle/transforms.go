package subjectlifecycle

import (
	"context"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Retention-only projections retain the original historical receipt and erase
// expired text. Live source authorization is supplied by the owning domain.
func (s *Service) transform(ctx context.Context, tx pgx.Tx, a Actor, name string, item Object) (Object, error) {
	if fn := s.Transforms[name]; fn != nil {
		return fn(ctx, tx, a, item, s.now())
	}
	expired := false
	camel := false
	at := s.now()
	switch name {
	case "task-materials", "forum-events", "forum-governance-events":
		return nil, unavailable()
	case "hub-events-v2":
		expired = strings.HasPrefix(text(item["kind"]), "intake-") && integer(item["expires_at"]) <= at
		camel = true
	case "qualification-request-events", "task-comment-events-v2", "context-grants-v2":
		expiry := stamp(item["expires_at"])
		expired = !expiry.IsZero() && expiry.Unix() <= at
	case "target-governance-events-v2", "comment-governance-events-v2":
		closed := stamp(item["closed_at"])
		expired = !closed.IsZero() && closed.Unix()+180*86400 <= at
	case "contact-events-v2":
		created := stamp(item["created_at"])
		expired = !created.IsZero() && created.Unix()+90*86400 <= at
	case "task-events":
		created := stamp(item["created_at"])
		expired = slices.Contains([]string{"suggest-contacts", "invite", "invitation-reply", "apply", "withdraw-application", "revoke-invitation"}, text(item["kind"])) && !created.IsZero() && created.Unix()+90*86400 <= at
	case "recruitment-opportunities", "contacts-v2":
		state := "active"
		if name == "contacts-v2" {
			state = "sent"
		}
		expiry := stamp(item["expires_at"])
		if text(item["state"]) == state && !expiry.IsZero() && expiry.Unix() <= at {
			item["state"] = "expired"
		}
	}
	if expired {
		item["payload_text"] = ""
		item["originalSignatureReverifiable"] = false
		if camel {
			item["contentExpired"] = true
		} else {
			item["content_expired"] = true
		}
	}
	return item, nil
}
