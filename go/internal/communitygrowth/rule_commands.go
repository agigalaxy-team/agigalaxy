package communitygrowth

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
	"math"
	"unicode/utf8"
)

func integer(v any) (int64, bool) {
	switch n := v.(type) {
	case int:
		return int64(n), true
	case int64:
		return n, true
	case json.Number:
		value, e := n.Int64()
		return value, e == nil
	case float64:
		if n >= math.MinInt64 && n < math.MaxInt64 && math.Trunc(n) == n {
			return int64(n), true
		}
	}
	return 0, false
}
func (s *Service) saveRule(ctx context.Context, tx pgx.Tx, x Object) (Object, error) {
	key, label := str(x, "ruleKey"), str(x, "label")
	xp, ok := integer(x["experience"])
	enabled, b := x["enabled"].(bool)
	version, v := integer(x["expectedVersion"])
	if key == "" || label == "" || utf8.RuneCountInString(label) > 200 || !ok || xp < 0 || !b || !v || version < 1 {
		return nil, invalid()
	}
	var newVersion int64
	e := tx.QueryRow(ctx, `UPDATE community_growth_rules_v1 SET label=$3,experience=$4,enabled=$5,version=version+1,updated_at=$6 WHERE endpoint=$1 AND rule_key=$2 AND version=$7 RETURNING version`, s.Endpoint, key, label, xp, enabled, s.now(), version).Scan(&newVersion)
	if noRows(e) {
		return nil, fault.New("community_growth_version_conflict", 409)
	}
	if e != nil {
		return nil, e
	}
	_, e = tx.Exec(ctx, `INSERT INTO community_growth_rule_history_v1(endpoint,rule_key,version,snapshot,created_at) SELECT endpoint,rule_key,version,to_jsonb(r),$3 FROM community_growth_rules_v1 r WHERE endpoint=$1 AND rule_key=$2`, s.Endpoint, key, s.now())
	if e != nil {
		return nil, e
	}
	return Object{"ruleKey": key, "version": newVersion}, nil
}
func (s *Service) saveLevels(ctx context.Context, tx pgx.Tx, x Object) (Object, error) {
	expected, valid := integer(x["expectedVersion"])
	if !valid || expected < 1 {
		return nil, invalid()
	}
	raw, ok := x["levels"].([]any)
	if !ok || len(raw) < 1 || len(raw) > 100 {
		return nil, invalid()
	}
	type level struct {
		n, min int64
		label  string
	}
	levels := []level{}
	prev := int64(-1)
	for i, item := range raw {
		o, ok := item.(map[string]any)
		if !ok {
			return nil, invalid()
		}
		n, a := integer(o["level"])
		minimum, b := integer(o["minimum"])
		label := str(o, "label")
		if !a || !b || n != int64(i+1) || minimum <= prev || (i == 0 && minimum != 0) || label == "" || utf8.RuneCountInString(label) > 200 {
			return nil, invalid()
		}
		levels = append(levels, level{n, minimum, label})
		prev = minimum
	}
	if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912766))`, s.Endpoint); e != nil {
		return nil, e
	}
	var version int64
	if e := tx.QueryRow(ctx, `UPDATE community_growth_initialized_v1 SET levels_version=levels_version+1 WHERE endpoint=$1 AND levels_version=$2 RETURNING levels_version`, s.Endpoint, expected).Scan(&version); noRows(e) {
		return nil, fault.New("community_growth_version_conflict", 409)
	} else if e != nil {
		return nil, e
	}
	if _, e := tx.Exec(ctx, `DELETE FROM community_growth_levels_v1 WHERE endpoint=$1`, s.Endpoint); e != nil {
		return nil, e
	}
	for _, l := range levels {
		if _, e := tx.Exec(ctx, `INSERT INTO community_growth_levels_v1(endpoint,level,minimum,label) VALUES($1,$2,$3,$4)`, s.Endpoint, l.n, l.min, l.label); e != nil {
			return nil, e
		}
	}
	_, e := tx.Exec(ctx, `INSERT INTO community_growth_levels_history_v1(endpoint,version,snapshot,created_at) SELECT $1,$2,jsonb_agg(to_jsonb(l) ORDER BY level),$3 FROM community_growth_levels_v1 l WHERE endpoint=$1`, s.Endpoint, version, s.now())
	if e != nil {
		return nil, e
	}
	return Object{"levels": len(levels), "version": version}, nil
}
