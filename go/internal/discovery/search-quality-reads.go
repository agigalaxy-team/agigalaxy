package discovery

import (
	"context"
	"encoding/base64"
	"strconv"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func (q *SearchQuality) configuration(ctx context.Context, db queryReader, native Object) (Object, error) {
	state, e := q.state(ctx, db)
	if e != nil {
		return nil, e
	}
	active, e := q.version(ctx, db, str(state, "active_id"))
	if e != nil {
		return nil, e
	}
	draft, e := q.version(ctx, db, str(state, "draft_id"))
	if e != nil {
		return nil, e
	}
	var pending Object
	if state["pending_operation"] != nil {
		row, e := q.operation(ctx, db, str(state, "pending_operation"))
		if e != nil {
			return nil, e
		}
		pending = operationView(row, false)
	}
	nativeState := "not-connected"
	var editable Object
	if q.Meili != nil {
		nativeState = "unavailable"
	}
	if native != nil {
		nativeState = "available"
		if active != nil && !sameNative(native, object(active["native_settings"])) {
			nativeState = "drifted"
		}
		editable = editableSettings(native)
	}
	return Object{"revision": state["revision"], "active": versionView(active), "draft": versionView(draft), "native": Object{"state": nativeState, "settings": editable}, "pending": pending}, nil
}
func (q *SearchQuality) Operation(ctx context.Context, actor Actor, id string) (Object, error) {
	if !validID(id) {
		return nil, settingsInvalid()
	}
	id = strings.ToLower(id)
	if _, e := q.authorize(ctx, actor, "search-quality.read"); e != nil {
		return nil, e
	}
	row, e := q.operation(ctx, q.Pool, id)
	if e != nil {
		return nil, e
	}
	if row == nil {
		return nil, qualityFailure("search_quality_operation_unavailable", 404)
	}
	if qualityPhase(str(row, "phase")) {
		row, e = q.Reconcile(ctx, id)
		if e != nil {
			return nil, e
		}
	}
	if _, e = q.authorize(ctx, actor, "search-quality.read"); e != nil {
		return nil, e
	}
	return merge(operationView(row, false), q.metadata()), nil
}
func (q *SearchQuality) History(ctx context.Context, actor Actor, input Object) (Object, error) {
	if !onlyKeys(input, "after", "limit") {
		return nil, settingsInvalid()
	}
	limit := int64(20)
	if value, present := input["limit"]; present {
		n, ok := integer(value)
		if !ok || n < 1 || n > 50 {
			return nil, settingsInvalid()
		}
		limit = n
	}
	var after any
	if value, present := input["after"]; present {
		s, ok := value.(string)
		n, e := strconv.ParseInt(s, 10, 64)
		if !ok || e != nil || n < 1 || strconv.FormatInt(n, 10) != s {
			return nil, settingsInvalid()
		}
		after = s
	}
	if _, e := q.authorize(ctx, actor, "search-quality.read"); e != nil {
		return nil, e
	}
	rows, e := q.Pool.Query(ctx, `SELECT to_jsonb(o)||jsonb_build_object('version',v.version) FROM operations_search_quality_operations_v1 o JOIN operations_search_quality_versions_v1 v ON v.endpoint=o.endpoint AND v.id=o.version_id WHERE o.endpoint=$1 AND ($2::bigint IS NULL OR o.sequence<$2::bigint) ORDER BY o.sequence DESC LIMIT $3`, q.Endpoint, after, limit+1)
	if e != nil {
		return nil, e
	}
	found := []Object{}
	for rows.Next() {
		var raw []byte
		if e = rows.Scan(&raw); e != nil {
			rows.Close()
			return nil, e
		}
		var o Object
		if e = decode(raw, &o); e != nil {
			rows.Close()
			return nil, e
		}
		found = append(found, o)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	selected := found
	if len(selected) > int(limit) {
		selected = selected[:limit]
	}
	versions := []string{}
	operators := []string{}
	for _, row := range selected {
		versions = append(versions, str(row, "version_id"))
		id := str(row, "operator_id")
		if id != "" && protocol.TextLength(id) <= 256 && !strings.HasPrefix(id, "executor:") {
			operators = append(operators, id)
		}
	}
	names := map[string]any{}
	nameRows, e := q.Pool.Query(ctx, "SELECT operator_id,display_name FROM operations_operator_principals_v1 WHERE endpoint=$1 AND operator_id=ANY($2::text[])", q.Endpoint, operators)
	if e != nil {
		return nil, e
	}
	for nameRows.Next() {
		var id string
		var name *string
		if e = nameRows.Scan(&id, &name); e != nil {
			nameRows.Close()
			return nil, e
		}
		if name != nil {
			label := strings.TrimFunc(*name, jsSpace)
			if label != "" {
				names[id] = label
			}
		}
	}
	e = nameRows.Err()
	nameRows.Close()
	if e != nil {
		return nil, e
	}
	versionRows, e := q.Pool.Query(ctx, `SELECT to_jsonb(v)||jsonb_build_object('was_applied',EXISTS(SELECT 1 FROM operations_search_quality_operations_v1 o WHERE o.endpoint=v.endpoint AND o.version_id=v.id AND o.kind IN ('apply','restore') AND o.phase='applied')) FROM operations_search_quality_versions_v1 v WHERE v.endpoint=$1 AND (v.version=0 OR v.id=ANY($2::uuid[])) ORDER BY v.version DESC`, q.Endpoint, versions)
	if e != nil {
		return nil, e
	}
	projectedVersions := []Object{}
	for versionRows.Next() {
		var raw []byte
		if e = versionRows.Scan(&raw); e != nil {
			versionRows.Close()
			return nil, e
		}
		var row Object
		if e = decode(raw, &row); e != nil {
			versionRows.Close()
			return nil, e
		}
		projectedVersions = append(projectedVersions, versionView(row))
	}
	e = versionRows.Err()
	versionRows.Close()
	if e != nil {
		return nil, e
	}
	items := []Object{}
	for _, row := range selected {
		items = append(items, Object{"id": row["operation_id"], "sequence": strconv.FormatInt(number(row, "sequence"), 10), "kind": row["kind"], "operatorId": row["operator_id"], "operatorDisplayName": names[str(row, "operator_id")], "versionId": row["version_id"], "version": row["version"], "phase": row["phase"], "changes": row["changes"], "reason": row["reason"], "createdAt": stamp(row["created_at"])})
	}
	var next any
	if len(found) > int(limit) {
		next = strconv.FormatInt(number(selected[len(selected)-1], "sequence"), 10)
	}
	if _, e = q.authorize(ctx, actor, "search-quality.read"); e != nil {
		return nil, e
	}
	return merge(Object{"items": items, "versions": projectedVersions, "nextAfter": next}, q.metadata()), nil
}
func qualityMetrics(value Object) Object {
	measured, known := number(value, "measured_searches"), number(value, "known_searches")
	out := Object{"searches": number(value, "searches"), "measuredSearches": measured, "resultKnownSearches": known, "noResults": nil, "noResultRate": nil, "clicks": nil, "clickedSearches": nil, "clickRate": nil, "followUps": nil, "scanLimited": nil}
	if measured > 0 {
		out["noResults"] = number(value, "no_results")
		out["clicks"] = number(value, "clicks")
		out["clickedSearches"] = number(value, "clicked_searches")
		out["clickRate"] = float64(number(value, "clicked_searches")) / float64(measured)
		out["followUps"] = number(value, "follow_ups")
		out["scanLimited"] = number(value, "scan_limited")
	}
	if known > 0 {
		out["noResultRate"] = float64(number(value, "no_results")) / float64(known)
	}
	return out
}
func (q *SearchQuality) qualityFacts(ctx context.Context, from, to, query, issue, after string, limit int) (Object, error) {
	var rawItems, rawTotals []byte
	if e := q.Pool.QueryRow(ctx, qualityFactsSQL, q.Endpoint, from, to, normalizeTerm(query), issue, after, limit+1).Scan(&rawItems, &rawTotals); e != nil {
		return nil, e
	}
	var rows []Object
	var totals Object
	if e := decode(rawItems, &rows); e != nil {
		return nil, e
	}
	if e := decode(rawTotals, &totals); e != nil {
		return nil, e
	}
	selected := rows
	if len(rows) > limit {
		selected = rows[:limit]
	}
	items := []Object{}
	for _, value := range selected {
		codes := []string{}
		if number(value, "no_results") > 0 {
			codes = append(codes, "no-results")
		}
		if number(value, "measured_searches") > 0 && number(value, "clicked_searches") == 0 {
			codes = append(codes, "no-recorded-click")
		}
		if number(value, "scan_limited") > 0 {
			codes = append(codes, "scan-limited")
		}
		if number(value, "searches") > number(value, "measured_searches") {
			codes = append(codes, "unmeasured")
		}
		items = append(items, merge(qualityMetrics(value), Object{"key": value["key"], "label": value["label"], "issueCodes": codes}))
	}
	var next any
	if len(rows) > limit {
		raw, _ := protocol.EncodeJS(selected[len(selected)-1]["key"])
		next = base64.RawURLEncoding.EncodeToString(raw)
	}
	return Object{"items": items, "metrics": qualityMetrics(totals), "nextAfter": next}, nil
}
func (q *SearchQuality) Overview(ctx context.Context, actor Actor, input Object) (Object, error) {
	if !onlyKeys(input, "days", "query", "issue", "after", "limit") {
		return nil, settingsInvalid()
	}
	days, limit := int64(7), int64(20)
	if value, present := input["days"]; present {
		n, ok := integer(value)
		if !ok || (n != 7 && n != 30 && n != 90) {
			return nil, settingsInvalid()
		}
		days = n
	}
	if value, present := input["limit"]; present {
		n, ok := integer(value)
		if !ok || n < 1 || n > 50 {
			return nil, settingsInvalid()
		}
		limit = n
	}
	query := ""
	if value, present := input["query"]; present {
		s, ok := value.(string)
		if !ok {
			return nil, settingsInvalid()
		}
		query = strings.TrimFunc(s, jsSpace)
		if codePointLength(query) > 160 {
			return nil, settingsInvalid()
		}
	}
	issue := "all"
	if value, present := input["issue"]; present {
		issue, _ = value.(string)
		if issue != "all" && issue != "no-results" && issue != "no-recorded-click" && issue != "scan-limited" && issue != "unmeasured" {
			return nil, settingsInvalid()
		}
	}
	after := ""
	if value, present := input["after"]; present {
		s, ok := value.(string)
		if !ok || codePointLength(s) > 1024 {
			return nil, settingsInvalid()
		}
		if s != "" {
			raw, e := base64.RawURLEncoding.DecodeString(s)
			if e != nil || decode(raw, &after) != nil || protocol.TextLength(after) > 160 {
				return nil, settingsInvalid()
			}
			canonical, _ := protocol.EncodeJS(after)
			if base64.RawURLEncoding.EncodeToString(canonical) != s {
				return nil, settingsInvalid()
			}
		}
	}
	if _, e := q.authorize(ctx, actor, "search-quality.read"); e != nil {
		return nil, e
	}
	now := q.now().Unix()
	from, to := iso(now-days*86400), iso(now)
	state, e := q.state(ctx, q.Pool)
	if e != nil {
		return nil, e
	}
	if state["pending_operation"] != nil {
		if _, e = q.Reconcile(ctx, str(state, "pending_operation")); e != nil {
			return nil, e
		}
	}
	native, e := q.observedSettings(ctx)
	if e != nil {
		native = nil
	}
	tx, e := q.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	configuration, e := q.configuration(ctx, tx, native)
	if e != nil {
		_ = tx.Rollback(ctx)
		return nil, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	facts, e := q.qualityFacts(ctx, from, to, query, issue, after, int(limit))
	if e != nil {
		return nil, e
	}
	report := Object{"metrics": Object{"searches": nil}, "trend": Object{"items": []Object{}, "availability": "not-connected"}}
	if q.OpenPanel != nil {
		report, e = q.OpenPanel.SearchQualityReport(ctx, from, iso(now-1))
		if e != nil {
			return nil, e
		}
	}
	fresh, e := q.authorize(ctx, actor, "search-quality.read")
	if e != nil {
		return nil, e
	}
	has := func(code string) bool {
		for _, permission := range fresh.Permissions {
			if permission == code {
				return true
			}
		}
		return false
	}
	nativeAvailable := str(object(configuration["native"]), "state") == "available"
	pendingFree := object(configuration["pending"]) == nil
	activeExists := object(configuration["active"]) != nil
	draftExists := object(configuration["draft"]) != nil
	metrics := merge(object(facts["metrics"]), Object{"searches": object(report["metrics"])["searches"]})
	return merge(Object{"period": Object{"from": from, "to": to, "days": days}, "metrics": metrics, "trend": report["trend"], "queries": Object{"items": facts["items"], "nextAfter": facts["nextAfter"]}, "configuration": configuration, "capabilities": Object{"canConfigure": has("search-quality.configure") && pendingFree && (activeExists || nativeAvailable), "canPublish": has("search-quality.publish") && pendingFree && draftExists && nativeAvailable, "canRestore": has("search-quality.restore") && pendingFree && nativeAvailable}, "basis": Object{"source": "meilisearch-community", "metricsSource": "openpanel-native-and-galaxy-request-bound-events", "identity": "same-profile-and-source-version", "unit": "events", "rates": "observed-matched-requests-in-window", "bounds": "[from,to)", "historicalBackfill": false, "qualityCollection": "request-bound-only", "noResult": "qualified-empty-and-scan-complete", "fixedConstraints": fixedConstraints, "model": "not-configured"}}, q.metadata()), nil
}
