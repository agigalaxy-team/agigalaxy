package discovery

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5/pgconn"
)

func recommendationUnknownMetrics() Object {
	return Object{"exposures": nil, "clicks": nil, "bookmarks": nil, "notInterested": nil}
}

type snapshotSource interface {
	QualifiedSnapshot(context.Context) (Snapshot, error)
}

func (s *Recommendations) sourceSnapshot(ctx context.Context) (Snapshot, error) {
	if source, ok := s.Source.(snapshotSource); ok {
		return source.QualifiedSnapshot(ctx)
	}
	snapshot := Snapshot{Documents: []*Document{}, Complete: true}
	after := ""
	for {
		rows, e := s.Source.Candidates(ctx, after, 100)
		if e != nil {
			return Snapshot{}, e
		}
		if len(rows) == 0 {
			break
		}
		for _, reference := range rows {
			document, e := s.Source.Load(ctx, reference)
			if e != nil {
				return Snapshot{}, e
			}
			if document != nil {
				snapshot.Documents = append(snapshot.Documents, document)
			}
		}
		snapshot.Scanned += len(rows)
		last := rows[len(rows)-1]
		after = last.Kind + ":" + last.ID
		if len(rows) < 100 {
			break
		}
	}
	return snapshot, nil
}
func (s *Recommendations) topicMetrics(ctx context.Context, catalog []Object, snapshot Snapshot, from, to string) ([]Object, error) {
	if !snapshot.Complete {
		out := []Object{}
		for _, theme := range catalog {
			out = append(out, merge(recommendationUnknownMetrics(), Object{"key": theme["key"], "supply": nil, "demand": nil, "availability": Object{"supply": "partial", "usage": "partial"}}))
		}
		return out, nil
	}
	themes := []Object{}
	refs := []Object{}
	supplies := map[string]int{}
	for _, theme := range catalog {
		terms := []string{}
		if theme["enabled"] == true {
			values, _ := stringArray(object(theme["mapping"])["queryTerms"])
			for _, value := range values {
				terms = append(terms, normalizeTerm(value))
			}
		}
		themes = append(themes, Object{"key": theme["key"], "query_terms": terms})
	}
	for _, document := range snapshot.Documents {
		keys := themeKeys(catalog, document)
		for _, key := range keys {
			supplies[key]++
		}
		refs = append(refs, Object{"item_key": document.ID, "version": document.Version, "theme_keys": keys})
	}
	rows, e := s.Pool.Query(ctx, topicMetricsSQL, s.Endpoint, from, to, jsonString(themes), jsonString(refs))
	if e != nil {
		return nil, e
	}
	values := map[string]Object{}
	for rows.Next() {
		var key string
		var demand, exposures, clicks, bookmarks, negative, attributed int64
		if e = rows.Scan(&key, &demand, &exposures, &clicks, &bookmarks, &negative, &attributed); e != nil {
			rows.Close()
			return nil, e
		}
		values[key] = Object{"demand": demand, "exposures": exposures, "clicks": clicks, "bookmarks": bookmarks, "negative": negative, "attributed": attributed}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	out := []Object{}
	for _, theme := range catalog {
		key := str(theme, "key")
		value := values[key]
		usage := "not-collected"
		metrics := recommendationUnknownMetrics()
		if number(value, "attributed") > 0 {
			usage = "available"
			metrics = Object{"exposures": number(value, "exposures"), "clicks": number(value, "clicks"), "bookmarks": number(value, "bookmarks"), "notInterested": number(value, "negative")}
		}
		out = append(out, merge(metrics, Object{"key": key, "supply": supplies[key], "demand": number(value, "demand"), "availability": Object{"supply": "available", "usage": usage}}))
	}
	return out, nil
}
func (s *Recommendations) Overview(ctx context.Context, actor Actor, input Object) (Object, error) {
	if !onlyKeys(input, "days", "query") {
		return nil, recommendationInvalid()
	}
	days := int64(30)
	query := ""
	if value, present := input["days"]; present {
		n, ok := integer(value)
		if !ok || (n != 7 && n != 30 && n != 90) {
			return nil, recommendationInvalid()
		}
		days = n
	}
	if value, present := input["query"]; present {
		v, ok := value.(string)
		if !ok {
			return nil, recommendationInvalid()
		}
		query = strings.TrimFunc(v, jsSpace)
		if codePointLength(query) > 160 {
			return nil, recommendationInvalid()
		}
	}
	business := s.business()
	if _, e := business.authorize(ctx, actor, "recommendations.read"); e != nil {
		return nil, e
	}
	now := s.now().Unix()
	from, to := iso(now-days*86400), iso(now)
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	catalog, e := s.catalog(ctx, tx)
	if e != nil {
		_ = tx.Rollback(ctx)
		return nil, e
	}
	policy, e := s.policy(ctx, tx)
	if e != nil {
		_ = tx.Rollback(ctx)
		return nil, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	snapshot, e := s.sourceSnapshot(ctx)
	if e != nil {
		return nil, e
	}
	metrics, e := s.topicMetrics(ctx, catalog, snapshot, from, to)
	if e != nil {
		return nil, e
	}
	native := Object{"metrics": recommendationUnknownMetrics(), "trend": Object{"items": []Object{}, "availability": "not-connected"}}
	if s.OpenPanel != nil {
		native, e = s.OpenPanel.RecommendationReport(ctx, from, iso(now-1))
		if e != nil {
			return nil, e
		}
	}
	fresh, e := business.authorize(ctx, actor, "recommendations.read")
	if e != nil {
		return nil, e
	}
	canConfigure := containsString(fresh.Permissions, "recommendations.configure")
	needle := normalizeTerm(query)
	selected := []Object{}
	mapping := []Object{}
	keys := map[string]bool{}
	for _, theme := range catalog {
		if str(theme, "kind") != "theme" {
			mapping = append(mapping, theme)
		}
		match := needle == "" || strings.Contains(normalizeTerm(str(theme, "label")), needle)
		terms, _ := stringArray(object(theme["mapping"])["queryTerms"])
		for _, term := range terms {
			match = match || strings.Contains(normalizeTerm(term), needle)
		}
		if match {
			selected = append(selected, theme)
			keys[str(theme, "key")] = true
		}
	}
	topics := []Object{}
	for _, metric := range metrics {
		if keys[str(metric, "key")] {
			topics = append(topics, metric)
		}
	}
	var started, completed, isolation any
	if _, ok := s.Source.(snapshotSource); ok {
		started = snapshot.StartedAt
		completed = snapshot.CompletedAt
		isolation = "repeatable-read"
	}
	return merge(Object{"catalog": Object{"items": selected}, "mappingCatalog": Object{"items": mapping}, "topics": Object{"items": topics}, "metrics": native["metrics"], "trend": native["trend"], "policy": policy, "period": Object{"from": from, "to": to, "days": days}, "capabilities": Object{"canConfigure": canConfigure, "canMapThemes": canConfigure}, "basis": Object{"metricsSource": "openpanel-native", "topicSource": "galaxy-qualified-usage-events", "recommendationAttribution": "request-bound-only", "historicalBackfill": false, "model": "not-configured", "demandUnit": "qualified-normal-usage-events", "supplyScope": "current-anonymous-public-community", "sourceScanComplete": snapshot.Complete, "sourceScanStartedAt": started, "sourceScanCompletedAt": completed, "sourceSnapshotIsolation": isolation}}, business.metadata()), nil
}
func (s *Recommendations) History(ctx context.Context, actor Actor, input Object) (Object, error) {
	if !onlyKeys(input, "after", "limit") {
		return nil, recommendationInvalid()
	}
	limit := int64(20)
	if value, present := input["limit"]; present {
		n, ok := integer(value)
		if !ok || n < 1 || n > 50 {
			return nil, recommendationInvalid()
		}
		limit = n
	}
	var after any
	if value, present := input["after"]; present {
		v, ok := value.(string)
		n, e := strconv.ParseInt(v, 10, 64)
		if !ok || e != nil || n < 1 || strconv.FormatInt(n, 10) != v {
			return nil, recommendationInvalid()
		}
		after = v
	}
	business := s.business()
	if _, e := business.authorize(ctx, actor, "recommendations.read"); e != nil {
		return nil, e
	}
	rows, e := s.Pool.Query(ctx, "SELECT to_jsonb(e) FROM operations_recommendation_events_v1 e WHERE endpoint=$1 AND ($2::bigint IS NULL OR sequence<$2::bigint) ORDER BY sequence DESC LIMIT $3", s.Endpoint, after, limit+1)
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
		var row Object
		if e = decode(raw, &row); e != nil {
			rows.Close()
			return nil, e
		}
		found = append(found, row)
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
	operators := []string{}
	for _, row := range selected {
		id := str(row, "operator_id")
		if id != "" && protocol.TextLength(id) <= 256 && !strings.HasPrefix(id, "executor:") {
			operators = append(operators, id)
		}
	}
	names := map[string]any{}
	nameRows, e := s.Pool.Query(ctx, "SELECT operator_id,display_name FROM operations_operator_principals_v1 WHERE endpoint=$1 AND operator_id=ANY($2::text[])", s.Endpoint, operators)
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
	items := []Object{}
	for _, row := range selected {
		items = append(items, Object{"id": row["id"], "sequence": strconv.FormatInt(number(row, "sequence"), 10), "kind": row["kind"], "operatorId": row["operator_id"], "operatorDisplayName": names[str(row, "operator_id")], "version": row["revision"], "themeKey": row["theme_key"], "changes": row["changes"], "reason": row["reason"], "createdAt": stamp(row["created_at"])})
	}
	var next any
	if len(found) > int(limit) {
		next = strconv.FormatInt(number(selected[len(selected)-1], "sequence"), 10)
	}
	if _, e = business.authorize(ctx, actor, "recommendations.read"); e != nil {
		return nil, e
	}
	return merge(Object{"items": items, "nextAfter": next}, business.metadata()), nil
}
func (s *Recommendations) CommandResult(ctx context.Context, actor Actor, id string) (Object, error) {
	if !validID(id) {
		return nil, qualityFailure("invalid_operations_command_receipt", 400)
	}
	business := s.business()
	if s.Authority != nil && s.Authority.Duty != nil && s.Authority.Duty.AcceptsDuty(actor) {
		return nil, qualityFailure("business_admin_denied", 403)
	}
	if _, e := business.authorize(ctx, actor, "recommendations.read"); e != nil {
		return nil, e
	}
	row, e := rowObject(ctx, s.Pool, `SELECT jsonb_build_object('operator_id',operator_id,'kind',kind,'revision',revision,'theme_key',theme_key,'receipt',jsonb_build_object('version',COALESCE(result->'policy'->'version',result->'theme'->'version'),'themeId',result->'theme'->'id','themeKey',result->'theme'->'key')) FROM operations_recommendation_events_v1 WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, id)
	unavailable := false
	if e != nil {
		var pgError *pgconn.PgError
		if errors.As(e, &pgError) && pgError.Code == "42P01" {
			unavailable = true
		} else {
			return nil, qualityFailure("operations_command_receipt_unavailable", 503)
		}
	}
	if row != nil && str(row, "operator_id") != actor.ID {
		if _, e := business.authorize(ctx, actor, "recommendations.read"); e != nil {
			return nil, e
		}
		return nil, qualityFailure("operations_command_receipt_not_found", 404)
	}
	var kind, result any
	receipt := object(row["receipt"])
	revision := number(row, "revision")
	if revision > 0 && revision <= 9007199254740991 && number(receipt, "version") == revision && themeKey(str(row, "theme_key")) {
		if str(row, "kind") == "policy-updated" {
			kind = "policy"
			result = Object{"version": receipt["version"], "themeKey": row["theme_key"]}
		} else if (str(row, "kind") == "theme-created" || str(row, "kind") == "theme-updated") && validID(str(receipt, "themeId")) && receipt["themeKey"] == row["theme_key"] && str(row, "theme_key") == "theme:"+str(receipt, "themeId") {
			kind = "theme"
			result = Object{"version": receipt["version"], "themeKey": row["theme_key"], "themeId": receipt["themeId"]}
		}
	}
	if _, e := business.authorize(ctx, actor, "recommendations.read"); e != nil {
		return nil, e
	}
	state := "unknown"
	if !unavailable {
		if row == nil {
			state = "not-recorded"
		} else if kind != nil {
			state = "recorded"
		}
	}
	return merge(Object{"state": state, "operationId": id, "kind": kind, "result": result}, business.metadata()), nil
}
