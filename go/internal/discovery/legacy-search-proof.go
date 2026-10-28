package discovery

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

func (s *LegacySearch) proofQuery(ctx context.Context, a *deviceauth.Actor, q Object, candidates []string) (*protocol.OrderedObject, error) {
	if s.Pool == nil || s.Proofs == nil || s.Devices == nil {
		return nil, fail("search_source_unavailable")
	}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	var viewer any
	if a != nil {
		viewer = a.SubjectID
		if e = s.Devices.AuthorizeWithin(ctx, tx, *a, "proof"); e != nil {
			return nil, e
		}
	}
	rows, e := tx.Query(ctx, `SELECT p.id::text,p.payload_text FROM proofs p JOIN consents c ON c.id=p.consent_id JOIN bindings b ON b.id=c.binding_id WHERE ($1::uuid IS NULL OR p.id>$1) AND ($2::text IS NULL OR p.subject_id=$2) AND ($6::uuid[] IS NULL OR p.id=ANY($6)) AND p.revoked_at IS NULL AND c.revoked_at IS NULL AND b.revoked_at IS NULL AND c.expires_at>$4 AND b.expires_at>$4 AND c.subject_id=p.subject_id AND b.subject_id=p.subject_id AND c.intent->>'recipient'=$5 AND c.intent->>'action'='proof.publish' AND c.intent->>'objectId'=p.id::text AND c.intent->>'payloadHash'=p.payload_hash AND (p.subject_id=$3 OR c.intent->>'visibility'='Public' AND c.intent->>'purpose'='public-profile' OR c.intent->>'visibility' IN ('Private','Proof-only') AND c.intent->'viewers' ? COALESCE($3,'')) ORDER BY p.id LIMIT 201`, nullableString(str(q, "after")), nullableString(str(q, "subjectId")), viewer, time.Unix(s.now(), 0), s.Endpoint, candidates)
	if e != nil {
		return nil, e
	}
	type row struct{ id, payload string }
	found := []row{}
	for rows.Next() {
		var r row
		if e = rows.Scan(&r.id, &r.payload); e != nil {
			rows.Close()
			return nil, e
		}
		found = append(found, r)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	items := []any{}
	var last any
	limit, _ := integer(q["limit"])
	for _, r := range found[:min(200, len(found))] {
		wire, e := s.Proofs.ReadWireWithin(ctx, tx, a, r.id, false)
		if e != nil {
			var serviceError *fault.Error
			if errors.As(e, &serviceError) {
				continue
			}
			return nil, e
		}
		current, e := protocol.DecodeOrdered(wire)
		if e != nil {
			return nil, e
		}
		payload, e := protocol.DecodeOrdered([]byte(r.payload))
		if e != nil {
			return nil, e
		}
		p := values(payload)
		source := values(p["source"])
		last = r.id
		fields := ordered("repository", str(source, "owner")+"/"+str(source, "repository"), "commit", source["commit"], "runId", jsScalar(source["runId"]), "conclusion", p["conclusion"], "scope", p["scope"])
		reasons := []string{}
		matches := true
		for _, term := range legacyTerms(str(q, "query")) {
			keys := []string{}
			for _, key := range fields.Keys() {
				if strings.Contains(cases.Lower(language.English).String(jsScalar(fields.Values()[key])), term) {
					keys = append(keys, key)
				}
			}
			if len(keys) == 0 {
				matches = false
				break
			}
			reasons = append(reasons, term+" → "+strings.Join(keys, ", "))
		}
		if !matches || str(q, "conclusion") != "" && str(q, "conclusion") != str(p, "conclusion") {
			continue
		}
		if len(reasons) == 0 {
			reasons = append(reasons, "current visible Proof, source ID order")
		}
		record, ok := current.(*protocol.OrderedObject)
		if !ok {
			return nil, errors.New("search proof returned invalid wire view")
		}
		record.Set("assertion", payload)
		items = append(items, ordered("type", "proof", "id", r.id, "title", str(fields.Values(), "repository")+" · run "+str(fields.Values(), "runId"), "summary", p["conclusion"], "source", ordered("kind", "proof", "id", r.id, "evidenceId", p["evidenceId"], "observationId", p["observationId"], "reference", p["source"]), "record", record, "matchReasons", reasons, "limitations", p["limitations"], "capabilityVerified", false))
		if len(items) > int(limit) {
			break
		}
	}
	limited := len(items) <= int(limit) && len(found) > 200
	var next any
	if len(items) > int(limit) {
		items = items[:limit]
		next = values(items[len(items)-1])["id"]
	} else if limited {
		next = last
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	return s.page("proof", items, next, limited), nil
}
