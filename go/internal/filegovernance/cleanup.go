package filegovernance

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"sort"
	"strings"
)

func faultStatus(e error) int { return fault.Status(e) }
func uuidNew() string         { return uuid.NewString() }

type cleanupStore interface {
	Head(context.Context, string, string) (*attachments.Head, error)
	Erase(context.Context, string) error
}

func (s *Service) cleanupCaps(a Actor) Object {
	return Object{"canCreate": has(a.Permissions, "files.cleanup.plan"), "canApprove": has(a.Permissions, "files.cleanup.approve"), "canCancel": has(a.Permissions, "files.cleanup.plan")}
}
func (s *Service) facts(ctx context.Context, tx pgx.Tx, kind string, r Object, lock bool, planID string) (Object, error) {
	if planID != "" {
		if _, e := tx.Exec(ctx, "SELECT public.galaxy_worker_lock_file_cleanup_sources($1,$2,$3,$4)", s.Endpoint, planID, kind, r["id"]); e != nil {
			return nil, e
		}
	}
	source, e := CleanupSourceWithin(ctx, tx, kind, r, s.now(), lock)
	if e != nil {
		return nil, e
	}
	return Object{"source": source, "eligibility": CleanupEligibility(r, source, s.now())}, nil
}
func (s *Service) candidate(kind string, r, facts Object) Object {
	adapter, _ := s.adapter(kind, false)
	available := false
	if adapter != nil {
		_, available = adapter.Store.(cleanupStore)
	}
	source, eligibility := obj(facts, "source"), obj(facts, "eligibility")
	blocked := eligibility["blockedReason"]
	if blocked == nil && !available {
		blocked = "storage-unavailable"
	}
	refs, _ := source["references"].([]Object)
	return Object{"kind": kind, "id": r["id"], "name": cleanupName(r["name"]), "size": num(r, "byte_size"), "expectedVersion": ProcessingVersion(r), "expiresAt": iso(expiry(r)), "reason": eligibility["reason"], "referenceCount": len(refs), "activeReferences": source["activeReferences"], "eligible": truth(eligibility, "eligible") && available, "blockedReason": blocked}
}
func cleanupQuery(input Object, plans bool) (Object, error) {
	q := Object{}
	for k, v := range input {
		q[k] = v
	}
	keys := []string{"after", "limit"}
	if !plans {
		keys = append(keys, "kind")
	}
	if !exact(q, keys...) {
		return nil, invalid()
	}
	if _, ok := q["limit"]; !ok {
		q["limit"] = 25
	}
	if !integer(q["limit"], 1, 50) {
		return nil, invalid()
	}
	if _, ok := q["kind"]; ok && !has([]string{"chat", "forum"}, str(q, "kind")) {
		return nil, invalid()
	}
	if _, ok := q["after"]; ok {
		if plans {
			if !fileUUID.MatchString(str(q, "after")) {
				return nil, invalid()
			}
		} else {
			parts := strings.Split(str(q, "after"), ":")
			if len(parts) != 2 || !has([]string{"chat", "forum"}, parts[0]) || !fileUUID.MatchString(parts[1]) {
				return nil, invalid()
			}
		}
	}
	return q, nil
}
func (s *Service) CleanupCandidates(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := cleanupQuery(input, false)
	if e != nil {
		return nil, e
	}
	selection := Object{"view": "candidates"}
	for k, v := range q {
		selection[k] = v
	}
	return s.run(ctx, a, "file-cleanup-read", selection, func(tx pgx.Tx, current Actor) (Object, error) {
		var afterID, afterKind any
		if str(q, "after") != "" {
			parts := strings.Split(str(q, "after"), ":")
			afterKind, afterID = parts[0], parts[1]
		}
		rr, e := rows(ctx, tx, `WITH files AS(SELECT a.id,'chat'::text AS kind FROM chat_attachments a WHERE a.purged_at IS NULL AND (a.subject_id NOT LIKE 'account:%' OR EXISTS(SELECT 1 FROM community_accounts o WHERE 'account:'||o.id::text=a.subject_id AND o.endpoint=$1)) AND (a.purge_pending OR COALESCE(a.expires_at,a.prepare_expires_at)<=$2)
   UNION ALL SELECT a.id,'forum'::text AS kind FROM forum_attachments_v1 a JOIN community_accounts o ON o.id=a.account_id AND o.endpoint=$1 WHERE a.purged_at IS NULL AND (a.purge_pending OR COALESCE(a.expires_at,a.prepare_expires_at)<=$2 OR a.published_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM forum_attachment_links_v1 l JOIN forum_posts_v1 p ON p.id=l.post_id JOIN forum_versions_v1 v ON v.id=l.version_id LEFT JOIN forum_replies_v1 r ON r.id=l.reply_id WHERE l.attachment_id=a.id AND l.published_until>$2 AND p.state='published' AND v.state='published' AND (l.reply_id IS NULL OR r.state='published'))))
   SELECT to_jsonb(f) FROM files f WHERE ($3::text IS NULL OR kind=$3) AND ($4::uuid IS NULL OR (id,kind)>($4::uuid,$5::text)) ORDER BY id,kind LIMIT $6`, s.Endpoint, s.stamp(), q["kind"], afterID, afterKind, num(q, "limit")+1)
		if e != nil {
			return nil, e
		}
		limit := int(num(q, "limit"))
		selected := rr
		if len(selected) > limit {
			selected = selected[:limit]
		}
		items := []Object{}
		for _, item := range selected {
			kind := str(item, "kind")
			r, e := s.scopedRow(ctx, tx, kind, str(item, "id"), false)
			if e != nil {
				return nil, e
			}
			facts, e := s.facts(ctx, tx, kind, r, false, "")
			if e != nil {
				return nil, e
			}
			if str(obj(facts, "eligibility"), "category") == "operational" {
				items = append(items, s.candidate(kind, r, facts))
			}
		}
		var next any
		if len(rr) > limit {
			last := selected[len(selected)-1]
			next = str(last, "kind") + ":" + str(last, "id")
		}
		out := s.readMeta()
		out["items"], out["nextAfter"], out["permissions"] = items, next, s.cleanupCaps(current)
		return out, nil
	})
}
func (s *Service) planRow(ctx context.Context, tx pgx.Tx, id string, write bool) (Object, error) {
	if !fileUUID.MatchString(id) {
		return nil, invalid()
	}
	suffix := " FOR SHARE"
	if write {
		suffix = " FOR UPDATE"
	}
	r, e := row(ctx, tx, "SELECT to_jsonb(p) FROM operations_file_cleanup_plans_v1 p WHERE endpoint=$1 AND id=$2"+suffix, s.Endpoint, id)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, fail("operations_file_cleanup_plan_not_found", 404)
	}
	return r, nil
}
func (s *Service) planView(ctx context.Context, tx pgx.Tx, r Object, a Actor, includeItems bool) (Object, error) {
	names, e := s.NamesWithin(ctx, tx, []string{str(r, "created_by"), str(r, "approved_by"), str(r, "cancelled_by")})
	if e != nil {
		return nil, e
	}
	counts, e := rows(ctx, tx, "SELECT to_jsonb(q) FROM (SELECT state,count(*)::integer AS n FROM operations_file_cleanup_items_v1 WHERE plan_id=$1 GROUP BY state)q", r["id"])
	if e != nil {
		return nil, e
	}
	countMap := Object{}
	for _, state := range []string{"pending", "removing", "removed", "skipped", "result-unknown"} {
		countMap[state] = 0
	}
	for _, count := range counts {
		countMap[str(count, "state")] = count["n"]
	}
	person := func(key string) any {
		if str(r, key) == "" {
			return nil
		}
		return Object{"operatorId": r[key], "displayName": names[str(r, key)]}
	}
	out := Object{"id": r["id"], "revision": r["revision"], "state": r["state"], "createdAt": iso(r["created_at"]), "createdBy": person("created_by"), "approvedAt": iso(r["approved_at"]), "approvedBy": person("approved_by"), "cancelledAt": iso(r["cancelled_at"]), "completedAt": iso(r["completed_at"]), "reason": r["reason"], "itemCount": r["item_count"], "declaredBytes": num(r, "declared_bytes"), "counts": countMap, "permissions": Object{"canApprove": str(r, "state") == "awaiting-approval" && has(a.Permissions, "files.cleanup.approve"), "canCancel": has([]string{"awaiting-approval", "queued", "running", "attention"}, str(r, "state")) && has(a.Permissions, "files.cleanup.plan")}, "impact": Object{"serverCopyRemoval": true, "restorationAvailable": false, "physicalBlocksReleased": nil}}
	for k, v := range s.readMeta() {
		out[k] = v
	}
	if includeItems {
		rr, e := rows(ctx, tx, "SELECT to_jsonb(i) FROM operations_file_cleanup_items_v1 i WHERE plan_id=$1 ORDER BY position", r["id"])
		if e != nil {
			return nil, e
		}
		items := []Object{}
		for _, item := range rr {
			current, e := s.scopedRow(ctx, tx, str(item, "kind"), str(item, "file_id"), false)
			if e != nil && !(faultStatus(e) == 404) {
				return nil, e
			}
			var currentState any
			if current != nil {
				currentState = current["state"]
				if current["purged_at"] != nil {
					currentState = "erased"
				}
			}
			source := obj(item, "reference_state")
			var referenceCount any
			if refs, ok := source["references"].([]any); ok {
				referenceCount = len(refs)
			}
			items = append(items, Object{"kind": item["kind"], "id": item["file_id"], "name": cleanupName(current["name"]), "size": num(item, "byte_size"), "reason": item["reason"], "expiresAt": iso(item["expires_at"]), "referenceCount": referenceCount, "activeReferences": source["activeReferences"], "state": item["state"], "attemptCount": item["attempt_count"], "resultCode": item["result_code"], "objectRemoved": item["object_removed"], "completedAt": iso(item["completed_at"]), "currentState": currentState})
		}
		out["items"] = items
	}
	return out, nil
}
func (s *Service) CleanupPlans(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := cleanupQuery(input, true)
	if e != nil {
		return nil, e
	}
	selection := Object{"view": "plans"}
	for k, v := range q {
		selection[k] = v
	}
	return s.run(ctx, a, "file-cleanup-read", selection, func(tx pgx.Tx, current Actor) (Object, error) {
		rr, e := rows(ctx, tx, "SELECT to_jsonb(p) FROM operations_file_cleanup_plans_v1 p WHERE endpoint=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3", s.Endpoint, q["after"], num(q, "limit")+1)
		if e != nil {
			return nil, e
		}
		limit := int(num(q, "limit"))
		selected := rr
		if len(selected) > limit {
			selected = selected[:limit]
		}
		items := []Object{}
		for _, r := range selected {
			view, e := s.planView(ctx, tx, r, current, false)
			if e != nil {
				return nil, e
			}
			items = append(items, view)
		}
		var next any
		if len(rr) > limit {
			next = selected[len(selected)-1]["id"]
		}
		out := s.readMeta()
		out["items"], out["nextAfter"], out["permissions"] = items, next, s.cleanupCaps(current)
		return out, nil
	})
}
func (s *Service) CleanupPlan(ctx context.Context, a Actor, id string) (Object, error) {
	return s.run(ctx, a, "file-cleanup-read", Object{"view": "plan", "id": id}, func(tx pgx.Tx, current Actor) (Object, error) {
		r, e := s.planRow(ctx, tx, id, false)
		if e != nil {
			return nil, e
		}
		return s.planView(ctx, tx, r, current, true)
	})
}
func (s *Service) CleanupOperation(ctx context.Context, a Actor, operation string) (Object, error) {
	if !fileUUID.MatchString(operation) {
		return nil, invalid()
	}
	return s.run(ctx, a, "file-cleanup-read", Object{"view": "operation", "id": operation}, func(tx pgx.Tx, current Actor) (Object, error) {
		r, e := row(ctx, tx, "SELECT to_jsonb(q) FROM (SELECT action,result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2 AND operator_id=$3 AND action IN('file-cleanup-create','file-cleanup-approve','file-cleanup-cancel'))q", s.Endpoint, operation, current.ID)
		if e != nil {
			return nil, e
		}
		out := s.readMeta()
		out["state"], out["operationId"] = "not-recorded", operation
		if r != nil {
			out["state"], out["kind"], out["planId"] = "recorded", strings.TrimPrefix(str(r, "action"), "file-cleanup-"), obj(r, "result")["planId"]
		}
		return out, nil
	})
}
func ParseCleanupCreate(input Object) (Object, error) {
	x := Object{}
	for k, v := range input {
		x[k] = v
	}
	if !exact(x, "operationId", "items", "reason") || !fileUUID.MatchString(str(x, "operationId")) {
		return nil, invalid()
	}
	if _, ok := x["reason"]; !ok {
		x["reason"] = ""
	}
	if !text(x, "reason", 0, 1600, true) {
		return nil, invalid()
	}
	items, ok := x["items"].([]any)
	if !ok || len(items) < 1 || len(items) > 50 {
		return nil, invalid()
	}
	seen := map[string]bool{}
	for _, value := range items {
		item, ok := value.(map[string]any)
		if !ok || !exact(item, "kind", "id", "expectedVersion") || !has([]string{"chat", "forum"}, str(item, "kind")) || !fileUUID.MatchString(str(item, "id")) || !text(item, "expectedVersion", 1, 4096, false) {
			return nil, invalid()
		}
		key := str(item, "kind") + ":" + str(item, "id")
		if seen[key] {
			return nil, invalid()
		}
		seen[key] = true
	}
	return x, nil
}
func same(a, b any) (bool, error) {
	left, e := identity.Canonical(a)
	if e != nil {
		return false, e
	}
	right, e := identity.Canonical(b)
	return string(left) == string(right), e
}
func (s *Service) CreateCleanup(ctx context.Context, a Actor, input Object) (Object, error) {
	if s.isDuty(a) {
		return nil, fail("operations_permission_denied", 403)
	}
	x, e := ParseCleanupCreate(input)
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, a, "files.cleanup.plan"); e != nil {
		return nil, e
	}
	receipt, e := s.command(ctx, a, "file-cleanup-create", Object{"operationId": x["operationId"], "command": x}, func(tx pgx.Tx, _ Actor) (Object, error) {
		if _, e := s.fresh(ctx, tx, a, "files.cleanup.plan"); e != nil {
			return nil, e
		}
		items := append([]any{}, x["items"].([]any)...)
		sort.Slice(items, func(i, j int) bool {
			left, right := items[i].(map[string]any), items[j].(map[string]any)
			return str(left, "kind")+":"+str(left, "id") < str(right, "kind")+":"+str(right, "id")
		})
		planned := []Object{}
		total := int64(0)
		for _, value := range items {
			item := value.(map[string]any)
			kind := str(item, "kind")
			r, e := s.scopedRow(ctx, tx, kind, str(item, "id"), false)
			if e != nil {
				return nil, e
			}
			facts, e := s.facts(ctx, tx, kind, r, false, "")
			if e != nil {
				return nil, e
			}
			if ProcessingVersion(r) != str(item, "expectedVersion") {
				return nil, fail("operations_file_changed", 409)
			}
			if !truth(s.candidate(kind, r, facts), "eligible") {
				return nil, fail("operations_file_cleanup_ineligible", 409)
			}
			total += num(r, "byte_size")
			if total > 9007199254740991 {
				return nil, fail("operations_file_cleanup_size_unavailable", 409)
			}
			planned = append(planned, Object{"item": item, "row": r, "facts": facts})
		}
		planID := uuidNew()
		if _, e = tx.Exec(ctx, "INSERT INTO operations_file_cleanup_plans_v1(id,endpoint,revision,state,created_by,created_at,reason,item_count,declared_bytes) VALUES($1,$2,1,'awaiting-approval',$3,$4,$5,$6,$7)", planID, s.Endpoint, a.ID, s.stamp(), x["reason"], len(planned), total); e != nil {
			return nil, e
		}
		for position, value := range planned {
			item, r, facts := obj(value, "item"), obj(value, "row"), obj(value, "facts")
			if _, e = tx.Exec(ctx, "INSERT INTO operations_file_cleanup_items_v1(plan_id,position,kind,file_id,expected_version,reference_state,reason,byte_size,expires_at,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')", planID, position, item["kind"], item["id"], ProcessingVersion(r), encode(facts["source"]), obj(facts, "eligibility")["reason"], num(r, "byte_size"), timestamp(expiry(r))); e != nil {
				return nil, e
			}
		}
		if _, e = s.fresh(ctx, tx, a, "files.cleanup.plan"); e != nil {
			return nil, e
		}
		return Object{"planId": planID, "kind": "create", "state": "awaiting-approval"}, nil
	})
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, a, "files.cleanup.plan"); e != nil {
		return nil, e
	}
	receipt["plan"], e = s.CleanupPlan(ctx, a, str(receipt, "planId"))
	return receipt, e
}
func (s *Service) ApproveCleanup(ctx context.Context, a Actor, id string, input Object) (Object, error) {
	return s.cleanupDecision(ctx, a, id, input, true)
}
func (s *Service) CancelCleanup(ctx context.Context, a Actor, id string, input Object) (Object, error) {
	return s.cleanupDecision(ctx, a, id, input, false)
}
func (s *Service) cleanupDecision(ctx context.Context, a Actor, id string, x Object, approve bool) (Object, error) {
	if s.isDuty(a) {
		return nil, fail("operations_permission_denied", 403)
	}
	if !exact(x, "operationId", "expectedRevision") || !fileUUID.MatchString(str(x, "operationId")) || !integer(x["expectedRevision"], 1, 9007199254740991) || !fileUUID.MatchString(id) {
		return nil, invalid()
	}
	kind, action := "cancel", "files.cleanup.plan"
	if approve {
		kind, action = "approve", "files.cleanup.approve"
	}
	if _, e := s.current(ctx, a, action); e != nil {
		return nil, e
	}
	receipt, e := s.command(ctx, a, "file-cleanup-"+kind, Object{"operationId": x["operationId"], "id": id, "command": x}, func(tx pgx.Tx, current Actor) (Object, error) {
		if _, e := s.fresh(ctx, tx, a, action); e != nil {
			return nil, e
		}
		plan, e := s.planRow(ctx, tx, id, true)
		if e != nil {
			return nil, e
		}
		if num(plan, "revision") != num(x, "expectedRevision") {
			return nil, fail("operations_file_cleanup_plan_changed", 409)
		}
		if approve {
			if str(plan, "state") != "awaiting-approval" {
				return nil, fail("operations_file_cleanup_plan_state", 409)
			}
			items, e := rows(ctx, tx, "SELECT to_jsonb(i) FROM operations_file_cleanup_items_v1 i WHERE plan_id=$1 ORDER BY kind,file_id", id)
			if e != nil {
				return nil, e
			}
			for _, item := range items {
				r, e := s.scopedRow(ctx, tx, str(item, "kind"), str(item, "file_id"), false)
				if e != nil {
					return nil, e
				}
				facts, e := s.facts(ctx, tx, str(item, "kind"), r, false, "")
				if e != nil {
					return nil, e
				}
				equal, e := same(facts["source"], item["reference_state"])
				if e != nil {
					return nil, e
				}
				if ProcessingVersion(r) != str(item, "expected_version") || !equal || !truth(obj(facts, "eligibility"), "eligible") || obj(facts, "eligibility")["reason"] != item["reason"] {
					return nil, fail("operations_file_cleanup_plan_changed", 409)
				}
			}
			if _, e = tx.Exec(ctx, "UPDATE operations_file_cleanup_plans_v1 SET state='queued',revision=revision+1,approved_by=$2,approved_at=$3 WHERE id=$1", id, current.ID, s.stamp()); e != nil {
				return nil, e
			}
		} else {
			if !has([]string{"awaiting-approval", "queued", "running", "attention"}, str(plan, "state")) {
				return nil, fail("operations_file_cleanup_plan_state", 409)
			}
			if _, e = tx.Exec(ctx, "UPDATE operations_file_cleanup_plans_v1 SET state='cancelled',revision=revision+1,cancelled_by=$2,cancelled_at=$3 WHERE id=$1", id, current.ID, s.stamp()); e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, "UPDATE operations_file_cleanup_items_v1 SET state='skipped',result_code='plan-cancelled',completed_at=$2 WHERE plan_id=$1 AND state IN('pending','removing','result-unknown')", id, s.stamp()); e != nil {
				return nil, e
			}
		}
		if _, e = s.fresh(ctx, tx, a, action); e != nil {
			return nil, e
		}
		state := "cancelled"
		if approve {
			state = "queued"
		}
		return Object{"planId": id, "kind": kind, "state": state}, nil
	})
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, a, action); e != nil {
		return nil, e
	}
	receipt["plan"], e = s.CleanupPlan(ctx, a, id)
	return receipt, e
}
