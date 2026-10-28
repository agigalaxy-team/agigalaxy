package discovery

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type recommendationChange struct {
	Result         Object
	Kind, ThemeKey string
	Version        int64
	Changes        Object
}

func diff(before, after Object, keys ...string) Object {
	out := Object{}
	for _, key := range keys {
		if !sameValue(before[key], after[key]) {
			out[key] = Object{"before": before[key], "after": after[key]}
		}
	}
	return out
}
func (s *Recommendations) command(ctx context.Context, actor Actor, kind string, input Object, change func(pgx.Tx) (recommendationChange, error)) (Object, error) {
	business := s.business()
	if _, e := business.authorize(ctx, actor, "recommendations.configure"); e != nil {
		return nil, e
	}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	fresh, e := business.require(ctx, tx, actor, "recommendations.configure")
	if e != nil {
		return nil, e
	}
	raw, e := identity.Canonical(Object{"kind": kind, "input": input})
	if e != nil {
		return nil, e
	}
	digest := sha256.Sum256(raw)
	hash := hex.EncodeToString(digest[:])
	if s.Authority.Duty != nil && s.Authority.Duty.AcceptsDuty(fresh) {
		if kind != "policy" {
			return nil, qualityFailure("operations_agentos_human_review_required")
		}
		fresh, e = s.Authority.RequireOperationWithin(ctx, tx, fresh, []string{"recommendations.configure"}, Object{"id": input["themeKey"], "operationId": input["operationId"], "command": input}, "recommendations.configure")
		if e != nil {
			return nil, e
		}
	}
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912429))", s.Endpoint); e != nil {
		return nil, e
	}
	prior, e := rowObject(ctx, tx, "SELECT to_jsonb(e) FROM operations_recommendation_events_v1 e WHERE endpoint=$1 AND operation_id=$2", s.Endpoint, input["operationId"])
	if e != nil {
		return nil, e
	}
	if prior != nil {
		if str(prior, "operator_id") != fresh.ID || str(prior, "request_hash") != hash {
			return nil, qualityFailure("recommendation_operation_conflict")
		}
		result := merge(merge(Object{}, object(prior["result"])), Object{"replayed": true})
		return result, tx.Commit(ctx)
	}
	changed, e := change(tx)
	if e != nil {
		return nil, e
	}
	result := merge(merge(Object{}, changed.Result), Object{"operationId": input["operationId"], "recordedAt": iso(s.now().Unix()), "replayed": false})
	if _, e = business.require(ctx, tx, fresh, "recommendations.configure"); e != nil {
		return nil, e
	}
	if _, e = tx.Exec(ctx, `INSERT INTO operations_recommendation_events_v1(id,endpoint,operator_id,operation_id,request_hash,kind,revision,theme_key,changes,reason,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, uuid.NewString(), s.Endpoint, fresh.ID, input["operationId"], hash, changed.Kind, changed.Version, changed.ThemeKey, jsonString(changed.Changes), input["reason"], jsonString(result), s.now()); e != nil {
		return nil, e
	}
	if e = business.recordFacts(ctx, tx, fresh, "recommendations.configure", str(input, "operationId"), Object{"kind": kind, "version": changed.Version}, Object{"version": changed.Version}); e != nil {
		return nil, e
	}
	return result, tx.Commit(ctx)
}
func (s *Recommendations) SavePolicy(ctx context.Context, actor Actor, raw Object, expected *ThemeExpectation) (Object, error) {
	input, e := parseRecommendationCommand("policy", raw)
	if e != nil {
		return nil, e
	}
	key := str(input, "themeKey")
	if expected != nil {
		if !themeKey(expected.Key) {
			return nil, recommendationInvalid()
		}
		copy := *expected
		copy.Key = strings.ToLower(copy.Key)
		expected = &copy
	}
	if expected != nil && (!themeKey(expected.Key) || expected.Key != key || expected.ExpectedVersion < 0 || expected.ExpectedVersion > 2147483646) {
		return nil, recommendationInvalid()
	}
	return s.command(ctx, actor, "policy", input, func(tx pgx.Tx) (recommendationChange, error) {
		before, e := s.policy(ctx, tx)
		if e != nil {
			return recommendationChange{}, e
		}
		if number(before, "version") != number(input, "expectedVersion") {
			return recommendationChange{}, qualityFailure("recommendation_policy_changed")
		}
		if expected != nil {
			parts := strings.Split(key, ":")
			table := ""
			if parts[0] == "tag" {
				table = "operations_forum_tags_v1"
			} else if parts[0] == "theme" {
				table = "operations_recommendation_themes_v1"
			}
			if table != "" {
				if _, e = tx.Exec(ctx, "SELECT id FROM "+table+" WHERE endpoint=$1 AND id=$2 FOR SHARE", s.Endpoint, parts[1]); e != nil {
					return recommendationChange{}, e
				}
			}
		}
		catalog, e := s.catalog(ctx, tx)
		if e != nil {
			return recommendationChange{}, e
		}
		var theme Object
		for _, candidate := range catalog {
			if str(candidate, "key") == key {
				theme = candidate
				break
			}
		}
		oldDirection := "keep"
		directions := append([]Object{}, objects(before["directions"])...)
		found := -1
		for i, row := range directions {
			if str(row, "key") == key {
				oldDirection = str(row, "direction")
				found = i
				break
			}
		}
		if expected != nil && (theme == nil || number(theme, "version") != expected.ExpectedVersion || theme["enabled"] != expected.Enabled) {
			return recommendationChange{}, qualityFailure("recommendation_theme_changed")
		}
		if theme == nil || theme["enabled"] != true && input["enabled"] == true && input["direction"] != "keep" && input["direction"] != oldDirection {
			return recommendationChange{}, qualityFailure("recommendation_theme_unavailable", 404)
		}
		direction := Object{"key": key, "direction": input["direction"]}
		if found < 0 {
			directions = append(directions, direction)
		} else {
			directions[found] = direction
		}
		policy := merge(merge(Object{}, before), Object{"version": number(before, "version") + 1, "enabled": input["enabled"], "controls": input["controls"], "directions": directions, "updatedAt": iso(s.now().Unix())})
		if _, e = tx.Exec(ctx, `INSERT INTO operations_recommendation_policy_v1(endpoint,revision,enabled,directions,controls,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(endpoint) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,directions=excluded.directions,controls=excluded.controls,updated_at=excluded.updated_at`, s.Endpoint, policy["version"], policy["enabled"], jsonString(directions), jsonString(policy["controls"]), s.now()); e != nil {
			return recommendationChange{}, e
		}
		changes := diff(merge(Object{"enabled": before["enabled"]}, object(before["controls"])), merge(Object{"enabled": policy["enabled"]}, object(policy["controls"])), "enabled", "avoidRepetition", "avoidConcentration")
		if oldDirection != input["direction"] {
			changes["direction"] = Object{"before": Object{"key": key, "value": oldDirection}, "after": Object{"key": key, "value": input["direction"]}}
		}
		return recommendationChange{Result: Object{"policy": policy}, Kind: "policy-updated", Version: number(policy, "version"), ThemeKey: key, Changes: changes}, nil
	})
}
func (s *Recommendations) SaveTheme(ctx context.Context, actor Actor, raw Object) (Object, error) {
	input, e := parseRecommendationCommand("theme", raw)
	if e != nil {
		return nil, e
	}
	return s.command(ctx, actor, "theme", input, func(tx pgx.Tx) (recommendationChange, error) {
		var row Object
		var e error
		if input["themeId"] != nil {
			row, e = rowObject(ctx, tx, "SELECT to_jsonb(t) FROM operations_recommendation_themes_v1 t WHERE endpoint=$1 AND id=$2", s.Endpoint, input["themeId"])
			if e != nil {
				return recommendationChange{}, e
			}
			if row == nil {
				return recommendationChange{}, qualityFailure("recommendation_theme_unavailable", 404)
			}
		}
		if number(row, "revision") != number(input, "expectedVersion") {
			return recommendationChange{}, qualityFailure("recommendation_theme_changed")
		}
		id := str(row, "id")
		var before Object
		if row != nil {
			before = themeView(row)
		} else {
			id = uuid.NewString()
		}
		revision := number(row, "revision") + 1
		mapping := merge(Object{}, object(input["mapping"]))
		terms, _ := stringArray(mapping["queryTerms"])
		normalized := []string{}
		seen := map[string]bool{}
		for _, term := range terms {
			value := normalizeTerm(term)
			if !seen[value] {
				normalized = append(normalized, value)
				seen[value] = true
			}
		}
		mapping["queryTerms"] = normalized
		tags, e := tx.Query(ctx, "SELECT id::text,enabled FROM operations_forum_tags_v1 WHERE endpoint=$1", s.Endpoint)
		if e != nil {
			return recommendationChange{}, e
		}
		enabled := map[string]bool{}
		for tags.Next() {
			var id string
			var active bool
			if e = tags.Scan(&id, &active); e != nil {
				tags.Close()
				return recommendationChange{}, e
			}
			enabled[id] = active
		}
		e = tags.Err()
		tags.Close()
		if e != nil {
			return recommendationChange{}, e
		}
		beforeTags, _ := stringArray(object(before["mapping"])["tagIds"])
		selectedTags, _ := stringArray(mapping["tagIds"])
		for _, id := range selectedTags {
			active, exists := enabled[id]
			if !exists || !active && !containsString(beforeTags, id) {
				return recommendationChange{}, qualityFailure("recommendation_mapping_unavailable", 404)
			}
		}
		if _, e = tx.Exec(ctx, `INSERT INTO operations_recommendation_themes_v1(id,endpoint,label,enabled,revision,mapping,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT(id) DO UPDATE SET label=excluded.label,enabled=excluded.enabled,revision=excluded.revision,mapping=excluded.mapping,updated_at=excluded.updated_at`, id, s.Endpoint, input["label"], input["enabled"], revision, jsonString(mapping), s.now()); e != nil {
			return recommendationChange{}, e
		}
		theme := Object{"key": "theme:" + id, "id": id, "label": input["label"], "kind": "theme", "version": revision, "enabled": input["enabled"], "mapping": mapping, "source": "operator-mapping"}
		kind := "theme-created"
		if row != nil {
			kind = "theme-updated"
		}
		return recommendationChange{Result: Object{"theme": theme}, Kind: kind, Version: revision, ThemeKey: "theme:" + id, Changes: diff(before, theme, "label", "enabled", "mapping")}, nil
	})
}
