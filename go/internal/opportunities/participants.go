package opportunities

import (
	"context"
	"encoding/json"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

// ParticipantsQuery searches only projections that their owning service permits
// the current viewer to read. The bounded scan is not a global ranking.
func (s *Service) ParticipantsQuery(ctx context.Context, a *deviceauth.Actor, input Object) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return s.ParticipantsQueryWithin(ctx, tx, a, input) })
}
func participantOptions(input Object) (Object, error) {
	if input == nil || !exact(input, "query", "functions", "types", "after", "limit") {
		return nil, invalid()
	}
	query, ok := input["query"].(string)
	query = trim(query)
	if !ok || query == "" || utf8.RuneCountInString(query) > 2000 || len(participantTerms(query)) == 0 {
		return nil, invalid()
	}
	out := Object{"query": query, "limit": int64(20), "functions": []string{}, "types": []string{}}
	for _, key := range []string{"functions", "types"} {
		raw, exists := input[key]
		if !exists {
			continue
		}
		var values []string
		switch x := raw.(type) {
		case []string:
			values = x
		case []any:
			for _, v := range x {
				t, ok := v.(string)
				if !ok {
					return nil, invalid()
				}
				values = append(values, t)
			}
		default:
			return nil, invalid()
		}
		if len(values) > 16 {
			return nil, invalid()
		}
		clean := []string{}
		for _, v := range values {
			v = trim(v)
			if v == "" || utf8.RuneCountInString(v) > 80 || has(clean, v) {
				return nil, invalid()
			}
			if key == "types" && !has([]string{"person", "organization", "agent", "tool", "team", "service", "unknown"}, v) {
				return nil, invalid()
			}
			clean = append(clean, v)
		}
		out[key] = clean
	}
	if v, exists := input["limit"]; exists {
		n, ok := safeInt(v, 1, 20)
		if !ok {
			return nil, invalid()
		}
		out["limit"] = n
	}
	if v, exists := input["after"]; exists && v != nil {
		text, ok := v.(string)
		if !ok || len(text) == 0 || len(text) > 4096 {
			return nil, invalid()
		}
		out["after"] = text
	}
	return out, nil
}
func participantTerms(query string) []string {
	var out []string
	add := func(x string) {
		if x != "" && !has(out, x) && len(out) < 32 {
			out = append(out, x)
		}
	}
	r := []rune(strings.ToLower(query))
	for i := 0; i < len(r) && len(out) < 32; {
		if !unicode.IsLetter(r[i]) && !unicode.IsDigit(r[i]) {
			i++
			continue
		}
		han := unicode.Is(unicode.Han, r[i])
		j := i + 1
		for j < len(r) && (unicode.IsLetter(r[j]) || unicode.IsDigit(r[j])) && unicode.Is(unicode.Han, r[j]) == han {
			j++
		}
		part := r[i:j]
		if han && len(part) > 3 {
			for k := 0; k+3 <= len(part) && len(out) < 32; k++ {
				add(string(part[k : k+3]))
			}
		} else {
			add(string(part))
		}
		i = j
	}
	return out
}
func participantMatch(candidate Object, query string, functions, types []string) ([]string, bool) {
	if len(types) > 0 && !has(types, str(candidate, "kind")) {
		return nil, false
	}
	fields := []struct{ name, value string }{{"name", str(candidate, "displayName")}, {"summary", str(candidate, "summary")}, {"functions", strings.Join(stringsOf(candidate["functions"]), " ")}, {"claims", strings.Join(stringsOf(candidate["claims"]), " ")}}
	reasons := []string{}
	terms := participantTerms(query)
	for _, term := range terms {
		for _, field := range fields {
			if strings.Contains(strings.ToLower(field.value), term) {
				reasons = append(reasons, field.name+": "+term)
				break
			}
		}
	}
	if len(reasons) == 0 {
		return nil, false
	}
	if len(functions) > 0 {
		matched := false
		for _, f := range functions {
			for _, v := range stringsOf(candidate["functions"]) {
				if strings.Contains(strings.ToLower(v), strings.ToLower(f)) {
					matched = true
					break
				}
			}
		}
		if !matched {
			return nil, false
		}
	}
	return reasons, true
}
func (s *Service) ParticipantsQueryWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, input Object) (Object, error) {
	options, e := participantOptions(input)
	if e != nil {
		return nil, e
	}
	if e = s.authorize(ctx, tx, a); e != nil {
		return nil, e
	}
	viewer := ""
	if a != nil {
		viewer = a.SubjectID
	}
	hashInput := Object{"mode": "participants-v1", "query": options["query"], "functions": options["functions"], "types": options["types"], "limit": options["limit"]}
	raw, e := json.Marshal(hashInput)
	if e != nil {
		return nil, e
	}
	hash := identity.Digest(raw)
	after := ""
	if cursor := str(options, "after"); cursor != "" {
		v, e := s.OpenCursor(cursor, hash, viewer)
		if e != nil {
			return nil, e
		}
		after = str(v, "startAfter")
	}
	window := s.ScanWindowLimit
	if window == 0 {
		window = 200
	}
	if window < 1 || window > 200 {
		return nil, fail("invalid_discovery_scan_window", 500)
	}
	sources := []string{"SELECT 'profile:' || subject_id AS key FROM profile_statements"}
	if s.Projects != nil {
		sources = append(sources, "SELECT 'project:' || id::text AS key FROM projects_v2 WHERE state='active'")
	}
	if s.ParticipantBuilders != nil {
		sources = append(sources, "SELECT 'builder:' || id::text AS key FROM builders")
	}
	if s.ParticipantRecruitment != nil {
		sources = append(sources, "SELECT 'recruitment:' || id::text AS key FROM recruitment_opportunities WHERE state='active'")
	}
	rows, e := tx.Query(ctx, "SELECT DISTINCT key FROM ("+strings.Join(sources, " UNION ALL ")+") sources WHERE key>$1 ORDER BY key LIMIT $2", after, window+1)
	if e != nil {
		return nil, e
	}
	keys := []string{}
	for rows.Next() {
		var key string
		if e = rows.Scan(&key); e != nil {
			rows.Close()
			return nil, e
		}
		keys = append(keys, key)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	items := []Object{}
	last := ""
	more := false
	for i, key := range keys {
		if i >= window {
			more = true
			break
		}
		last = key
		parts := strings.SplitN(key, ":", 2)
		candidate, e := s.participantWithin(ctx, tx, a, parts[0], parts[1])
		if e != nil {
			return nil, e
		}
		if candidate == nil {
			continue
		}
		reasons, match := participantMatch(candidate, str(options, "query"), stringsOf(options["functions"]), stringsOf(options["types"]))
		if !match {
			continue
		}
		candidate["matchReasons"] = reasons
		items = append(items, candidate)
		if len(items) >= int(number(options["limit"])) {
			more = i+1 < len(keys)
			break
		}
	}
	var next any
	if more && last != "" {
		next, e = s.SealCursor(Object{"v": 2, "queryHash": hash, "viewerId": nullable(viewer), "startAfter": last})
		if e != nil {
			return nil, e
		}
	}
	return Object{"schemaVersion": 2, "items": items, "nextAfter": next, "coverage": Object{"scanWindowLimit": window, "windowLimited": more, "ordering": "source-id", "globalRanking": false}, "interpretation": "user-side-model-or-user", "capabilityVerified": false}, nil
}
func (s *Service) ParticipantsDetail(ctx context.Context, a *deviceauth.Actor, input Object) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return s.ParticipantsDetailWithin(ctx, tx, a, input) })
}
func (s *Service) ParticipantsDetailWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, input Object) (Object, error) {
	if input == nil || !exact(input, "sourceKind", "id") {
		return nil, invalid()
	}
	kind, id := str(input, "sourceKind"), str(input, "id")
	if !has([]string{"profile", "project", "builder", "recruitment"}, kind) || (kind == "profile" && !Subject.MatchString(id)) || (kind != "profile" && !UUID.MatchString(id)) {
		return nil, invalid()
	}
	if e := s.authorize(ctx, tx, a); e != nil {
		return nil, e
	}
	candidate, e := s.participantWithin(ctx, tx, a, kind, id)
	if e != nil {
		return nil, e
	}
	if candidate == nil {
		return nil, fail("discovery_participant_unavailable", 404)
	}
	return Object{"schemaVersion": 2, "participant": candidate, "interpretation": "user-side-model-or-user", "capabilityVerified": false}, nil
}
func (s *Service) participantWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, kind, id string) (Object, error) {
	var subject, name, summary, participantKind string
	var functions, claims []string
	var source any
	contact := "unknown"
	basis := "self-declared"
	switch kind {
	case "profile":
		if s.Profiles == nil {
			return nil, fail("discovery_profile_unavailable", 503)
		}
		v, e := s.Profiles.ReadWithin(ctx, tx, a, id)
		if e != nil {
			return nil, e
		}
		if obj(v, "selfDeclaredSource") == nil {
			return nil, nil
		}
		d := obj(v, "selfDeclared")
		subject = id
		name = str(d, "displayName")
		summary = str(d, "about")
		functions = stringsOf(d["claimedCapabilities"])
		source = v["selfDeclaredSource"]
		participantKind = "unknown"
	case "project":
		if s.Projects == nil {
			return nil, nil
		}
		v, e := s.Projects.ReadWithin(ctx, tx, a, id)
		if e != nil {
			if unavailableParticipant(e) {
				return nil, nil
			}
			return nil, e
		}
		d := obj(v, "document")
		if truth(obj(v, "operationsVisibility"), "hidden") || !truth(d, "discoverable") {
			return nil, nil
		}
		subject = str(v, "ownerId")
		name = str(d, "title")
		summary = str(d, "summary")
		functions = stringsOf(d["functions"])
		source = v["source"]
		participantKind = str(d, "participantKind")
	case "builder":
		if s.ParticipantBuilders == nil {
			return nil, nil
		}
		v, e := s.ParticipantBuilders.ReadWithin(ctx, tx, a, Object{"builderId": id})
		if e != nil {
			if unavailableParticipant(e) {
				return nil, nil
			}
			return nil, e
		}
		if truth(v, "delisted") {
			return nil, nil
		}
		d := obj(v, "declaration")
		subject = str(v, "ownerId")
		name = str(d, "name")
		summary = str(d, "scope")
		participantKind = "service"
		if str(v, "type") == "worker" {
			participantKind = "agent"
		}
		source = Object{"builderId": id, "declarationId": v["declarationId"], "declarationHash": v["declarationHash"]}
		configuration := obj(d, "configuration")
		functions = append(stringsOf(configuration["taskTypes"]), stringsOf(configuration["tools"])...)
		for _, capability := range objectItems(d["capabilities"]) {
			if claim := str(capability, "claim"); claim != "" {
				claims = append(claims, claim)
			}
		}
	case "recruitment":
		if s.ParticipantRecruitment == nil {
			return nil, nil
		}
		v, e := s.ParticipantRecruitment.ReadWithin(ctx, tx, a, id, false)
		if e != nil {
			if unavailableParticipant(e) {
				return nil, nil
			}
			return nil, e
		}
		d := obj(v, "document")
		subject = str(v, "contactSubjectId")
		name = str(d, "title")
		summary = str(d, "summary")
		functions = stringsOf(d["functions"])
		source = v["originalSource"]
		participantKind = "unknown"
		basis = "role-requirement-not-capability"
		if truth(v, "acceptingContacts") {
			contact = "open-for-recruitment"
		}
	}
	if participantKind == "human" {
		participantKind = "person"
	}
	if !has([]string{"person", "organization", "agent", "tool", "team", "service"}, participantKind) {
		participantKind = "unknown"
	}
	if subject == "" {
		return nil, nil
	}
	viewer := ""
	if a != nil {
		viewer = a.SubjectID
	}
	blocked, e := s.NotificationReader().IsBlockedWithin(ctx, tx, viewer, subject)
	if e != nil {
		return nil, e
	}
	if blocked {
		return nil, nil
	}
	return Object{"sourceKind": kind, "id": id, "kind": participantKind, "subjectId": subject, "displayName": name, "summary": summary, "functions": functions, "claims": claims, "sources": []any{source}, "basis": basis, "visibility": "readable", "contactState": contact, "acceptance": "unknown", "callability": "unknown", "capabilityVerified": false}, nil
}
func unavailableParticipant(e error) bool {
	status := fault.Status(e)
	return status == 401 || status == 403 || status == 404 || status == 409
}
