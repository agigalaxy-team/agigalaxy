package choices

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/civ2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/historyv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/searchv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/jackc/pgx/v5"
	"regexp"
)

type ReadObjectWire func(context.Context, pgx.Tx, *deviceauth.Actor, Object) (json.RawMessage, error)
type OpportunityReader func(context.Context, pgx.Tx, *deviceauth.Actor, Object, Object) (json.RawMessage, error)
type Reader struct {
	History            *historyv2.Service
	Tasks              *taskmaterials.Service
	CI                 *civ2.Service
	Capsules, Builders ReadObjectWire
	Opportunities      OpportunityReader
	QueryOpportunities ReadObjectWire
}

func ordered(kv ...any) *protocol.OrderedObject {
	o := protocol.NewOrderedObject()
	for i := 0; i < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}
func decodeWire(raw []byte, e error) (*protocol.OrderedObject, error) {
	if e != nil {
		return nil, e
	}
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	v, e := protocol.DecodeOrdered(raw)
	if e != nil {
		return nil, e
	}
	o, ok := v.(*protocol.OrderedObject)
	if !ok {
		return nil, fail("choice_source_unavailable")
	}
	return o, nil
}
func has(values []string, expected string) bool {
	for _, v := range values {
		if v == expected {
			return true
		}
	}
	return false
}
func requiredScope(a deviceauth.Actor, kind string) error {
	if !has(a.Scopes, searchv2.Scope(kind)) {
		return fail("access_denied", 403)
	}
	return nil
}
func (r *Reader) historyWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, locator Object) (*protocol.OrderedObject, error) {
	if r.History == nil {
		return nil, fail("choice_history_reader_unavailable", 503)
	}
	raw, e := r.History.ReadChoiceHistoryWithin(ctx, tx, &a, str(locator, "id"), str(locator, "kind"), str(locator, "subjectId"))
	return decodeWire(raw, e)
}
func capsuleList(v *protocol.OrderedObject) (*protocol.OrderedObject, error) {
	o := v.Values()
	version := object(o["version"])
	if version == nil || o["sourceStatus"] == "source-unavailable" {
		return nil, fail("choice_source_unavailable")
	}
	return ordered("capsuleId", o["capsuleId"], "versionId", o["versionId"], "sourceVersion", version["version"], "authorId", o["authorId"], "publicationClass", version["publicationClass"], "synthetic", version["synthetic"], "title", version["title"], "problemPattern", version["problemPattern"], "capabilityId", version["capabilityId"], "sourceStatus", o["sourceStatus"], "deprecated", o["deprecated"], "securityIssue", o["securityIssue"], "newApplicationAllowed", o["newApplicationAllowed"], "capabilityVerified", false), nil
}
func (r *Reader) readWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, locator, query Object) (*protocol.OrderedObject, error) {
	kind := str(locator, "type")
	if e := requiredScope(a, kind); e != nil {
		return nil, e
	}
	var record *protocol.OrderedObject
	var e error
	switch kind {
	case "history", "case":
		record, e = r.historyWithin(ctx, tx, a, locator)
	case "task":
		if r.Tasks == nil {
			return nil, fail("choice_task_reader_unavailable", 503)
		}
		raw, err := r.Tasks.ReadChoiceWireWithin(ctx, tx, &a, str(locator, "id"))
		record, e = decodeWire(raw, err)
	case "proof":
		if r.CI == nil {
			return nil, fail("choice_proof_reader_unavailable", 503)
		}
		raw, err := r.CI.ReadProofWireWithin(ctx, tx, &a, str(locator, "id"))
		record, e = decodeWire(raw, err)
	case "capsule":
		if r.Capsules == nil {
			return nil, fail("choice_capsule_reader_unavailable", 503)
		}
		input := Object{"capsuleId": locator["id"]}
		if v := locator["versionId"]; v != nil {
			input["versionId"] = v
		}
		raw, err := r.Capsules(ctx, tx, &a, input)
		record, e = decodeWire(raw, err)
		if e == nil && record != nil {
			record, e = capsuleList(record)
		}
	case "opportunity":
		if r.Opportunities == nil {
			return nil, fail("choice_opportunity_reader_unavailable", 503)
		}
		raw, err := r.Opportunities(ctx, tx, &a, locator, query)
		record, e = decodeWire(raw, err)
	default:
		if r.Builders == nil {
			return nil, fail("choice_builder_reader_unavailable", 503)
		}
		input := Object{"builderId": locator["id"]}
		if v := query["query"]; v != nil {
			input["query"] = v
		}
		raw, err := r.Builders(ctx, tx, nil, input)
		record, e = decodeWire(raw, err)
	}
	if e != nil {
		return nil, e
	}
	if record == nil {
		return nil, fail("choice_source_unavailable")
	}
	return record, nil
}
func factual(record *protocol.OrderedObject) *protocol.OrderedObject {
	v := historyv2.VisibleValue(record).(*protocol.OrderedObject)
	for _, key := range []string{"matchReasons", "ranking", "match", "checkedAt"} {
		v.Delete(key)
	}
	if help, ok := v.Values()["help"].(*protocol.OrderedObject); ok {
		help.Delete("functions")
		help.Delete("purposes")
	}
	return v
}

var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)

func visibleAuthors(value any) []any {
	ids := []any{}
	seen := map[string]bool{}
	var visit func(any)
	visit = func(v any) {
		if a, ok := v.([]any); ok {
			for _, v := range a {
				visit(v)
			}
			return
		}
		o, ok := v.(*protocol.OrderedObject)
		if !ok {
			return
		}
		for _, key := range o.Keys() {
			v := o.Values()[key]
			switch key {
			case "subjectId", "actorId", "authorId", "ownerId", "requesterId", "reportedBy", "publisherId", "contactSubjectId":
				s, _ := v.(string)
				if subjectPattern.MatchString(s) && !seen[s] {
					ids = append(ids, s)
					seen[s] = true
					continue
				}
			}
			visit(v)
		}
	}
	visit(value)
	return ids
}

var anyUUID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func (r *Reader) WitnessWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, w Object) (Object, error) {
	search := object(w["search"])
	query := object(search["query"])
	ref := object(w["ref"])
	kind := str(search, "type")
	if e := requiredScope(a, kind); e != nil {
		return nil, e
	}
	id := str(ref, "id")
	if kind != "opportunity" && !anyUUID.MatchString(id) {
		return nil, fail("invalid_choice_source", 400)
	}
	locator := Object{"type": kind, "id": id}
	var record *protocol.OrderedObject
	var source, version any
	var e error
	switch kind {
	case "history", "case":
		var isCase bool
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM cases WHERE id=$1)", id).Scan(&isCase); e != nil {
			return nil, e
		}
		sourceKind := "task-history"
		if isCase {
			sourceKind = "case-history"
		}
		if kind == "case" && !isCase {
			return nil, fail("choice_source_unavailable")
		}
		locator["kind"], locator["subjectId"] = sourceKind, query["subjectId"]
		record, e = r.readWithin(ctx, tx, a, locator, nil)
		if e != nil {
			return nil, e
		}
		matched, e := historyv2.Relevance(record, query)
		if e != nil {
			return nil, e
		}
		if matched == nil {
			return nil, fail("choice_source_unavailable")
		}
		version, e = historyv2.SourceFingerprint(matched)
		if e != nil {
			return nil, e
		}
	case "capsule":
		record, e = r.readWithin(ctx, tx, a, locator, nil)
		if e != nil {
			return nil, e
		}
		locator["versionId"] = record.Values()["versionId"]
		source = ordered("id", id, "versionId", record.Values()["versionId"], "version", record.Values()["sourceVersion"])
	case "task":
		record, e = r.readWithin(ctx, tx, a, locator, nil)
		if e != nil {
			return nil, e
		}
		source = ordered("taskId", id, "operationId", object(record.Values()["request"])["operationId"])
	case "proof":
		record, e = r.readWithin(ctx, tx, a, locator, nil)
		if e != nil {
			return nil, e
		}
		source = ordered("id", id, "schemaVersion", 2)
	case "opportunity":
		if r.QueryOpportunities == nil {
			return nil, fail("choice_opportunity_reader_unavailable", 503)
		}
		var after any
		seen := map[string]bool{}
		for {
			input := Object{}
			for k, v := range query {
				input[k] = v
			}
			input["after"] = after
			raw, err := r.QueryOpportunities(ctx, tx, &a, input)
			page, err := decodeWire(raw, err)
			if err != nil {
				return nil, err
			}
			if page == nil {
				return nil, fail("choice_source_unavailable")
			}
			for _, v := range array(page.Values()["items"]) {
				o, _ := v.(*protocol.OrderedObject)
				if o != nil && o.Values()["id"] == id {
					record = o
					break
				}
			}
			if record != nil {
				break
			}
			next := str(page.Values(), "nextAfter")
			if next == "" || seen[next] {
				return nil, fail("choice_source_unavailable")
			}
			seen[next] = true
			after = next
		}
		source = record.Values()["opportunityRef"]
		locator["source"], locator["purposes"] = source, object(record.Values()["help"])["purposes"]
	default:
		record, e = r.readWithin(ctx, tx, a, locator, query)
		if e != nil {
			return nil, e
		}
		v := record.Values()
		source = ordered("kind", kind, "id", id, "ownerId", v["ownerId"], "declarationId", v["declarationId"], "declarationHash", v["declarationHash"], "revision", v["revision"], "version", v["version"])
	}
	if version == nil {
		version, e = historyv2.SourceFingerprint(ordered("record", historyv2.VisibleValue(record), "source", source))
		if e != nil {
			return nil, e
		}
	}
	if version != ref["version"] {
		return nil, fail("choice_source_changed")
	}
	durable, e := r.readWithin(ctx, tx, a, locator, nil)
	if e != nil {
		return nil, e
	}
	before, e := historyv2.SourceFingerprint(factual(record))
	if e != nil {
		return nil, e
	}
	after, e := historyv2.SourceFingerprint(factual(durable))
	if e != nil {
		return nil, e
	}
	if before != after {
		return nil, fail("choice_source_changed")
	}
	return Object{"ref": Object{"type": kind, "id": ref["id"], "version": ref["version"]}, "locator": locator, "fingerprint": after, "sourceAuthors": visibleAuthors(durable)}, nil
}
func (r *Reader) StatusWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, dependency Object) (Object, error) {
	current, e := r.readWithin(ctx, tx, a, object(dependency["locator"]), nil)
	state := "current"
	if e != nil {
		if !absent(e) {
			return nil, e
		}
		state = "unavailable"
	} else {
		hash, e := historyv2.SourceFingerprint(factual(current))
		if e != nil {
			return nil, e
		}
		if hash != dependency["fingerprint"] {
			state = "changed"
		}
	}
	if state != "current" {
		subjects := []string{}
		for _, v := range array(dependency["sourceAuthors"]) {
			s, _ := v.(string)
			subjects = append(subjects, s)
		}
		var pending bool
		e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM deletion_requests WHERE subject_id=ANY($1::text[]) AND state IN ('requested','review-needed','approved','partial','primary-erased'))", subjects).Scan(&pending)
		if e != nil {
			return nil, e
		}
		if pending {
			state = "temporarily-unavailable"
		}
	}
	return Object{"ref": dependency["ref"], "state": state}, nil
}
func (r *Reader) ResultWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, ref Object) (Object, error) {
	if !has(a.Scopes, "history") {
		return nil, fail("access_denied", 403)
	}
	history, e := r.historyWithin(ctx, tx, a, Object{"id": ref["caseId"], "kind": "case-history", "subjectId": nil})
	if e != nil {
		return nil, e
	}
	if history != nil {
		for _, v := range array(history.Values()["results"]) {
			result := object(v)
			if result["id"] == ref["id"] && number(result["version"]) == number(ref["version"]) {
				return result, nil
			}
		}
	}
	return nil, fail("choice_source_unavailable")
}
