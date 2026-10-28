package operationsaudit

import (
	"context"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type snapshot struct {
	mu                                    sync.Mutex
	id, owner, state, reason              string
	scope                                 Object
	created, expires, used                int64
	ids                                   []int64
	matches                               []uint32
	names                                 map[string]any
	bytes, candidates, inspected, matched int
	actions                               []string
	timer                                 *time.Timer
}

func (s *Service) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	for id := range s.entries {
		s.dropLocked(id)
	}
	return nil
}
func (s *Service) dropLocked(id string) {
	if entry := s.entries[id]; entry != nil {
		if entry.timer != nil {
			entry.timer.Stop()
		}
		delete(s.entries, id)
	}
}
func owner(a Actor) string { return a.ID } // Actor is already the owning authority's attested current identity.
func (s *Service) forget(a Actor) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, entry := range s.entries {
		if entry.owner == owner(a) {
			s.dropLocked(id)
		}
	}
}
func snapshotScope(q Object) Object {
	sort := "newest"
	if q["sort"] != nil {
		sort = str(q["sort"])
	}
	var resource any
	if q["resourceId"] != nil {
		resource = strings.ToLower(str(q["resourceId"]))
	}
	return Object{"accountId": q["accountId"], "resourceId": resource, "kind": q["kind"], "action": q["action"], "day": q["day"], "query": q["query"], "sort": sort}
}
func (s *Service) capture(ctx context.Context, d *businessadmin.Domain, a Actor, scope Object) (*snapshot, error) {
	tx, e := d.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	order := "DESC"
	if scope["sort"] == "oldest" {
		order = "ASC"
	}
	captured, e := rows(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT a.sequence,a.operator_id,CASE WHEN a.actor_kind='business-operator' THEN NULLIF(BTRIM(p.display_name),'') ELSE NULL END AS operator_display_name,count(*) OVER() AS candidate_count FROM business_admin_audit_v1 a LEFT JOIN operations_operator_principals_v1 p ON p.endpoint=a.endpoint AND p.operator_id=a.operator_id AND a.actor_kind='business-operator' WHERE a.endpoint=$1 AND ($2::uuid IS NULL OR a.account_id=$2) AND ($3::text IS NULL OR a.action=$3) AND ($4::text[] IS NULL OR a.action=ANY($4)) AND ($5::date IS NULL OR (a.created_at>=($5::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND a.created_at<(($5::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai'))) ORDER BY a.created_at `+order+`,a.sequence `+order+` LIMIT 100001) r`, d.Endpoint, scope["accountId"], scope["action"], kindActions(str(scope["kind"])), scope["day"])
	if e != nil {
		return nil, e
	}
	actions := []string{}
	rr, e := tx.Query(ctx, "SELECT DISTINCT action FROM business_admin_audit_v1 WHERE endpoint=$1 AND action=ANY($2::text[]) ORDER BY action", d.Endpoint, actionCodes())
	if e != nil {
		return nil, e
	}
	for rr.Next() {
		var action string
		if e = rr.Scan(&action); e != nil {
			rr.Close()
			return nil, e
		}
		actions = append(actions, action)
	}
	e = rr.Err()
	rr.Close()
	if e != nil {
		return nil, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	count := 0
	if len(captured) > 0 {
		n, ok := numeric(captured[0]["candidate_count"])
		if !ok || n < 0 || n > 9007199254740991 {
			return nil, fail("audit_query_unavailable", 503)
		}
		count = int(n)
	}
	at := s.now()
	entry := &snapshot{id: uuid.NewString(), owner: owner(a), state: "ready", scope: scope, created: at, expires: at + 300, used: at, ids: []int64{}, names: map[string]any{}, bytes: 512, candidates: count, inspected: count, matched: count}
	projecting := scope["resourceId"] != nil || str(scope["query"]) != ""
	if count > 100000 {
		entry.state = "narrow-required"
		entry.reason = "candidate-limit"
		entry.inspected, entry.matched = 0, 0
	} else {
		for _, row := range captured {
			n, e := strconv.ParseInt(stringValue(row["sequence"]), 10, 64)
			if e != nil {
				return nil, e
			}
			entry.ids = append(entry.ids, n)
			person := str(row["operator_id"])
			if _, present := entry.names[person]; !present {
				entry.names[person] = row["operator_display_name"]
				entry.bytes += len(person) + len(str(row["operator_display_name"])) + 64
			}
		}
		entry.bytes += len(entry.ids) * 8
		if projecting {
			entry.matches = []uint32{}
			entry.bytes += len(entry.ids) * 4
			entry.inspected, entry.matched = 0, 0
			if count > 0 {
				entry.state = "scanning"
			}
		}
	}
	if entry.bytes > 24*1024*1024 {
		entry.ids = []int64{}
		entry.matches = nil
		entry.names = map[string]any{}
		entry.bytes = 512
		entry.state = "narrow-required"
		entry.reason = "cache-capacity"
		entry.inspected, entry.matched = 0, 0
	}
	entry.actions = actions
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, fail("audit_query_unavailable", 503)
	}
	if s.entries == nil {
		s.entries = map[string]*snapshot{}
	}
	for id, old := range s.entries {
		if old.expires <= at {
			s.dropLocked(id)
		}
	}
	for {
		size := 0
		for _, old := range s.entries {
			size += old.bytes
		}
		if len(s.entries) < 16 && size+entry.bytes <= 24*1024*1024 {
			break
		}
		var oldest *snapshot
		for _, old := range s.entries {
			if oldest == nil || old.used < oldest.used || old.used == oldest.used && old.created < oldest.created {
				oldest = old
			}
		}
		if oldest == nil {
			break
		}
		s.dropLocked(oldest.id)
	}
	s.entries[entry.id] = entry
	entry.timer = time.AfterFunc(300*time.Second, func() { s.mu.Lock(); defer s.mu.Unlock(); s.dropLocked(entry.id) })
	return entry, nil
}
func (s *Service) snapshotRows(ctx context.Context, entry *snapshot, ids []int64, canReadTasks bool) (map[int64]Object, error) {
	out := map[int64]Object{}
	if len(ids) == 0 {
		return out, nil
	}
	found, e := rows(ctx, s.Domain.Pool, "SELECT to_jsonb(a) FROM business_admin_audit_v1 a WHERE endpoint=$1 AND sequence=ANY($2::bigint[])", s.Domain.Endpoint, ids)
	if e != nil {
		return nil, e
	}
	found, e = s.decorate(ctx, found, canReadTasks)
	if e != nil {
		return nil, e
	}
	for _, row := range found {
		sequence, e := strconv.ParseInt(stringValue(row["sequence"]), 10, 64)
		if e != nil {
			return nil, e
		}
		out[sequence] = row
	}
	if len(out) != len(ids) {
		s.mu.Lock()
		s.dropLocked(entry.id)
		s.mu.Unlock()
		return nil, fail("audit_snapshot_expired", 409)
	}
	return out, nil
}
func (s *Service) safeSnapshotRow(row Object, entry *snapshot) Object {
	if catalog.Actions[str(row["action"])] == nil {
		row["action"] = "unknown"
	}
	row["operator_display_name"] = entry.names[str(row["operator_id"])]
	return Metadata(row)
}
func (s *Service) pageAudit(ctx context.Context, d *businessadmin.Domain, a Actor, q Object) (Object, error) {
	if action := str(q["action"]); action != "" && catalog.Actions[action] == nil {
		return nil, invalid()
	}
	scope := snapshotScope(q)
	var entry *snapshot
	if id := str(q["snapshot"]); id != "" {
		s.mu.Lock()
		entry = s.entries[id]
		if entry != nil && entry.expires <= s.now() {
			s.dropLocked(id)
			entry = nil
		}
		s.mu.Unlock()
		if entry == nil {
			return nil, fail("audit_snapshot_expired", 409)
		}
		if entry.owner != owner(a) {
			return nil, fail("audit_snapshot_unavailable", 404)
		}
		if !equal(entry.scope, scope) {
			return nil, fail("audit_snapshot_mismatch", 409)
		}
	} else {
		var e error
		entry, e = s.capture(ctx, d, a, scope)
		if e != nil {
			return nil, e
		}
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	canReadTasks := slices.Contains(a.Permissions, "autonomy.read")
	s.mu.Lock()
	entry.used = s.now()
	s.mu.Unlock()
	if entry.state == "scanning" {
		end := min(len(entry.ids), entry.inspected+1000)
		found, e := s.snapshotRows(ctx, entry, entry.ids[entry.inspected:end], canReadTasks)
		if e != nil {
			return nil, e
		}
		for index := entry.inspected; index < end; index++ {
			if matchesQuery(s.safeSnapshotRow(found[entry.ids[index]], entry), entry.scope, true) {
				entry.matches = append(entry.matches, uint32(index))
				entry.matched++
			}
		}
		entry.inspected = end
		if end == len(entry.ids) {
			entry.state = "ready"
		}
	}
	s.mu.Lock()
	valid := s.entries[entry.id] != nil && entry.expires > s.now()
	if !valid {
		s.dropLocked(entry.id)
	}
	s.mu.Unlock()
	if !valid {
		return nil, fail("audit_snapshot_expired", 409)
	}
	page, size := 1, 30
	if n, ok := q["page"].(int); ok {
		page = n
	}
	if n, ok := q["pageSize"].(int); ok {
		size = n
	}
	ready := entry.state == "ready"
	var total, pages, hasNext any
	ids := []int64{}
	if ready {
		total = entry.matched
		pages = (entry.matched + size - 1) / size
		hasNext = page < pages.(int)
		for index := (page - 1) * size; index < min(entry.matched, page*size); index++ {
			at := index
			if entry.matches != nil {
				at = int(entry.matches[index])
			}
			ids = append(ids, entry.ids[at])
		}
	}
	found, e := s.snapshotRows(ctx, entry, ids, canReadTasks)
	if e != nil {
		return nil, e
	}
	items := []any{}
	for _, id := range ids {
		items = append(items, s.safeSnapshotRow(found[id], entry))
	}
	selection := Object{"resourceId": q["resourceId"], "limit": size, "kind": q["kind"], "action": q["action"], "day": q["day"], "hasQuery": str(q["query"]) != "", "page": page}
	if e = s.record(ctx, d, a, q["accountId"], selection, len(items)); e != nil {
		if slices.Contains([]int{401, 403}, fault.Status(e)) {
			s.forget(a)
		}
		return nil, e
	}
	return Object{"items": items, "nextAfter": nil, "scanLimited": entry.state == "scanning", "checkedAt": s.now(), "readExpiresAt": s.now() + 30, "metadataOnly": true, "actions": entry.actions, "pagination": Object{"page": page, "pageSize": size, "total": total, "totalPages": pages, "hasPrevious": page > 1, "hasNext": hasNext, "snapshot": entry.id, "snapshotCreatedAt": entry.created, "snapshotExpiresAt": entry.expires, "sort": scope["sort"]}, "search": Object{"state": entry.state, "inspected": entry.inspected, "candidates": entry.candidates, "matched": entry.matched, "complete": ready, "reasonCode": nullable(entry.reason)}}, nil
}
func nullable(v string) any {
	if v == "" {
		return nil
	}
	return v
}
