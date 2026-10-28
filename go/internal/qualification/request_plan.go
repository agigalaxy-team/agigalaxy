package qualification

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

func sortRefs(refs []any) []any {
	out := append([]any{}, refs...)
	c := collate.New(language.English)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := object(out[i]), object(out[j])
		if n := c.CompareString(str(a, "kind"), str(b, "kind")); n != 0 {
			return n < 0
		}
		return c.CompareString(str(a, "id"), str(b, "id")) < 0
	})
	return out
}
func cleanRef(ref Object) Object {
	return Object{"kind": ref["kind"], "id": ref["id"], "eventVersion": ref["eventVersion"], "payloadHash": ref["payloadHash"]}
}
func cleanRefs(refs []any) []any {
	out := []any{}
	for _, v := range refs {
		out = append(out, cleanRef(object(v)))
	}
	return out
}
func sameCanonical(a, b any) (bool, error) {
	left, e := identity.Canonical(a)
	if e != nil {
		return false, e
	}
	right, e := identity.Canonical(b)
	return string(left) == string(right), e
}
func requestScopeHash(task, author string, refs []any) (string, error) {
	raw, e := identity.Canonical(Object{"taskId": task, "authorId": author, "sourceRefs": sortRefs(refs)})
	if e != nil {
		return "", e
	}
	return identity.Digest(raw), nil
}
func (s *Service) requestSourcesWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, input Object) (Object, error) {
	p, e := parsePlan(input)
	if e != nil {
		return nil, e
	}
	expires, _ := parseDatetime(p["expiresAt"])
	if expires.UnixMilli() <= s.now()*1000 || expires.UnixMilli() > (s.now()+29*86400)*1000 {
		return nil, fail("qualification_request_expiry_required")
	}
	if s.Assistance == nil {
		return nil, fail("qualification_assistance_unavailable", 503)
	}
	task, e := s.Assistance.RequireTaskWithin(ctx, tx, &a, str(p, "taskId"), false)
	if e != nil {
		return nil, e
	}
	request := object(object(task["snapshot"])["request"])
	ref := object(request["qualification"])
	if ref["profile"] != "facts-v2" {
		return nil, fail("qualification_scoped_profile_required", 422)
	}
	policy, e := s.PolicyWithin(ctx, tx, str(ref, "policyId"), str(ref, "policyVersion"), str(request, "capabilityId"), str(request, "collaboration"))
	if e != nil {
		return nil, e
	}
	seen := map[string]Object{}
	trace := &SourceTrace{ReadEventWithin: func(kind string, row Object) error {
		if row == nil || str(row, "payload_text") == "" {
			return fail("qualification_source_unavailable")
		}
		ref := Object{"kind": kind, "id": row["id"], "eventVersion": 1, "payloadHash": row["payload_hash"]}
		g, e := s.calculationSourceGrant(ctx, tx, ref, row)
		if e != nil {
			return e
		}
		if !s.Assistance.LegacySourceVisible(g, a.SubjectID) {
			return fail("qualification_candidate_source_unavailable", 403)
		}
		var payload Object
		if e = json.Unmarshal([]byte(str(row, "payload_text")), &payload); e != nil {
			return e
		}
		event := object(payload["event"])
		if event == nil {
			event = payload
		}
		label := event["kind"]
		if label == nil {
			label = "task-created"
		}
		ref["authorId"], ref["label"] = row["subject_id"], label
		seen[sourceKey(ref)] = ref
		return nil
	}}
	participations := []any{}
	pSeen := map[string]bool{}
	for _, v := range array(p["participationIds"]) {
		id := text(v)
		if pSeen[id] {
			continue
		}
		pSeen[id] = true
		participations = append(participations, id)
		result, e := s.participationWithin(ctx, tx, &a, id, a.SubjectID, policy, trace)
		if e != nil {
			return nil, e
		}
		if result["usable"] != true {
			return nil, fail("qualification_current_accepted_scope_required")
		}
	}
	refs := []any{}
	rSeen := map[string]bool{}
	for _, v := range array(p["externalReviewRefs"]) {
		r := object(v)
		raw, _ := identity.Canonical(r)
		key := string(raw)
		if !rSeen[key] {
			rSeen[key] = true
			refs = append(refs, r)
		}
	}
	c := collate.New(language.English)
	sort.SliceStable(refs, func(i, j int) bool {
		a, b := object(refs[i]), object(refs[j])
		if n := c.CompareString(str(a, "id"), str(b, "id")); n != 0 {
			return n < 0
		}
		return number(a["version"]) < number(b["version"])
	})
	if len(refs) > 0 && s.ReadExperienceCalculation == nil {
		return nil, fail("qualification_experience_review_unavailable", 503)
	}
	for _, v := range refs {
		result, e := s.externalReviewWithin(ctx, tx, a, object(v), a.SubjectID, policy, trace)
		if e != nil {
			return nil, e
		}
		if result["usable"] != true {
			return nil, fail("qualification_current_accepted_scope_required")
		}
	}
	sources := []any{}
	for _, source := range seen {
		sources = append(sources, source)
	}
	sources = sortRefs(sources)
	if len(sources) == 0 || len(sources) > 128 {
		return nil, fail("qualification_source_limit")
	}
	sort.SliceStable(participations, func(i, j int) bool { return text(participations[i]) < text(participations[j]) })
	return Object{"task": task, "candidateId": a.SubjectID, "recipientId": task["requesterId"], "sources": sources, "evidence": Object{"participationIds": participations, "externalReviewRefs": refs, "capsuleUseIds": []any{}, "proofIds": []any{}, "assistanceIds": []any{}}}, nil
}
func (s *Service) PlanRequestWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, input Object) (Object, error) {
	p, e := parsePlan(input)
	if e != nil {
		return nil, e
	}
	value, e := s.requestSourcesWithin(ctx, tx, a, p)
	if e != nil {
		return nil, e
	}
	own := []any{}
	foreign := []any{}
	for _, v := range array(value["sources"]) {
		if object(v)["authorId"] == a.SubjectID {
			own = append(own, v)
		} else {
			foreign = append(foreign, v)
		}
	}
	authors := []any{}
	seen := map[string]bool{}
	ready := true
	for _, v := range foreign {
		author := str(object(v), "authorId")
		if seen[author] {
			continue
		}
		seen[author] = true
		refs := []any{}
		materials := []any{}
		for _, v := range foreign {
			r := object(v)
			if r["authorId"] == author {
				refs = append(refs, v)
				materials = append(materials, Object{"id": r["id"], "kind": r["kind"], "label": r["label"]})
			}
		}
		clean := cleanRefs(refs)
		hash, e := requestScopeHash(str(p, "taskId"), author, clean)
		if e != nil {
			return nil, e
		}
		request, e := readRow(ctx, tx, "SELECT jsonb_build_object('id',id) FROM qualification_permission_requests WHERE subject_id=$1 AND source_author_id=$2 AND task_id=$3 AND scope_hash=$4 ORDER BY created_at DESC,id DESC LIMIT 1", a.SubjectID, author, p["taskId"], hash)
		if e != nil {
			return nil, e
		}
		grants, e := readRows(ctx, tx, "SELECT jsonb_build_object('id',id) FROM qualification_calculation_grants WHERE subject_id=$1 AND task_id=$2 ORDER BY created_at DESC,id DESC", author, p["taskId"])
		if e != nil {
			return nil, e
		}
		var permission Object
		for _, row := range grants {
			g, e := s.readCalculationWithin(ctx, tx, a, str(row, "id"))
			if e != nil {
				if !unavailable(e) {
					return nil, e
				}
				continue
			}
			payload := g.Payload
			gExpiry, _ := parseDatetime(payload["expiresAt"])
			pExpiry, _ := parseDatetime(p["expiresAt"])
			if payload["kind"] != "source-permission" || payload["candidateId"] != a.SubjectID || payload["recipientId"] != value["recipientId"] || gExpiry.UnixMilli() < pExpiry.UnixMilli() {
				continue
			}
			covered := map[string]bool{}
			for _, v := range array(payload["sourceRefs"]) {
				covered[sourceKey(object(v))] = true
			}
			all := true
			for _, v := range refs {
				all = all && covered[sourceKey(object(v))]
			}
			if !all {
				continue
			}
			compute := Object{}
			for k, v := range payload {
				compute[k] = v
			}
			compute["permissionIds"] = []any{row["id"]}
			if _, e = s.calculationPermissions(ctx, tx, a, compute); e != nil {
				if !unavailable(e) {
					return nil, e
				}
				continue
			}
			permission = Object{"id": row["id"], "expiresAt": payload["expiresAt"]}
			break
		}
		var requestView Object
		if request != nil {
			requestView, e = s.ReadRequestWithin(ctx, tx, a, Object{"requestId": request["id"]})
			if e != nil {
				if !unavailable(e) {
					return nil, e
				}
				requestView = nil
			}
		}
		if permission == nil {
			ready = false
		}
		authors = append(authors, Object{"sourceAuthorId": author, "sourceRefs": clean, "materials": materials, "permission": permission, "request": requestView})
	}
	common := Object{"taskId": p["taskId"], "candidateId": a.SubjectID, "recipientId": value["recipientId"], "purpose": calculationPurpose, "expiresAt": p["expiresAt"], "disclosure": calculationDisclosure}
	compute := Object{}
	for k, v := range common {
		compute[k] = v
	}
	permissions := []any{}
	for _, v := range authors {
		if permission := object(object(v)["permission"]); permission != nil {
			permissions = append(permissions, permission["id"])
		}
	}
	compute["kind"], compute["sourceRefs"], compute["permissionIds"], compute["evidence"] = "compute", cleanRefs(array(value["sources"])), permissions, value["evidence"]
	materials := []any{}
	for _, v := range own {
		r := object(v)
		materials = append(materials, Object{"id": r["id"], "kind": r["kind"], "label": r["label"]})
	}
	common["ownMaterials"], common["authors"], common["ready"], common["sourceReadGranted"], common["compute"] = materials, authors, ready, false, compute
	return common, nil
}
func (s *Service) PlanRequest(ctx context.Context, a Actor, input Object) (any, error) {
	return s.run(ctx, a, func(tx pgx.Tx) (any, error) { return s.PlanRequestWithin(ctx, tx, a.Actor, input) })
}
