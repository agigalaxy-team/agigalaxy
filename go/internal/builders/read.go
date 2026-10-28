package builders

import (
	"context"
	"encoding/json"
	"strings"
	"time"
	"unicode"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

type QueryOptions struct {
	PublicOnly   bool
	CandidateIDs []string
	SourceSearch bool
}

func ordered(pairs ...any) *protocol.OrderedObject {
	o := protocol.NewOrderedObject()
	for i := 0; i+1 < len(pairs); i += 2 {
		o.Set(pairs[i].(string), pairs[i+1])
	}
	return o
}
func orderKeys(value Object, keys ...string) *protocol.OrderedObject {
	o := protocol.NewOrderedObject()
	for _, key := range keys {
		if v, ok := value[key]; ok {
			o.Set(key, v)
		}
	}
	return o
}
func (s *Service) proofReferences(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, owner string, ids []any) ([]any, error) {
	out := []any{}
	for _, raw := range ids {
		id, _ := raw.(string)
		read := func() error {
			row, e := one(ctx, tx, "SELECT subject_id FROM proofs WHERE id=$1", id)
			if e != nil {
				return e
			}
			if row["subject_id"] != owner {
				return fault.New("builder_proof_owner_mismatch", 409)
			}
			if s.Proofs == nil {
				return fault.New("builder_proof_service_unavailable", 503)
			}
			_, e = s.Proofs.ReadWithin(ctx, tx, a, id, false)
			return e
		}
		if e := read(); e != nil {
			if !domainError(e) {
				return nil, e
			}
			out = append(out, Object{"proofId": id, "state": "unavailable", "builderAttributionVerified": false})
		} else {
			out = append(out, Object{"proofId": id, "state": "current", "relationship": "owner-ci-observation", "builderAttributionVerified": false})
		}
	}
	return out, nil
}
func (s *Service) workEvidence(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, b loadedBuilder, node Object) (Object, error) {
	items := []any{}
	last := map[string]any{}
	group := func(v Object) string {
		raw, _ := protocol.Encode([]any{v["declarationId"], v["controlId"], v["caseId"], v["attemptId"], v["resultId"]})
		return string(raw)
	}
	for _, row := range b.rows {
		if row["kind"] == "work-evidence" {
			last[group(event(row))] = row["id"]
		}
	}
	count := 0
	for _, row := range b.rows {
		if row["kind"] != "work-evidence" {
			continue
		}
		permitted, e := s.permitted(ctx, tx, a, row)
		if e != nil {
			return nil, e
		}
		if !permitted {
			continue
		}
		v := event(row)
		revoked := false
		for _, r := range b.rows {
			revoked = revoked || r["kind"] == "work-evidence-revoke" && event(r)["workEventId"] == row["id"]
		}
		state := "current"
		switch {
		case revoked:
			state = "revoked"
		case last[group(v)] != row["id"]:
			state = "superseded"
		case v["declarationId"] != b.declaration["id"] || v["declarationHash"] != b.declaration["payload_hash"]:
			state = "stale-declaration"
		case node["state"] != "node-authorized-owner" || node["controlId"] != v["controlId"]:
			state = "node-authorization-unavailable"
		}
		var source Object
		if state == "current" {
			source, e = s.workSources(ctx, tx, a, v)
			if e != nil {
				if !domainError(e) {
					return nil, e
				}
				state = "source-unavailable"
			}
		}
		item := Object{"eventId": row["id"], "nodeId": row["subject_id"], "declarationId": v["declarationId"], "controlId": v["controlId"], "state": state, "authority": "node-signed-source-association", "nodeConsentVerified": true, "executionAttributionVerified": false, "capabilityVerified": false}
		if source != nil {
			item["summary"] = v["summary"]
			item["source"] = source
			if v["task"] != nil {
				task := clone(obj(v["task"]))
				task["authority"] = "node-declared-task-reference"
				task["endpointProbed"] = false
				item["task"] = task
			}
		}
		if state == "current" {
			count++
		}
		items = append(items, item)
	}
	return Object{"items": items, "currentCount": count, "countMeaning": "current-node-associations; not independent evidence count", "scope": "exact-declaration-and-node-authorization", "executionAttributionVerified": false}, nil
}
func (s *Service) ReadWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, input Object) (Object, error) {
	b, e := s.load(ctx, tx, txt(input, "builderId"), false)
	if e != nil {
		return nil, e
	}
	declaration, g, e := s.current(ctx, tx, a, b)
	if e != nil {
		return nil, e
	}
	state := maintenance(b.rows)
	notices, reports, versions := []any{}, []any{}, []any{}
	var heartbeat Object
	last := map[string]any{}
	for _, row := range b.rows {
		if row["kind"] == "compatibility" && event(row)["declarationId"] == b.declaration["id"] {
			last[txt(row, "subject_id")] = row["id"]
		}
	}
	for _, row := range b.rows {
		allowed, e := s.permitted(ctx, tx, a, row)
		if e != nil {
			return nil, e
		}
		if !allowed {
			continue
		}
		v := event(row)
		switch row["kind"] {
		case "declare":
			versions = append(versions, Object{"declarationId": row["id"], "revision": row["revision"], "name": obj(v["declaration"])["name"], "version": obj(obj(v["declaration"])["release"])["version"]})
		case "maintenance":
			item := Object{"eventId": row["id"], "revision": row["revision"]}
			for k, value := range v {
				item[k] = value
			}
			notices = append(notices, item)
		case "heartbeat":
			if v["declarationId"] == b.declaration["id"] {
				heartbeat = Object{"receivedAt": row["received_at"], "eventId": row["id"]}
			}
		case "compatibility":
			suite := s.suite(obj(v["suite"]), num(v, "observedAt"))
			validity := "current"
			switch {
			case v["declarationId"] != b.declaration["id"]:
				validity = "stale-declaration"
			case !contains(s.AssessorIDs, txt(row, "subject_id")):
				validity = "assessor-removed"
			case last[txt(row, "subject_id")] != row["id"]:
				validity = "superseded"
			case num(v, "expiresAt") <= s.now():
				validity = "expired"
			case suite["state"] != "current" && suite["state"] != "untracked":
				validity = "suite-" + txt(suite, "state")
			}
			missing := []any{}
			required := []string{"ids", "evidence", "signatures", "schema", "import", "privacy", "revocation"}
			for _, id := range required {
				found := false
				for _, raw := range arr(v["checks"]) {
					found = found || obj(raw)["id"] == id
				}
				if !found {
					missing = append(missing, id)
				}
			}
			profile := v["profile"]
			if profile == nil {
				profile = "galaxy-conformance/1"
			}
			report := clone(v)
			for k, value := range (Object{"assessorId": row["subject_id"], "validity": validity, "suiteStatus": suite, "coverage": Object{"profile": profile, "required": 7, "reported": len(arr(v["checks"])), "missing": missing, "complete": len(missing) == 0}, "authority": "configured-assessor-reported"}) {
				report[k] = value
			}
			reports = append(reports, report)
		}
	}
	active, failed, passed, full := 0, false, false, false
	for _, raw := range reports {
		report := obj(raw)
		if report["validity"] != "current" {
			continue
		}
		active++
		allPass := true
		for _, raw := range arr(report["checks"]) {
			check := obj(raw)
			failed = failed || check["status"] == "fail"
			allPass = allPass && check["status"] == "pass"
		}
		passed = passed || allPass
		full = full || allPass && obj(report["coverage"])["complete"] == true
	}
	compatibility, fullScope := "unverified", "unverified"
	if active > 0 {
		compatibility = "incomplete"
		fullScope = "incomplete"
	}
	if passed {
		compatibility = "reported-pass"
	}
	if full {
		fullScope = "reported-pass"
	}
	if failed {
		compatibility = "reported-fail"
		fullScope = "reported-fail"
	}
	proofs, e := s.proofReferences(ctx, tx, a, txt(b.parent, "owner_id"), arr(declaration["proofIds"]))
	if e != nil {
		return nil, e
	}
	node, e := s.nodeControl(ctx, tx, a, b, declaration)
	if e != nil {
		return nil, e
	}
	work, e := s.workEvidence(ctx, tx, a, b, node)
	if e != nil {
		return nil, e
	}
	beat := Object{"state": "unknown"}
	if heartbeat != nil {
		if s.now()-num(heartbeat, "receivedAt") <= 900 {
			beat["state"] = "recent-owner-heartbeat"
		}
		beat["receivedAt"] = heartbeat["receivedAt"]
		beat["eventId"] = heartbeat["eventId"]
	}
	beat["endpointProbed"] = false
	beat["endpointReachable"] = nil
	beat["capabilityVerified"] = false
	reach, e := s.reachability(ctx, tx, a, b, declaration, beat)
	if e != nil {
		return nil, e
	}
	evidenceState := "none-current"
	for _, p := range proofs {
		if obj(p)["state"] == "current" {
			evidenceState = "owner-ci-evidence"
		}
	}
	if num(work, "currentCount") > 0 {
		evidenceState = "node-attested-ci-evidence"
	}
	out := Object{"builderId": b.parent["id"], "ownerId": b.parent["owner_id"], "type": b.parent["type"], "revision": b.parent["revision"], "declarationId": b.declaration["id"], "declarationHash": b.declaration["payload_hash"], "declaration": declaration, "versions": versions, "notices": notices, "reports": reports, "registration": Object{"state": "registered", "control": "authenticated registry owner; Node approval is separate; endpoint control not established"}, "nodeControl": node, "compatibility": Object{"state": compatibility, "fullScopeState": fullScope, "blockedByMaintenance": state["delisted"] == true || state["securityIssue"] == true, "capabilityVerified": false}, "reachability": reach, "evidence": Object{"state": evidenceState, "items": proofs, "nodeWorkEvidence": work, "builderAttributionVerified": false}, "delisted": state["delisted"], "securityIssue": state["securityIssue"], "capabilityVerified": false, "checkedAt": s.now()}
	if state["delisted"] == true {
		obj(out["registration"])["state"] = "delisted"
	}
	if a != nil && a.SubjectID == txt(b.parent, "owner_id") {
		out["disclosure"] = Object{"visibility": g.Visibility, "viewers": g.Viewers}
	}
	if a != nil && declaration["type"] == "worker" && a.SubjectID == txt(declaration, "nodeId") {
		viewers := g.Viewers
		if a.SubjectID != txt(b.parent, "owner_id") {
			viewers = reportViewers(g, txt(b.parent, "owner_id"), a.SubjectID)
		}
		out["nodeControlDisclosure"] = Object{"visibility": g.Visibility, "viewers": viewers}
	}
	if a != nil && a.SubjectID != txt(b.parent, "owner_id") && contains(s.AssessorIDs, a.SubjectID) {
		out["reportDisclosure"] = Object{"visibility": g.Visibility, "viewers": reportViewers(g, txt(b.parent, "owner_id"), a.SubjectID)}
	}
	return out, nil
}
func (s *Service) Get(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	input, e := parse("builderReadSchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		return s.ReadWithin(ctx, tx, a, input)
	})
}
func (s *Service) QueryWire(ctx context.Context, a *deviceauth.Actor, raw []byte, options QueryOptions) (json.RawMessage, error) {
	input, e := parse("builderQuerySchema", raw)
	if e != nil {
		return nil, e
	}
	value, e := s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		viewer := a
		if options.PublicOnly {
			viewer = nil
		}
		var viewerID any
		if viewer != nil {
			viewerID = viewer.SubjectID
		}
		rows, e := query(ctx, tx, `SELECT p.id::text FROM builders p JOIN builder_events e ON e.builder_id=p.id AND e.kind='declare' AND NOT EXISTS(SELECT 1 FROM builder_events newer WHERE newer.builder_id=p.id AND newer.kind='declare' AND newer.revision>e.revision) JOIN consents c ON c.id=e.consent_id JOIN bindings b ON b.id=c.binding_id WHERE ($1::uuid IS NULL OR p.id>$1) AND ($2::text IS NULL OR p.type=$2) AND ($3::text IS NULL OR p.owner_id=$3) AND ($7::uuid[] IS NULL OR p.id=ANY($7)) AND c.subject_id=e.subject_id AND b.subject_id=e.subject_id AND c.revoked_at IS NULL AND b.revoked_at IS NULL AND c.expires_at>$5 AND b.expires_at>$5 AND c.intent->>'recipient'=$6 AND c.intent->>'action'='builder.publish' AND c.intent->>'objectId'=e.id::text AND c.intent->>'payloadHash'=e.payload_hash AND (p.owner_id=$4 OR c.intent->>'visibility'='Public' AND c.intent->>'purpose'='public-profile' OR c.intent->>'visibility'='Private' AND c.intent->'viewers' ? COALESCE($4,'')) ORDER BY p.id LIMIT 201`, input["after"], input["type"], input["ownerId"], viewerID, time.Unix(s.now(), 0), s.Endpoint, options.CandidateIDs)
		if e != nil {
			return nil, e
		}
		items := []any{}
		var last any
		limit := int(num(input, "limit"))
		window := rows
		if len(window) > 200 {
			window = window[:200]
		}
		for _, row := range window {
			item, e := s.ReadWithin(ctx, tx, viewer, Object{"builderId": row["id"]})
			if e != nil {
				if domainError(e) {
					continue
				}
				return nil, e
			}
			if item["delisted"] == true && (viewer == nil || viewer.SubjectID != txt(item, "ownerId")) {
				continue
			}
			last = row["id"]
			declaration := obj(item["declaration"])
			fields := searchFields(declaration)
			query := txt(input, "query")
			lower := cases.Lower(language.English)
			terms := []string{}
			for _, term := range strings.FieldsFunc(lower.String(query), jsSpace) {
				if !contains(terms, term) {
					terms = append(terms, term)
				}
			}
			matches := []string{}
			all := true
			for _, term := range terms {
				keys := []string{}
				for _, field := range fields {
					if strings.Contains(lower.String(field.value), term) {
						keys = append(keys, field.key)
					}
				}
				if len(keys) == 0 {
					all = false
				}
				matches = append(matches, term+" → "+strings.Join(keys, ", "))
			}
			if options.SourceSearch {
				if !all {
					continue
				}
			} else if !strings.Contains(cases.Lower(language.Und).String(txt(declaration, "name")+" "+txt(declaration, "scope")), cases.Lower(language.Und).String(query)) {
				continue
			}
			wire := ordered("builderId", item["builderId"], "ownerId", item["ownerId"], "type", item["type"], "name", declaration["name"], "version", obj(declaration["release"])["version"], "registration", orderKeys(obj(item["registration"]), "state", "control"), "nodeControl", orderKeys(obj(item["nodeControl"]), "state", "capabilityVerified", "endpointControlVerified", "controlId", "nodeId", "ownerId", "expiresAt", "authority"), "compatibility", orderKeys(obj(item["compatibility"]), "state", "fullScopeState", "blockedByMaintenance", "capabilityVerified"), "reachability", orderKeys(obj(item["reachability"]), "state", "receivedAt", "eventId", "endpointProbed", "endpointReachable", "capabilityVerified", "scope", "endpointControlVerified", "reason", "requestId", "endpoint", "cardUrl", "observation", "job"), "evidence", obj(item["evidence"])["state"], "securityIssue", item["securityIssue"])
			if options.SourceSearch {
				wire.Set("revision", item["revision"])
				wire.Set("declarationId", item["declarationId"])
				wire.Set("declarationHash", item["declarationHash"])
				wire.Set("scope", declaration["scope"])
				if len(matches) == 0 {
					matches = []string{"current public declaration; source ID order"}
				}
				wire.Set("matchReasons", matches)
			}
			items = append(items, wire)
			if len(items) > limit {
				break
			}
		}
		var after any
		limited := len(items) <= limit && len(rows) > 200
		if len(items) > limit {
			items = items[:limit]
			after = obj(items[len(items)-1])["builderId"]
		} else if limited {
			after = last
		}
		return Object{"wire": ordered("items", items, "nextAfter", after, "windowLimited", limited, "automaticEndpointProbes", false)}, nil
	})
	if e != nil {
		return nil, e
	}
	out, e := protocol.EncodeJS(value["wire"])
	return json.RawMessage(out), e
}
func (s *Service) Query(ctx context.Context, a *deviceauth.Actor, raw []byte, options QueryOptions) (Object, error) {
	wire, e := s.QueryWire(ctx, a, raw, options)
	if e != nil {
		return nil, e
	}
	var out Object
	e = protocol.Decode(wire, &out)
	return out, e
}
func jsSpace(r rune) bool {
	return r == '\ufeff' || r == '\u000b' || r == '\u000c' || r == '\u0009' || r == '\u000a' || r == '\u000d' || r == '\u2028' || r == '\u2029' || unicode.Is(unicode.Zs, r)
}

type searchField struct{ key, value string }

func searchFields(d Object) []searchField {
	out := []searchField{{"name", txt(d, "name")}, {"scope", txt(d, "scope")}, {"version", txt(obj(d["release"]), "version")}}
	join := func(v any) string {
		items := []string{}
		for _, raw := range arr(v) {
			s, _ := raw.(string)
			items = append(items, s)
		}
		return strings.Join(items, " ")
	}
	if d["type"] == "worker" {
		c := obj(d["configuration"])
		out = append(out, searchField{"configuration", txt(c, "summary")}, searchField{"modelFamily", txt(c, "modelFamily")}, searchField{"tools", join(c["tools"])}, searchField{"taskTypes", join(c["taskTypes"])})
		items := []string{}
		for _, raw := range arr(d["capabilities"]) {
			v := obj(raw)
			items = append(items, txt(v, "id")+" "+txt(v, "claim")+" "+txt(v, "limitations"))
		}
		out = append(out, searchField{"capabilities", strings.Join(items, " ")})
	}
	if d["type"] == "hub" {
		out = append(out, searchField{"operator", txt(d, "operator")}, searchField{"region", txt(d, "region")}, searchField{"endpoint", txt(d, "endpoint")}, searchField{"specVersion", txt(obj(d["manifest"]), "specVersion")})
	}
	return out
}
