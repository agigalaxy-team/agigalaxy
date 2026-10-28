// Package historyv2 composes the existing currently authorized fact sources.
// It writes neither historical facts nor a background projection.
package historyv2

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"sort"
	"strings"
	"time"
)

type AuthorizedSource func(context.Context, pgx.Tx, *deviceauth.Actor, string) (json.RawMessage, error)
type Service struct {
	Pool               *pgxpool.Pool
	Endpoint           string
	Devices            *deviceauth.Service
	Cases              *cases.Service
	Records            *verificationrecords.Service
	Proofs             *evidence.ProofService
	Profiles           *profiles.Service
	Tasks, CapsuleUses AuthorizedSource
	Now                func() time.Time
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
func unavailable(e error) bool {
	var f *fault.Error
	return errors.As(e, &f) && (f.Status == 403 || f.Status == 404 || f.Status == 409 || f.Status == 422)
}
func readWire(raw []byte, e error) (*ordered, error) {
	if e != nil {
		return nil, e
	}
	v, e := protocol.DecodeOrdered(raw)
	if e != nil {
		return nil, e
	}
	o, ok := v.(*ordered)
	if !ok {
		return nil, fmt.Errorf("history source returned invalid object")
	}
	return o, nil
}
func readSource(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string, read AuthorizedSource) (*ordered, error) {
	if read == nil {
		return nil, fault.New("history_source_unavailable", 503)
	}
	return readWire(read(ctx, tx, a, id))
}
func (s *Service) Query(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	if s.Pool == nil {
		return nil, fault.New("history_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return s.QueryWithin(ctx, tx, a, raw) })
}
func (s *Service) QueryWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, raw []byte) (Object, error) {
	options, e := parseQuery(raw)
	if e != nil {
		return nil, e
	}
	if a != nil {
		if s.Devices == nil {
			return nil, fault.New("history_unavailable", 503)
		}
		if e = s.Devices.AuthorizeWithin(ctx, tx, *a, "history"); e != nil {
			return nil, e
		}
	}
	return s.query(ctx, tx, a, options)
}
func (s *Service) query(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, options *ordered) (Object, error) {
	o := options.Values()
	subject := str(o, "subjectId")
	taskIDs := []string{}
	if e := scanIDs(ctx, tx, func(after any) ([]string, error) { return ids(ctx, tx, candidateTasksSQL, o["subjectId"], after) }, func(id string) error { taskIDs = append(taskIDs, id); return nil }); e != nil {
		return nil, e
	}
	if len(taskIDs) > 0 {
		rows, e := tx.Query(ctx, `SELECT id FROM task_requests WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE`, taskIDs)
		if e != nil {
			return nil, e
		}
		for rows.Next() {
		}
		rows.Close()
		if e = rows.Err(); e != nil {
			return nil, e
		}
	}
	tasks := []*ordered{}
	for _, id := range taskIDs {
		task, e := s.taskWithin(ctx, tx, a, id, subject)
		if e != nil {
			if unavailable(e) {
				continue
			}
			return nil, e
		}
		if task != nil {
			if subject == "" {
				task.Set("subjectId", nil)
			}
			tasks = append(tasks, task)
		}
	}
	items := []*ordered{}
	covered := map[string]bool{}
	if e := scanIDs(ctx, tx, func(after any) ([]string, error) {
		return ids(ctx, tx, candidateCasesSQL, o["subjectId"], after, true, viewerID(a), time.Unix(s.now(), 0).UTC(), s.Endpoint)
	}, func(id string) error {
		item, e := s.caseWithin(ctx, tx, a, id, subject, tasks)
		if e != nil {
			return e
		}
		if item != nil {
			if subject == "" {
				item.Set("subjectId", nil)
			}
			items = append(items, item)
			for _, t := range arr(item.Values()["collaborations"]) {
				covered[str(obj(t), "taskId")] = true
			}
		}
		return nil
	}); e != nil {
		return nil, e
	}
	for _, t := range tasks {
		if !covered[str(t.Values(), "taskId")] {
			items = append(items, t)
		}
	}
	profile := build("selfDeclared", build())
	if s.Profiles != nil && subject != "" {
		var e error
		profile, e = readWire(s.Profiles.ReadHistoryWireWithin(ctx, tx, a, subject))
		if e != nil {
			return nil, e
		}
	}
	selected := []any{}
	for _, item := range items {
		if kind := str(o, "recordKind"); kind != "" && item.Values()["kind"] != kind {
			continue
		}
		matches := false
		for _, at := range arr(item.Values()["activityTimes"]) {
			if windowMatches(at, obj(o["timeWindow"]), s.now()) {
				matches = true
				break
			}
		}
		if !matches {
			continue
		}
		v, e := relevance(item, o)
		if e != nil {
			return nil, e
		}
		if v != nil {
			selected = append(selected, v)
		}
	}
	sort.Slice(selected, func(i, j int) bool { return str(obj(selected[i]), "key") < str(obj(selected[j]), "key") })
	query := build()
	for _, k := range options.Keys() {
		if k != "after" {
			query.Set(k, o[k])
		}
	}
	queryHash, e := fingerprint(query)
	if e != nil {
		return nil, e
	}
	sourceHash, e := fingerprint(build("profile", profile, "items", selected))
	if e != nil {
		return nil, e
	}
	last := ""
	if after := str(o, "after"); after != "" {
		cursor, e := decodeCursor(after)
		if e != nil {
			return nil, e
		}
		viewer, present := cursor["viewerId"]
		if !finiteInteger(cursor["v"], 2, 2) || cursor["queryHash"] != queryHash || !present || viewer != viewerID(a) {
			return nil, fault.New("invalid_history_cursor", 400)
		}
		value, ok := cursor["lastKey"].(string)
		if !ok {
			return nil, fault.New("invalid_history_cursor", 400)
		}
		if cursor["sourceHash"] != sourceHash {
			return nil, fault.New("history_sources_changed_retry", 409)
		}
		found := false
		for _, item := range selected {
			if obj(item)["key"] == value {
				found = true
				break
			}
		}
		if !found {
			return nil, fault.New("invalid_history_cursor", 400)
		}
		last = value
	}
	remaining := []any{}
	for _, item := range selected {
		if last == "" || str(obj(item), "key") > last {
			remaining = append(remaining, item)
		}
	}
	limit := int(num(o, "limit"))
	page := remaining
	var next any
	if len(remaining) > limit {
		page = remaining[:limit]
		wire, e := protocol.EncodeJS(build("v", 2, "queryHash", queryHash, "viewerId", viewerID(a), "sourceHash", sourceHash, "lastKey", obj(page[len(page)-1])["key"]))
		if e != nil {
			return nil, e
		}
		next = base64.RawURLEncoding.EncodeToString(wire)
	}
	out := build("schemaVersion", 2, "subjectId", o["subjectId"])
	for _, k := range profile.Keys() {
		out.Set(k, profile.Values()[k])
	}
	out.Set("items", page)
	out.Set("nextCursor", next)
	out.Set("timeWindow", o["timeWindow"])
	out.Set("coverage", "current-visible-page")
	sourceScan := "all-candidates-for-specified-subject"
	if subject == "" {
		sourceScan = "on-demand-current-authorized-facts; not-global-capability-ranking"
	}
	out.Set("sourceScan", sourceScan)
	out.Set("totalVisibleCountProvided", false)
	out.Set("globalCountProvided", false)
	out.Set("capabilityVerified", false)
	out.Set("collaborationEntry", "open-assistance-remains-available; paid-qualification-is-separate")
	out.Set("rebuild", build("ruleId", "history-facts-v2", "ruleVersion", 1, "sourceHash", sourceHash, "checkedAt", time.Unix(s.now(), 0).UTC().Format("2006-01-02T15:04:05.000Z"), "mode", "on-demand", "persistedProjection", false, "backgroundQueue", false))
	return out.Values(), nil
}

// Node's Buffer base64url decoder accepts ordinary alphabet, whitespace, and
// padding. Keep that original cursor behavior; cursor contents remain checked.
func decodeCursor(s string) (Object, error) {
	s = strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '+' || r == '/' || r == '-' || r == '_' {
			return r
		}
		if r == '=' {
			return '='
		}
		return -1
	}, s)
	s = strings.TrimRight(s, "=")
	s = strings.ReplaceAll(strings.ReplaceAll(s, "-", "+"), "_", "/")
	if len(s)%4 == 1 {
		s = s[:len(s)-1]
	}
	raw, e := base64.RawStdEncoding.DecodeString(s)
	var o Object
	if e != nil || protocol.Decode(raw, &o) != nil || o == nil {
		return nil, fault.New("invalid_history_cursor", 400)
	}
	return o, nil
}
