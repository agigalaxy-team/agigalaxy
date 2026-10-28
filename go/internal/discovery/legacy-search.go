package discovery

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5/pgxpool"
)

// LegacySourceQuery is an owning reader, including its normal authorization
// and ordered wire projection. Candidate IDs never grant access.
type LegacySourceQuery func(context.Context, *deviceauth.Actor, []byte, []string) (json.RawMessage, error)
type LegacySearch struct {
	Pool                                       *pgxpool.Pool
	Endpoint                                   string
	Devices                                    *deviceauth.Service
	Proofs                                     *evidence.ProofService
	HistoryQuery, BuildersQuery, CapsulesQuery LegacySourceQuery
	Index                                      *LegacyIndex
	Now                                        func() time.Time
}

func ordered(pairs ...any) *protocol.OrderedObject {
	o := protocol.NewOrderedObject()
	for i := 0; i < len(pairs); i += 2 {
		o.Set(pairs[i].(string), pairs[i+1])
	}
	return o
}
func values(v any) Object {
	if o, ok := v.(*protocol.OrderedObject); ok {
		return o.Values()
	}
	return object(v)
}
func orderedPage(raw []byte) (Object, error) {
	v, e := protocol.DecodeOrdered(raw)
	if e != nil {
		return nil, e
	}
	o := values(v)
	if o == nil {
		return nil, errors.New("search owning source returned invalid page")
	}
	return o, nil
}
func (s *LegacySearch) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func (s *LegacySearch) page(kind string, items []any, next any, limited bool) *protocol.OrderedObject {
	return ordered("version", 1, "type", kind, "items", items, "nextCursor", next, "windowLimited", limited, "checkedAt", s.now(), "order", "source-id", "countsScope", "visible-page-only", "pageCount", len(items), "capabilityVerified", false, "cacheable", false, "endpoint", s.Endpoint)
}
func (s *LegacySearch) QueryWire(ctx context.Context, a *deviceauth.Actor, raw []byte) (json.RawMessage, error) {
	kind, q, e := parseLegacySearch(raw)
	if e != nil {
		return nil, e
	}
	var candidates []string
	var indexed, truncated bool
	if a == nil && s.Index != nil {
		subject := str(q, "ownerId")
		if subject == "" {
			subject = str(q, "authorId")
		}
		if subject == "" {
			subject = str(q, "subjectId")
		}
		result, e := s.Index.Candidates(ctx, kind, LegacyCandidateQuery{After: str(q, "after"), SubjectID: subject, Query: str(q, "query"), Limit: 200})
		if e != nil {
			return nil, e
		}
		indexed = result["enabled"] == true
		truncated = result["truncated"] == true
		if indexed {
			candidates = []string{}
			for _, item := range result["items"].([]Object) {
				candidates = append(candidates, str(item, "id"))
			}
		}
	}
	var page *protocol.OrderedObject
	if kind == "proof" {
		page, e = s.proofQuery(ctx, a, q, candidates)
	} else {
		read := s.HistoryQuery
		if kind == "worker" || kind == "hub" {
			read = s.BuildersQuery
			q["type"] = kind
		} else if kind == "capsule" {
			read = s.CapsulesQuery
		}
		if read == nil {
			return nil, fail("search_source_unavailable")
		}
		wire, e2 := read(ctx, a, []byte(jsonString(q)), candidates)
		if e2 != nil {
			return nil, e2
		}
		source, e2 := orderedPage(wire)
		if e2 != nil {
			return nil, e2
		}
		items := []any{}
		rows, ok := source["items"].([]any)
		if !ok {
			return nil, errors.New("search owning source returned invalid items")
		}
		for _, record := range rows {
			item := values(record)
			if item == nil {
				return nil, errors.New("search owning source returned invalid item")
			}
			var result *protocol.OrderedObject
			if kind == "worker" || kind == "hub" {
				result = ordered("type", kind, "id", item["builderId"], "title", item["name"], "summary", item["scope"], "source", ordered("kind", kind, "id", item["builderId"], "ownerId", item["ownerId"], "declarationId", item["declarationId"], "declarationHash", item["declarationHash"], "revision", item["revision"], "version", item["version"]), "record", record, "matchReasons", item["matchReasons"], "limitations", []string{"Registry owner declaration; not an active Worker or Hub connection.", "Compatibility and heartbeat reports are separate from capability certification; endpoint reachability is not established."})
			} else if kind == "capsule" {
				text := str(q, "query")
				if text == "" {
					text = "(no text filter)"
				}
				reasons := []string{"title/problem contains: " + text}
				if str(q, "capabilityId") != "" {
					reasons = append(reasons, "author-declared capability: "+str(q, "capabilityId"))
				}
				result = ordered("type", kind, "id", item["capsuleId"], "title", item["title"], "summary", item["capabilityId"], "source", ordered("kind", "capsule", "id", item["capsuleId"], "versionId", item["versionId"], "version", item["version"]), "record", record, "matchReasons", reasons, "limitations", []string{"Author-published reusable method; applicability and current notices must be checked."})
			} else {
				limitations := values(item["searchExplanation"])["limitations"]
				if limitations == nil {
					limitations = []string{"Owner-reported Case facts; not individual capability certification."}
				}
				result = ordered("type", kind, "id", item["caseId"], "title", item["title"], "summary", item["summary"], "source", ordered("kind", kind, "id", item["caseId"], "sourceVersion", item["sourceVersion"], "projectionRule", values(item["rebuild"])["rule"]), "record", record, "matchReasons", item["matchReasons"], "limitations", limitations)
			}
			items = append(items, result)
		}
		next := source["nextAfter"]
		limited := source["windowLimited"] == true
		if kind == "case" || kind == "history" {
			next = source["nextCursor"]
			limited = values(source["search"])["windowLimited"] == true
		}
		page = s.page(kind, items, next, limited)
	}
	if e != nil {
		return nil, e
	}
	if indexed {
		page.Set("index", ordered("mode", "public-candidate-index", "freshnessLimitSeconds", 60, "currentSourceChecked", true))
		page.Set("windowLimited", page.Values()["windowLimited"] == true || truncated)
		if page.Values()["nextCursor"] == nil && truncated {
			items := page.Values()["items"].([]any)
			if len(items) > 0 {
				page.Set("nextCursor", values(items[len(items)-1])["id"])
			}
		}
	}
	wire, e := protocol.EncodeJS(page)
	return json.RawMessage(wire), e
}

func legacyError() error { return fault.New("invalid_search_query", 400) }

var legacyCapability = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$`)
var legacyDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$`)

func parseLegacySearch(raw []byte) (string, Object, error) {
	var root Object
	if decode(raw, &root) != nil || !onlyKeys(root, "type", "query") {
		return "", nil, legacyError()
	}
	kind := str(root, "type")
	q := object(root["query"])
	if !slices.Contains([]string{"case", "history", "proof", "capsule", "worker", "hub"}, kind) || q == nil {
		return "", nil, legacyError()
	}
	allowed := []string{"query", "after", "limit"}
	switch kind {
	case "case", "history":
		allowed = append(allowed, "subjectId", "outcome", "capabilityId", "verificationStrength", "sourceKind", "environment", "createdFrom", "createdBefore")
	case "proof":
		allowed = append(allowed, "subjectId", "conclusion")
	case "worker", "hub":
		allowed = append(allowed, "ownerId")
	case "capsule":
		allowed = append(allowed, "authorId", "capabilityId")
	}
	if !onlyKeys(q, allowed...) {
		return "", nil, legacyError()
	}
	if v, ok := q["query"]; ok {
		str, ok := v.(string)
		if !ok {
			return "", nil, legacyError()
		}
		q["query"] = strings.TrimFunc(str, jsSpace)
	} else {
		q["query"] = ""
	}
	if codePointLength(str(q, "query")) > 200 || kind != "capsule" && len(legacyTerms(str(q, "query"))) > 8 {
		return "", nil, legacyError()
	}
	if v, ok := q["limit"]; ok {
		n, valid := integer(v)
		if !valid || n < 1 || n > 20 {
			return "", nil, legacyError()
		}
		q["limit"] = n
	} else {
		q["limit"] = 8
	}
	for key, v := range q {
		if key == "query" || key == "limit" {
			continue
		}
		text, ok := v.(string)
		if !ok {
			return "", nil, legacyError()
		}
		switch key {
		case "after":
			if !validID(text) {
				return "", nil, legacyError()
			}
		case "subjectId", "ownerId", "authorId":
			if !moderatorID.MatchString(text) {
				return "", nil, legacyError()
			}
		case "capabilityId":
			if !legacyCapability.MatchString(text) {
				return "", nil, legacyError()
			}
		case "outcome":
			if !slices.Contains([]string{"succeeded", "partial", "failed", "inconclusive", "conflicting"}, text) {
				return "", nil, legacyError()
			}
		case "verificationStrength":
			if text != "reported-only" && text != "ci-execution-fact" {
				return "", nil, legacyError()
			}
		case "sourceKind":
			if !slices.Contains([]string{"local", "bridge", "hub"}, text) {
				return "", nil, legacyError()
			}
		case "environment":
			text = strings.TrimFunc(text, jsSpace)
			if codePointLength(text) < 1 || codePointLength(text) > 160 {
				return "", nil, legacyError()
			}
			q[key] = text
		case "createdFrom", "createdBefore":
			if !legacyDate.MatchString(text) {
				return "", nil, legacyError()
			}
			if _, e := time.Parse(time.RFC3339Nano, text); e != nil {
				return "", nil, legacyError()
			}
		case "conclusion":
			if !slices.Contains([]string{"success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "startup_failure"}, text) {
				return "", nil, legacyError()
			}
		}
	}
	if str(q, "createdFrom") != "" && str(q, "createdBefore") != "" {
		from, _ := time.Parse(time.RFC3339Nano, str(q, "createdFrom"))
		before, _ := time.Parse(time.RFC3339Nano, str(q, "createdBefore"))
		if !from.Before(before) {
			return "", nil, legacyError()
		}
	}
	return kind, q, nil
}
