// Package searchv2 adapts one current-authorized original source at a time.
package searchv2

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/civ2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/historyv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"strings"
	"time"
)

type SourceQuery func(context.Context, *deviceauth.Actor, []byte) (json.RawMessage, error)
type Service struct {
	Pool                                   *pgxpool.Pool
	Devices                                *deviceauth.Service
	History                                *historyv2.Service
	CI                                     *civ2.Service
	Tasks, Opportunities, Capsules, Legacy SourceQuery
	Now                                    func() time.Time
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func (s *Service) within(ctx context.Context, a *deviceauth.Actor, scope string, read func(pgx.Tx) (Object, error)) (Object, error) {
	if s.Pool == nil {
		return nil, fault.New("search_source_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if a != nil {
			if s.Devices == nil {
				return nil, fault.New("search_source_unavailable", 503)
			}
			if e := s.Devices.AuthorizeWithin(ctx, tx, *a, scope); e != nil {
				return nil, e
			}
		}
		return read(tx)
	})
}
func source(ctx context.Context, a *deviceauth.Actor, q Object, read SourceQuery) (Object, error) {
	if read == nil {
		return nil, fault.New("search_source_unavailable", 503)
	}
	raw, e := read(ctx, a, encode(q))
	if e != nil {
		return nil, e
	}
	value, e := protocol.DecodeOrdered(raw)
	if e != nil || obj(value) == nil {
		return nil, fmt.Errorf("search source returned invalid wire view")
	}
	return obj(value), nil
}
func (s *Service) page(kind string, items []any, next any, coverage *ordered) Object {
	state := "no-visible-match-in-this-page"
	if len(items) > 0 {
		state = "available"
	}
	if coverage.Values()["enabled"] == false {
		state = "disabled"
	}
	order := "stable-source-id"
	if kind == "opportunity" {
		order = "source-functional-match-within-window"
	}
	return Object{"schemaVersion": 2, "type": kind, "items": items, "nextCursor": next, "coverage": coverage, "sourceState": state, "countsScope": "visible-page-only", "pageCount": len(items), "globalCountProvided": false, "checkedAt": s.now(), "order": order, "interpretation": "user-or-user-agent", "cacheable": false, "capabilityVerified": false, "emptyMeaning": "No matching currently readable item in this page; not proof that no suitable help exists.", "helpPaths": []any{"continue-current-ai", "capsule-or-history", "open-assistance", "bounty-or-expert-assistance"}}
}
func (s *Service) item(kind string, id, title, summary any, record any, matches, limitations any, authority string, source any, version string) (*ordered, error) {
	value := historyv2.VisibleValue(record)
	if version == "" {
		var e error
		version, e = historyv2.SourceFingerprint(build("record", value, "source", source))
		if e != nil {
			return nil, e
		}
	}
	out := build("type", kind, "id", id, "title", title, "summary", summary, "sourceVersion", version, "ref", build("id", id, "version", version), "source", source)
	if textView := obj(record)["textView"]; textView != nil {
		out.Set("textView", textView)
	}
	recordKind := obj(value)["kind"]
	if recordKind == nil {
		recordKind = kind
	}
	for _, key := range []struct {
		k string
		v any
	}{{"record", value}, {"recordKind", recordKind}, {"authority", authority}, {"matchReasons", matches}, {"limitations", limitations}, {"sourceStatus", "current-readable"}, {"capabilityVerified", false}, {"selected", false}, {"applied", false}} {
		out.Set(key.k, key.v)
	}
	return out, nil
}
func (s *Service) Query(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	input, e := ParseQuery(raw)
	if e != nil {
		return nil, e
	}
	kind, q := text(input, "type"), obj(input["query"])
	items := []any{}
	appendItem := func(id, title, summary any, record, matches, limitations any, authority string, src any, version string) error {
		item, e := s.item(kind, id, title, summary, record, matches, limitations, authority, src, version)
		if e == nil {
			items = append(items, item)
		}
		return e
	}
	if kind == "history" || kind == "case" {
		if s.History == nil {
			return nil, fault.New("history_unavailable", 503)
		}
		page, e := s.within(ctx, a, "history", func(tx pgx.Tx) (Object, error) { return s.History.SearchWithin(ctx, tx, a, encode(q), kind == "case") })
		if e != nil {
			return nil, e
		}
		for _, record := range list(page["items"]) {
			r := obj(record)
			id := r["caseId"]
			if id == nil {
				id = r["taskId"]
			}
			title, summary := r["title"], r["summary"]
			if title == nil {
				title = "授权工作事实"
			}
			if summary == nil {
				summary = ""
			}
			version, e := historyv2.SourceFingerprint(record)
			if e != nil {
				return nil, e
			}
			if e = appendItem(id, title, summary, record, r["matchReasons"], []any{"Only currently authorized facts; private and unavailable sources are excluded.", "Attempt, failure, diagnosis, partial work, acceptance and verification retain separate meanings.", "No current willingness, expertise or success probability is inferred."}, "source-authored-events-and-current-dependent-reports", build("key", r["key"], "projectionRule", obj(page["rebuild"])["ruleId"], "subjectId", q["subjectId"]), version); e != nil {
				return nil, e
			}
		}
		return s.page(kind, items, page["nextCursor"], build("sourceScan", page["sourceScan"], "sourceVersion", 2, "windowLimited", false)), nil
	}
	if kind == "proof" {
		return s.within(ctx, a, "proof", func(tx pgx.Tx) (Object, error) { return s.proofsWithin(ctx, tx, a, q) })
	}
	read := s.Tasks
	switch kind {
	case "opportunity":
		read = s.Opportunities
	case "capsule":
		read = s.Capsules
	case "worker", "hub":
		read = s.Legacy
	}
	query := q
	if kind == "worker" || kind == "hub" {
		query = input
	}
	page, e := source(ctx, a, query, read)
	if e != nil {
		return nil, e
	}
	if _, ok := page["items"].([]any); !ok {
		return nil, fault.New("search_source_response_invalid", 503)
	}
	for _, record := range list(page["items"]) {
		r := obj(record)
		switch kind {
		case "task":
			wire, ok := record.(*ordered)
			if !ok {
				return nil, fmt.Errorf("ordered task source required")
			}
			wire.Delete("version")
			request := obj(r["request"])
			e = appendItem(r["taskId"], request["title"], request["summary"], wire, []any{build("kind", "current-visible-task-title-or-summary", "query", q["query"])}, []any{"A published request is not performed work, an application, a contract or an accepted result.", "Open assistance remains available to new participants without previous history."}, "requester-declaration-and-current-task-state", build("taskId", r["taskId"], "operationId", request["operationId"]), "")
		case "opportunity":
			e = appendItem(r["id"], obj(r["project"])["title"], obj(r["project"])["summary"], record, r["match"], []any{"Self-declared functions and expressed willingness; not a proven capability or sent invitation.", "Same functionality can use different technologies; ordinary conversation does not require a failed Case."}, "current-declaration-and-expressed-preference", r["opportunityRef"], "")
		case "capsule":
			e = appendItem(r["capsuleId"], r["title"], r["problemPattern"], record, []any{build("kind", "current-title-or-problem-field", "query", q["query"])}, []any{"Reading is not application or successful reuse.", "Check current version, license, required tools and notices before applying."}, "author-published-method-with-current-source-permissions", build("id", r["capsuleId"], "versionId", r["versionId"], "version", r["sourceVersion"]), "")
		default:
			e = appendItem(r["id"], r["title"], r["summary"], r["record"], r["matchReasons"], r["limitations"], "owner-declaration", r["source"], "")
		}
		if e != nil {
			return nil, e
		}
	}
	coverage := build("sourceVersion", 2, "windowLimited", false)
	next := page["nextAfter"]
	if kind == "opportunity" {
		coverage = build()
		if c, ok := page["coverage"].(*ordered); ok {
			for _, k := range c.Keys() {
				coverage.Set(k, c.Values()[k])
			}
		} else {
			return nil, fmt.Errorf("ordered opportunity coverage required")
		}
		if v, present := page["enabled"]; present {
			coverage.Set("enabled", v)
		}
		if v, present := page["disabledReason"]; present {
			coverage.Set("disabledReason", v)
		}
		coverage.Set("sourceVersion", 2)
	}
	if kind == "worker" || kind == "hub" {
		coverage = build("windowLimited", page["windowLimited"], "sourceVersion", 1)
		next = page["nextCursor"]
	}
	return s.page(kind, items, next, coverage), nil
}
func (s *Service) proofsWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, q Object) (Object, error) {
	var after any = q["after"]
	items := []any{}
	terms := strings.FieldsFunc(lower(text(q, "query")), white)
	limit := int(number(q, "limit"))
	for {
		rows, e := tx.Query(ctx, `SELECT id::text FROM ci_proofs_v2 WHERE ($1::uuid IS NULL OR id>$1) AND ($2::text IS NULL OR subject_id=$2) ORDER BY id LIMIT 100`, after, q["subjectId"])
		if e != nil {
			return nil, e
		}
		ids := []string{}
		for rows.Next() {
			var id string
			if e = rows.Scan(&id); e != nil {
				rows.Close()
				return nil, e
			}
			ids = append(ids, id)
		}
		rows.Close()
		if e = rows.Err(); e != nil {
			return nil, e
		}
		for _, id := range ids {
			if s.CI == nil {
				return nil, fault.New("ci_service_unavailable", 503)
			}
			raw, e := s.CI.ReadProofWireWithin(ctx, tx, a, id)
			if e != nil {
				var f *fault.Error
				if errors.As(e, &f) && (f.Status == 403 || f.Status == 404 || f.Status == 409 || f.Status == 422) {
					continue
				}
				return nil, e
			}
			record, e := protocol.DecodeOrdered(raw)
			if e != nil {
				return nil, e
			}
			data := obj(obj(record)["data"])
			src := obj(data["source"])
			fields := build("repository", text(src, "owner")+"/"+text(src, "repository"), "commit", src["commit"], "conclusion", data["conclusion"], "runId", fmt.Sprint(src["runId"]), "scope", data["scope"])
			matches := []any{}
			match := true
			for _, term := range terms {
				names := []any{}
				for _, k := range fields.Keys() {
					if strings.Contains(lower(fmt.Sprint(fields.Values()[k])), term) {
						names = append(names, k)
					}
				}
				if len(names) == 0 {
					match = false
					break
				}
				matches = append(matches, build("term", term, "fields", names))
			}
			if !match || q["conclusion"] != nil && q["conclusion"] != data["conclusion"] {
				continue
			}
			item, e := s.item("proof", id, fields.Values()["repository"].(string)+" · run "+fields.Values()["runId"].(string), data["conclusion"], record, matches, data["limitations"], "repository-controlled-ci-observation; not-independent-expertise", build("id", id, "schemaVersion", 2), "")
			if e != nil {
				return nil, e
			}
			items = append(items, item)
			if len(items) > limit {
				break
			}
		}
		if len(items) > limit || len(ids) < 100 {
			break
		}
		after = ids[len(ids)-1]
	}
	var next any
	if len(items) > limit {
		items = items[:limit]
		next = obj(items[len(items)-1])["id"]
	}
	return s.page("proof", items, next, build("sourceVersion", 2, "windowLimited", false, "legacyProofs", "/v1/search/query type=proof")), nil
}
func (s *Service) Reference(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	input, e := ParseReference(raw)
	if e != nil {
		return nil, e
	}
	search, ref := obj(input["search"]), obj(input["ref"])
	queryWire, e := protocol.DecodeOrdered(encode(search["query"]))
	if e != nil {
		return nil, e
	}
	query := queryWire.(*ordered)
	query.Delete("after")
	cursors := map[string]bool{}
	for {
		page, e := s.Query(ctx, a, encode(Object{"type": search["type"], "query": query}))
		if e != nil {
			return nil, e
		}
		for _, v := range list(page["items"]) {
			item := obj(v)
			if item["id"] == ref["id"] {
				current := item["sourceVersion"] == ref["version"]
				state := "changed"
				if current {
					state = "current"
				}
				return Object{"schemaVersion": 2, "ref": input["ref"], "state": state, "item": v, "priorRationaleCurrent": current, "checkedAt": s.now()}, nil
			}
		}
		next := text(page, "nextCursor")
		if next == "" {
			return Object{"schemaVersion": 2, "ref": input["ref"], "state": "unavailable-in-current-query", "item": nil, "priorRationaleCurrent": false, "checkedAt": s.now()}, nil
		}
		if cursors[next] {
			return nil, fault.New("search_source_cursor_loop", 503)
		}
		cursors[next] = true
		query.Set("after", next)
	}
}
