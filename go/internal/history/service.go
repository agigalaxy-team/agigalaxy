package history

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// AuthorizedSource returns an owning service's current-authorized wire view in
// this transaction. JSON order is retained for the original projectionHash;
// the source's signed bytes are never reconstructed from SQL metadata.
type AuthorizedSource func(context.Context, pgx.Tx, *deviceauth.Actor, string) (json.RawMessage, error)
type Service struct {
	Pool                                           *pgxpool.Pool
	Endpoint                                       string
	Devices                                        *deviceauth.Service
	Profiles                                       *profiles.Service
	Now                                            func() time.Time
	Proofs, CapsuleUses, Collaboration, Moderation AuthorizedSource
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func viewerID(a *deviceauth.Actor) any {
	if a == nil {
		return nil
	}
	return a.SubjectID
}
func scan(ctx context.Context, tx pgx.Tx, query string, args ...any) ([]Object, error) {
	rr, e := tx.Query(ctx, `SELECT row_to_json(r) FROM (`+query+`) r`, args...)
	if e != nil {
		return nil, e
	}
	defer rr.Close()
	out := []Object{}
	for rr.Next() {
		var raw []byte
		if e = rr.Scan(&raw); e != nil {
			return nil, e
		}
		v, e := orderedJSON(raw)
		if e != nil {
			return nil, e
		}
		out = append(out, obj(v))
	}
	return out, rr.Err()
}
func sourceView(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string, read AuthorizedSource) (any, error) {
	raw, e := read(ctx, tx, a, id)
	if e != nil {
		return nil, e
	}
	v, e := orderedJSON(raw)
	if e != nil || obj(v) == nil {
		return nil, fmt.Errorf("history authorized source returned invalid wire view")
	}
	return v, nil
}
func (s *Service) Query(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	if s.Pool == nil {
		return nil, fault.New("history_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return s.QueryCandidatesWithin(ctx, tx, a, raw, nil) })
}
func (s *Service) QueryWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, raw []byte) (Object, error) {
	return s.QueryCandidatesWithin(ctx, tx, a, raw, nil)
}
func (s *Service) QueryCandidatesWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, raw []byte, candidateIDs []string) (Object, error) {
	o, e := parse(raw)
	if e != nil {
		return nil, e
	}
	ownerFilter := o.SourceKind != nil || o.Environment != nil || o.CreatedFrom != nil || o.CreatedBefore != nil
	if ownerFilter && (a == nil || o.Subject == nil || *o.Subject != a.SubjectID) {
		return nil, fault.New("history_owner_filters_required", 403)
	}
	if s.Devices == nil {
		return nil, fault.New("history_unavailable", 503)
	}
	if a != nil {
		if e = s.Devices.AuthorizeWithin(ctx, tx, *a, "history"); e != nil {
			return nil, e
		}
	}
	derived := o.Capability != nil || o.Strength != nil
	candidateLimit := o.Limit + 1
	sqlLimit := candidateLimit
	if derived {
		candidateLimit = 200
		sqlLimit = 201
	}
	parents, e := scan(ctx, tx, parentSQL, o.Subject, o.After, viewerID(a), time.Unix(s.now(), 0), s.Endpoint, o.Terms, sqlLimit, o.Outcome, o.SourceKind, o.Environment, o.CreatedFrom, o.CreatedBefore, candidateIDs)
	if e != nil {
		return nil, e
	}
	items := []any{}
	var scannedAfter any
	for index, parent := range parents {
		if index == candidateLimit {
			break
		}
		scannedAfter = parent["id"]
		events, e := scan(ctx, tx, `SELECT * FROM case_events WHERE case_id=$1 ORDER BY version LIMIT 1001`, parent["id"])
		if e != nil {
			return nil, e
		}
		if len(events) > 1000 {
			return nil, fault.New("case_event_limit", 413)
		}
		allowed := true
		for _, row := range events {
			grant, e := s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: str(row, "consent_id"), SubjectID: str(parent, "subject_id"), Action: "case.teaser.publish", ObjectID: str(row, "id"), Recipient: s.Endpoint, PayloadJSON: str(row, "payload_text")})
			if e != nil {
				if fault.Code(e) != "internal_error" {
					allowed = false
					continue
				}
				return nil, e
			}
			if grant.IssuedAt > s.now() || grant.ExpiresAt <= s.now() || !canRead(grant, a) {
				allowed = false
			}
		}
		if !allowed {
			continue
		}
		linked, e := scan(ctx, tx, proofSQL, parent["id"], viewerID(a), time.Unix(s.now(), 0), s.Endpoint)
		if e != nil {
			return nil, e
		}
		proofs := []any{}
		for _, p := range linked {
			if s.Proofs == nil {
				return nil, fault.New("history_source_reader_unavailable", 503)
			}
			v, e := sourceView(ctx, tx, a, str(p, "id"), s.Proofs)
			if e != nil {
				if fault.Code(e) != "internal_error" {
					continue
				}
				return nil, e
			}
			proofs = append(proofs, v)
		}
		owned := a != nil && a.SubjectID == str(parent, "subject_id")
		item, e := projectCase(parent, events, owned, proofs)
		if e != nil {
			return nil, e
		}
		reuse, e := s.context(ctx, tx, a, str(parent, "id"), "capsule", s.CapsuleUses)
		if e != nil {
			return nil, e
		}
		if reuse != nil && len(array(obj(reuse)["items"])) > 0 {
			item.Set("capsuleReuse", reuse)
			projection := newObject()
			for _, k := range item.Keys() {
				if k != "projectionHash" {
					projection.Set(k, item.Values()[k])
				}
			}
			raw, e := protocol.EncodeJS(projection)
			if e != nil {
				return nil, e
			}
			item.Set("projectionHash", identity.Digest(raw))
		}
		collaboration, e := s.context(ctx, tx, a, str(parent, "id"), "collaboration", s.Collaboration)
		if e != nil {
			return nil, e
		}
		item.Set("collaborationContext", collaboration)
		item.Set("reportedProgress", progress(events))
		moderation, e := s.context(ctx, tx, a, str(parent, "id"), "moderation", s.Moderation)
		if e != nil {
			return nil, e
		}
		item.Set("moderationContext", moderation)
		view := "public"
		if a != nil {
			view = "authorized"
			if owned {
				view = "owner"
			}
		}
		visible := fieldPolicy(item, view)
		explanation := explanation(visible, o, s.now())
		if explanation == nil {
			continue
		}
		rebuild, e := rebuild(visible, events, s.Endpoint, view)
		if e != nil {
			return nil, e
		}
		visible.Set("rebuild", rebuild)
		visible.Set("searchExplanation", explanation)
		reasons := []string{}
		for _, term := range o.Terms {
			reasons = append(reasons, "title/summary contains: "+term)
		}
		for _, entry := range []struct {
			v      *string
			prefix string
		}{{o.Outcome, "reported outcome: "}, {o.SourceKind, "source kind: "}, {o.Environment, "attempt environment: "}, {o.CreatedFrom, "registered at or after: "}, {o.CreatedBefore, "registered before: "}, {o.Capability, "visible requested capability: "}, {o.Strength, "visible verification strength: "}} {
			if entry.v != nil {
				reasons = append(reasons, entry.prefix+*entry.v)
			}
		}
		if len(reasons) == 0 {
			reasons = []string{"case ID order"}
		}
		visible.Set("matchReasons", reasons)
		items = append(items, visible)
		if len(items) > o.Limit {
			break
		}
	}
	page := items
	if len(page) > o.Limit {
		page = page[:o.Limit]
	}
	windowLimited := len(items) <= o.Limit && len(parents) > candidateLimit
	var next any
	if len(items) > o.Limit {
		next = obj(page[len(page)-1])["caseId"]
	} else if windowLimited {
		next = scannedAfter
	}
	declaration := Object{"selfDeclared": Object{}}
	if o.Subject != nil && s.Profiles != nil {
		declaration, e = s.Profiles.ReadWithin(ctx, tx, a, *o.Subject)
		if e != nil {
			return nil, e
		}
	}
	view := "public"
	if a != nil {
		view = "authorized"
		if o.Subject != nil && *o.Subject == a.SubjectID {
			view = "owner"
		}
	}
	result := Object{"projectionVersion": 1, "subjectId": o.Subject, "derived": true, "view": view, "items": page, "nextCursor": next, "search": Object{"rule": "visible-history-rules@1", "order": "case-id", "windowLimited": windowLimited, "scanLimit": candidateLimit, "coverage": "current-page", "globalCountProvided": false}, "checkedAt": s.now(), "refresh": Object{"mode": "on-demand", "state": "rebuilt", "backgroundQueue": false, "checkedAt": s.now()}, "capabilityVerified": false}
	if windowLimited {
		obj(result["search"])["coverage"] = "bounded-visible-window; continue-with-cursor"
	}
	for k, v := range declaration {
		result[k] = v
	}
	results := 0
	allProofs := []any{}
	for _, item := range page {
		results += len(array(obj(item)["results"]))
		allProofs = append(allProofs, array(obj(item)["proofs"])...)
	}
	ci, e := summarizeCI(allProofs)
	if e != nil {
		return nil, e
	}
	result["pageSummary"] = Object{"cases": len(page), "results": results, "ciSources": ci}
	return result, nil
}
func canRead(v deviceauth.ConsentIntent, a *deviceauth.Actor) bool {
	who := ""
	if a != nil {
		who = a.SubjectID
	}
	if a != nil && who == v.SubjectID {
		return true
	}
	if v.CurrentVisibility != nil && v.CurrentVisibility.DeletionPending {
		return false
	}
	if v.Visibility == "Public" {
		return v.Purpose == "public-profile"
	}
	if v.Visibility == "Private" && a != nil {
		for _, viewer := range v.Viewers {
			if viewer == who {
				return true
			}
		}
	}
	return false
}

const parentSQL = `SELECT p.* FROM cases p JOIN case_events root ON root.case_id=p.id AND root.kind='case'
 WHERE ($1::text IS NULL OR p.subject_id=$1) AND ($2::uuid IS NULL OR p.id>$2) AND ($13::uuid[] IS NULL OR p.id=ANY($13))
 AND (p.subject_id=$3 OR p.state<>'withdrawn') AND ($9::text IS NULL OR root.payload->'source'->>'kind'=$9)
 AND ($10::text IS NULL OR EXISTS(SELECT 1 FROM case_events attempt WHERE attempt.case_id=p.id AND attempt.kind='attempt' AND lower(attempt.payload->'configuration'->>'environment')=lower($10)))
 AND ($11::timestamptz IS NULL OR p.created_at >= $11) AND ($12::timestamptz IS NULL OR p.created_at < $12)
 AND ($8::text IS NULL OR EXISTS(SELECT 1 FROM case_events result WHERE result.case_id=p.id AND result.kind='result' AND result.payload->>'outcome'=$8))
 AND NOT EXISTS(SELECT 1 FROM unnest($6::text[]) term WHERE strpos(lower((root.payload->>'title')||' '||(root.payload->>'summary')),term)=0)
 AND NOT EXISTS(SELECT 1 FROM case_events e LEFT JOIN consents c ON c.id=e.consent_id LEFT JOIN bindings b ON b.id=c.binding_id WHERE e.case_id=p.id AND
 (c.id IS NULL OR b.id IS NULL OR c.subject_id<>p.subject_id OR b.subject_id<>p.subject_id OR c.revoked_at IS NOT NULL OR b.revoked_at IS NOT NULL OR c.expires_at<=$4 OR b.expires_at<=$4
 OR c.intent->>'recipient'<>$5 OR c.intent->>'action'<>'case.teaser.publish' OR c.intent->>'objectId'<>e.id::text OR c.intent->>'payloadHash'<>e.payload_hash
 OR NOT(p.subject_id=COALESCE($3,'') OR (c.intent->>'visibility'='Public' AND c.intent->>'purpose'='public-profile') OR (c.intent->>'visibility'='Private' AND c.intent->'viewers' ? COALESCE($3,'')))))
 ORDER BY p.id LIMIT $7 FOR SHARE OF p`
const proofSQL = `SELECT p.id FROM proofs p JOIN evidence_submissions e ON e.id=p.evidence_id JOIN consents c ON c.id=p.consent_id JOIN bindings b ON b.id=c.binding_id
 WHERE e.case_id=$1 AND p.revoked_at IS NULL AND c.revoked_at IS NULL AND b.revoked_at IS NULL AND c.expires_at>$3 AND b.expires_at>$3 AND c.subject_id=p.subject_id AND b.subject_id=p.subject_id
 AND c.intent->>'recipient'=$4 AND c.intent->>'action'='proof.publish' AND c.intent->>'objectId'=p.id::text AND c.intent->>'payloadHash'=p.payload_hash
 AND (p.subject_id=$2 OR c.intent->>'visibility'='Public' AND c.intent->>'purpose'='public-profile' OR c.intent->>'visibility' IN ('Private','Proof-only') AND c.intent->'viewers' ? COALESCE($2,'')) ORDER BY p.id LIMIT 20`
