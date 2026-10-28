package filegovernance

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"regexp"
	"strings"
)

var filesAfter = regexp.MustCompile(`^(chat|forum):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func parseFilters(input Object, page bool) (Object, error) {
	x := Object{}
	for k, v := range input {
		x[k] = v
	}
	keys := []string{"kind", "state", "processing", "issue"}
	if page {
		keys = append(keys, "limit", "after")
	}
	if !exact(x, keys...) {
		return nil, invalid()
	}
	for key, values := range map[string][]string{"kind": {"chat", "forum"}, "state": {"prepared", "uploading", "scan-pending", "scanning", "available", "blocked", "erased", "expired", "revoked"}, "processing": {"scan", "cleanup"}, "issue": {"any", "scan", "cleanup"}} {
		if _, ok := x[key]; ok && !has(values, str(x, key)) {
			return nil, invalid()
		}
	}
	if page {
		if _, ok := x["limit"]; !ok {
			x["limit"] = 25
		}
		if !integer(x["limit"], 1, 100) {
			return nil, invalid()
		}
		if _, ok := x["after"]; ok && !filesAfter.MatchString(str(x, "after")) {
			return nil, invalid()
		}
	}
	return x, nil
}
func (s *Service) queryValues(q Object) []any {
	return []any{s.Endpoint, q["kind"], q["state"], q["processing"], q["issue"], s.stamp()}
}
func (s *Service) List(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := parseFilters(input, true)
	if e != nil {
		return nil, e
	}
	selection := Object{"view": "list"}
	for k, v := range q {
		selection[k] = v
	}
	return s.run(ctx, a, "files-query", selection, func(tx pgx.Tx, current Actor) (Object, error) {
		var afterID, afterKind any
		if str(q, "after") != "" {
			parts := strings.Split(str(q, "after"), ":")
			afterKind, afterID = parts[0], parts[1]
		}
		args := append(s.queryValues(q), afterID, afterKind, num(q, "limit")+1)
		rr, e := rows(ctx, tx, fileCTE+" SELECT to_jsonb(f) FROM selected_files f WHERE ($7::uuid IS NULL OR (id,kind)>($7::uuid,$8::text)) ORDER BY id,kind LIMIT $9", args...)
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
			item, e := s.view(ctx, tx, str(r, "kind"), r, current, false)
			if e != nil {
				return nil, e
			}
			items = append(items, item)
		}
		var next any
		if len(rr) > limit {
			next = str(selected[len(selected)-1], "kind") + ":" + str(selected[len(selected)-1], "id")
		}
		return Object{"items": items, "nextAfter": next, "checkedAt": s.now(), "readExpiresAt": s.now() + 30, "metadataOnly": true}, nil
	})
}
func (s *Service) Policy() Object {
	limits := func(a *FileAdapter) Object {
		out := Object{"processingAvailable": a != nil && a.Available != nil && a.Available(), "maxFileBytes": nil, "maxSubjectBytes": nil, "maxGlobalBytes": nil}
		if a != nil {
			out["maxFileBytes"], out["maxSubjectBytes"], out["maxGlobalBytes"] = a.Policy.MaxFileBytes, a.Policy.MaxSubjectBytes, a.Policy.MaxGlobalBytes
		}
		return out
	}
	chat, forum := limits(s.Chat), limits(s.Forum)
	chat["retentionDays"], chat["startsAt"] = 30, "first-upload-start"
	forum["retention"] = "source-bound"
	return Object{"relay": Object{"state": "not-configured", "enabled": false, "ttlSeconds": nil, "startsAt": nil, "maxFileBytes": nil, "maxCacheBytes": nil, "automaticExpiryCleanupEnabled": false}, "existing": Object{"chat": chat, "forum": forum}, "cleanup": Object{"legacyWorker": "owner-and-safety-only", "manualPlanRequired": true, "executionObservation": "per-plan", "physicalBlocksReleased": nil}}
}
func (s *Service) Summary(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := parseFilters(input, false)
	if e != nil {
		return nil, e
	}
	selection := Object{"view": "summary"}
	for k, v := range q {
		selection[k] = v
	}
	return s.run(ctx, a, "files-query", selection, func(tx pgx.Tx, _ Actor) (Object, error) {
		rr, e := rows(ctx, tx, fileCTE+` SELECT to_jsonb(q) FROM (SELECT kind,GROUPING(kind) AS all_kinds,count(*)::text AS records,COALESCE(sum(byte_size) FILTER(WHERE purged_at IS NULL),0)::text AS reserved_bytes,
 count(*) FILTER(WHERE effective_state='available' AND NOT purge_pending AND NOT EXISTS(SELECT 1 FROM operations_file_access_heads_v1 h WHERE h.endpoint=$1 AND h.kind=selected_files.kind AND h.file_id=selected_files.id AND h.stopped_until>$6))::text AS ready_files,
 count(*) FILTER(WHERE state IN ('scan-pending','scanning') AND effective_state NOT IN ('expired','revoked','erased') AND NOT purge_pending)::text AS pending_scan,
 count(*) FILTER(WHERE scan_failed)::text AS scan_failed,count(*) FILTER(WHERE effective_state='expired')::text AS expired,count(*) FILTER(WHERE effective_state='revoked')::text AS revoked,count(*) FILTER(WHERE purged_at IS NOT NULL)::text AS removed,
 count(*) FILTER(WHERE needs_cleanup AND NOT COALESCE(cleanup_unknown,false))::text AS cleanup_pending,count(*) FILTER(WHERE cleanup_unknown)::text AS cleanup_unknown FROM selected_files GROUP BY GROUPING SETS((),(kind)))q`, s.queryValues(q)...)
		if e != nil {
			return nil, e
		}
		total := Object{}
		groups := map[string]Object{}
		for _, r := range rr {
			if num(r, "all_kinds") == 1 {
				total = r
			} else {
				groups[str(r, "kind")] = r
			}
		}
		number := func(r Object, key string) any {
			if v := safeSize(r[key]); v != nil {
				return v
			}
			return int64(0)
		}
		byKind := []Object{}
		for _, kind := range []string{"chat", "forum"} {
			group := groups[kind]
			reserved := any(int64(0))
			if group != nil {
				reserved = safeSize(group["reserved_bytes"])
			}
			byKind = append(byKind, Object{"kind": kind, "records": number(group, "records"), "reservedBytes": reserved})
		}
		filters := Object{"kind": q["kind"], "state": q["state"], "processing": q["processing"], "issue": q["issue"]}
		totals := Object{"records": number(total, "records"), "reservedBytes": safeSize(total["reserved_bytes"]), "actualStoredBytes": nil, "readyFiles": number(total, "ready_files"), "pendingScan": number(total, "pending_scan"), "scanFailed": number(total, "scan_failed"), "expired": number(total, "expired"), "revoked": number(total, "revoked"), "removed": number(total, "removed"), "cleanupPending": number(total, "cleanup_pending"), "cleanupResultUnknown": number(total, "cleanup_unknown"), "cleanupRunning": nil, "cleanupFailed": nil}
		return Object{"checkedAt": s.now(), "readExpiresAt": s.now() + 30, "metadataOnly": true, "scope": "configured-business-database", "filters": filters, "totals": totals, "byKind": byKind, "policy": s.Policy()}, nil
	})
}
func (s *Service) current(ctx context.Context, a Actor, permission string) (Actor, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.fresh(ctx, tx, a, permission) })
}
func (s *Service) Retry(ctx context.Context, a Actor, kind, id string, input Object) (Object, error) {
	x, e := ParseRetry(input)
	if e != nil || !fileUUID.MatchString(id) {
		return nil, invalid()
	}
	adapter, e := s.adapter(kind, true)
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, a, "files.scan.retry"); e != nil {
		return nil, e
	}
	if str(x, "kind") == "cleanup" {
		return nil, fail("operations_file_cleanup_authorization_required", 409)
	}
	receipt, e := s.command(ctx, a, "file-retry", Object{"kind": kind, "id": id, "command": x, "operationId": x["operationId"]}, func(tx pgx.Tx, current Actor) (Object, error) {
		if _, e := s.fresh(ctx, tx, a, "files.scan.retry"); e != nil {
			return nil, e
		}
		r, e := s.scopedRow(ctx, tx, kind, id, true)
		if e != nil {
			return nil, e
		}
		if ProcessingVersion(r) != str(x, "expectedVersion") {
			return nil, fail("operations_file_changed", 409)
		}
		view, e := s.view(ctx, tx, kind, r, current, false)
		if e != nil {
			return nil, e
		}
		if num(view, "retriesRemaining") == 0 {
			return nil, fail("operations_file_retry_limit", 429)
		}
		if _, e = s.fresh(ctx, tx, a, "files.scan.retry"); e != nil {
			return nil, e
		}
		if adapter.Available == nil || !adapter.Available() {
			return nil, fail("attachment_service_unavailable", 503)
		}
		pending, e := s.authorPending(ctx, tx, kind, r)
		if e != nil {
			return nil, e
		}
		if _, e = RetryProcessingWithin(ctx, tx, kind, r, x, s.now(), pending); e != nil {
			return nil, e
		}
		if _, e = s.fresh(ctx, tx, a, "files.scan.retry"); e != nil {
			return nil, e
		}
		return Object{"id": id, "kind": kind, "state": "scheduled", "processingComplete": false}, nil
	})
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, a, "files.scan.retry"); e != nil {
		return nil, e
	}
	receipt["file"], e = s.Get(ctx, a, kind, id)
	return receipt, e
}
