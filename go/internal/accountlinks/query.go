package accountlinks

import (
	"context"
	"errors"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (l *Links) Query(ctx context.Context, actor deviceauth.Actor, raw []byte) (Object, error) {
	var input struct {
		ID    *string `json:"id,omitempty"`
		After *string `json:"after,omitempty"`
		Limit *int    `json:"limit,omitempty"`
	}
	var fields map[string]any
	if decode(raw, &input) != nil || decode(raw, &fields) != nil {
		return nil, fault.New("invalid_request", 400)
	}
	for _, key := range []string{"id", "after", "limit"} {
		if v, ok := fields[key]; ok && v == nil {
			return nil, fault.New("invalid_request", 400)
		}
	}
	limit := 50
	if input.Limit != nil {
		limit = *input.Limit
	}
	if limit < 1 || limit > 100 || input.ID != nil && !validUUID(*input.ID) || input.After != nil && !validUUID(*input.After) {
		return nil, fault.New("invalid_request", 400)
	}
	tx, e := l.Registry.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if e = l.Registry.authorize(ctx, tx, actor); e != nil {
		return nil, e
	}
	rows, e := tx.Query(ctx, `SELECT l.id::text,l.subject_id,l.binding_id::text,l.endpoint,l.provider_id,l.issuer,l.external_subject,l.client_id,l.created_at,l.revoked_at,b.revoked_at,b.expires_at FROM external_identity_links l JOIN bindings b ON b.id=l.binding_id WHERE l.subject_id=$1 AND l.endpoint=$2 AND ($3::uuid IS NULL OR l.id>$3) AND ($5::uuid IS NULL OR l.id=$5) ORDER BY l.id LIMIT $4`, actor.SubjectID, l.Registry.Endpoint, input.After, limit+1, input.ID)
	if e != nil {
		return nil, e
	}
	items := []Object{}
	var next any
	for rows.Next() {
		var id, subject, binding, endpoint, provider, issuer, external, client string
		var created, expiry time.Time
		var revoked, bindingRevoked *time.Time
		if e = rows.Scan(&id, &subject, &binding, &endpoint, &provider, &issuer, &external, &client, &created, &revoked, &bindingRevoked, &expiry); e != nil {
			rows.Close()
			return nil, e
		}
		if len(items) == limit {
			next = items[len(items)-1]["id"]
			break
		}
		state := "linked"
		p := l.providers[provider]
		if revoked != nil {
			state = "revoked"
		} else if bindingRevoked != nil || expiry.Unix() <= l.Registry.now().Unix() {
			state = "binding-inactive"
		} else if p == nil || p.Describe().Issuer != issuer || p.Describe().ClientID != client {
			state = "provider-unavailable"
		}
		items = append(items, Object{"id": id, "subjectId": subject, "bindingId": binding, "endpoint": endpoint, "providerId": provider, "issuer": issuer, "externalSubject": external, "clientId": client, "createdAt": created.UTC().Format("2006-01-02T15:04:05.000Z"), "revokedAt": timeOrNil(revoked), "state": state, "galaxyAuthorization": false})
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return nil, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	return Object{"subjectId": actor.SubjectID, "endpoint": l.Registry.Endpoint, "items": items, "nextAfter": next}, nil
}
func timeOrNil(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
func (l *Links) Revoke(ctx context.Context, actor deviceauth.Actor, id string, httpID *string) (Object, error) {
	if !validUUID(id) {
		return nil, fault.New("invalid_request", 400)
	}
	return postgres.InTx(ctx, l.Registry.Pool, func(tx pgx.Tx) (Object, error) {
		control, e := l.Registry.Devices.CurrentControlWithin(ctx, tx, actor, "binding")
		if e != nil {
			return nil, e
		}
		var revoked *time.Time
		e = tx.QueryRow(ctx, "SELECT revoked_at FROM external_identity_links WHERE id=$1 AND subject_id=$2 AND endpoint=$3 FOR UPDATE", id, actor.SubjectID, l.Registry.Endpoint).Scan(&revoked)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, fault.New("not_found", 404)
		}
		if e != nil {
			return nil, e
		}
		if e = LockMappingsWithin(ctx, tx, l.Registry.Endpoint, []string{actor.SubjectID}, true); e != nil {
			return nil, e
		}
		if revoked == nil {
			if _, e = tx.Exec(ctx, "UPDATE external_identity_links SET revoked_at=$2 WHERE id=$1", id, l.Registry.now()); e != nil {
				return nil, e
			}
			if e = audit(ctx, tx, actor, id, "identity.unlink", httpID, control); e != nil {
				return nil, e
			}
		}
		return Object{"id": id, "state": "revoked", "galaxyAuthorization": false}, nil
	})
}
