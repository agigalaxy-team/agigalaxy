package personalaudit

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"math/big"
	"time"
)

func ordered(pairs ...any) *protocol.OrderedObject {
	o := protocol.NewOrderedObject()
	for i := 0; i < len(pairs); i += 2 {
		o.Set(pairs[i].(string), pairs[i+1])
	}
	return o
}
func (s *Service) Query(ctx context.Context, a Actor, input Object, action string) (any, error) {
	if action != "query" && action != "export" {
		return nil, fail("invalid_audit_action", 409)
	}
	q, e := parseQuery(input)
	if e != nil {
		return nil, e
	}
	selected := str(q, "subjectId")
	if selected == "" {
		selected = a.Device.SubjectID
	}
	return s.run(ctx, a, "audit", func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		var grant Object
		if selected != a.Device.SubjectID {
			var e error
			grant, e = s.requireGrant(ctx, tx, a, str(q, "grantId"), selected, action)
			if e != nil {
				return nil, e
			}
		}
		values := []any{selected, q["action"], q["objectId"], q["requestId"]}
		filter := `(a.actor=$1 OR EXISTS (SELECT 1 FROM bindings owned WHERE owned.id=a.binding_id AND owned.subject_id=$1)) AND ($2::text IS NULL OR a.action=$2) AND ($3::text IS NULL OR a.object_id=$3) AND ($4::uuid IS NULL OR a.http_request_id=$4)`
		upper := str(q, "through")
		if upper == "" {
			if e := tx.QueryRow(ctx, "SELECT COALESCE(max(a.sequence),0)::text FROM audit_events a WHERE "+filter, values...).Scan(&upper); e != nil {
				return nil, e
			}
		}
		after, _ := new(big.Int).SetString(str(q, "after"), 10)
		through, _ := new(big.Int).SetString(upper, 10)
		if after.Cmp(through) > 0 {
			return nil, fail("invalid_audit_cursor", 409)
		}
		columns := []string{"sequence", "actor", "action", "object_id", "request_id", "outcome", "created_at", "context_version", "client_id", "audience", "scope", "consent_id", "binding_id", "http_request_id", "idempotency_key", "binding_scopes", "credential_scopes", "caller_binding_id", "caller_client_id", "caller_audience", "caller_binding_scopes"}
		projection := "json_build_object("
		for i, k := range columns {
			if i > 0 {
				projection += ","
			}
			projection += "'" + k + "',a." + k
			if k == "sequence" {
				projection += "::text"
			}
		}
		projection += ")"
		limit, _ := integer(q["limit"])
		args := append(values, q["after"], upper, limit+1)
		rr, e := tx.Query(ctx, "SELECT "+projection+" FROM audit_events a WHERE "+filter+" AND a.sequence>$5::bigint AND a.sequence<=$6::bigint ORDER BY a.sequence LIMIT $7", args...)
		if e != nil {
			return nil, e
		}
		items := []any{}
		more := false
		for rr.Next() {
			var raw []byte
			if e = rr.Scan(&raw); e != nil {
				rr.Close()
				return nil, e
			}
			if int64(len(items)) >= limit {
				more = true
				continue
			}
			v, e := protocol.DecodeOrdered(raw)
			if e != nil {
				rr.Close()
				return nil, e
			}
			item, ok := v.(*protocol.OrderedObject)
			if !ok {
				rr.Close()
				return nil, fail("audit_context_unavailable", 503)
			}
			t, e := time.Parse(time.RFC3339Nano, str(item.Values(), "created_at"))
			if e != nil {
				rr.Close()
				return nil, e
			}
			item.Set("created_at", t.UTC().Format("2006-01-02T15:04:05.000Z"))
			items = append(items, item)
		}
		e = rr.Err()
		rr.Close()
		if e != nil {
			return nil, e
		}
		queryID := uuid.NewString()
		var next, grantID any
		if more && len(items) > 0 {
			next = items[len(items)-1].(*protocol.OrderedObject).Values()["sequence"]
		}
		if grant != nil {
			grantID = grant["id"]
		}
		selection := protocol.NewOrderedObject()
		for _, key := range []string{"subjectId", "grantId", "action", "objectId", "requestId", "after", "through", "limit"} {
			if v, ok := q[key]; ok {
				selection.Set(key, v)
			}
		}
		selection.Set("subjectId", selected)
		selection.Set("through", upper)
		selection.Set("grantId", grantID)
		view := "owner"
		if grant != nil {
			view = "approved-reader"
		}
		snapshot := ordered("version", 1, "endpoint", s.Endpoint, "queryId", queryID, "subjectId", selected, "grantId", grantID, "action", action, "selection", selection, "items", items, "through", upper, "nextAfter", next, "checkedAt", s.now(), "view", view, "metadataOnly", true)
		wire, e := protocol.EncodeJS(snapshot)
		if e != nil {
			return nil, e
		}
		hash := identity.Digest(wire)
		selectionJSON, e := protocol.EncodeJS(selection)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO audit_reads(id,actor_id,subject_id,grant_id,action,selection,result_hash,result_count,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`, queryID, a.Device.SubjectID, selected, grantID, action, selectionJSON, hash, len(items), time.Unix(s.now(), 0)); e != nil {
			return nil, e
		}
		if e = s.record(ctx, tx, a, auth, "audit."+action, queryID, "audit"); e != nil {
			return nil, e
		}
		snapshot.Set("sha256", hash)
		if action == "export" {
			snapshot.Set("filename", "galaxy-audit-"+queryID+".json")
			snapshot.Set("mediaType", "application/json")
		}
		return snapshot, nil
	})
}
