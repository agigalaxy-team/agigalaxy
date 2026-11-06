package discovery

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"math"
	"sort"
	"strings"
)

type CommunityCandidate struct{ Key, Kind, ID, Topic, AuthorAccountID string }
type CommunitySignal struct {
	Recognition float64
	Author      *float64
	ResultIDs   []string
}

func defaultCommunitySignals() Object {
	return Object{"enabled": false, "matchWeight": float64(1), "recognitionWeight": 0.1, "authorWeight": 0.1, "smoothing": float64(20)}
}
func communitySignalsView(v Object) Object {
	if v == nil {
		return defaultCommunitySignals()
	}
	return merge(defaultCommunitySignals(), v)
}
func decimal(v any) (float64, bool) {
	switch n := v.(type) {
	case json.Number:
		f, e := n.Float64()
		return f, e == nil && !math.IsNaN(f) && !math.IsInf(f, 0)
	case float64:
		return n, !math.IsNaN(n) && !math.IsInf(n, 0)
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}
func parseCommunitySignals(input Object) (Object, error) {
	if !onlyKeys(input, "operationId", "expectedVersion", "enabled", "matchWeight", "recognitionWeight", "authorWeight", "smoothing", "reason") || !validID(str(input, "operationId")) {
		return nil, recommendationInvalid()
	}
	version, ok := integer(input["expectedVersion"])
	enabled, b := input["enabled"].(bool)
	reason, r := input["reason"].(string)
	reason = strings.TrimFunc(reason, jsSpace)
	match, m := decimal(input["matchWeight"])
	rec, n := decimal(input["recognitionWeight"])
	author, a := decimal(input["authorWeight"])
	smooth, z := decimal(input["smoothing"])
	if !ok || version < 0 || version > 2147483646 || !b || !r || codePointLength(reason) < 1 || codePointLength(reason) > 500 || !m || !n || !a || !z || match < 0.01 || match > 10 || rec < 0 || rec > 1 || author < 0 || author > 1 || match <= rec+author || smooth < 1 || smooth > 1000 {
		return nil, recommendationInvalid()
	}
	return Object{"operationId": strings.ToLower(str(input, "operationId")), "expectedVersion": version, "enabled": enabled, "matchWeight": match, "recognitionWeight": rec, "authorWeight": author, "smoothing": smooth, "reason": reason}, nil
}
func communityConfigOutput(policy Object) Object {
	out := merge(Object{}, object(policy["communitySignals"]))
	out["version"] = policy["version"]
	out["updatedAt"] = policy["updatedAt"]
	return out
}
func (s *Recommendations) ReadCommunitySignals(ctx context.Context, actor Actor) (Object, error) {
	if _, e := s.business().authorize(ctx, actor, "recommendations.read"); e != nil {
		return nil, e
	}
	policy, e := s.policy(ctx, s.Pool)
	if e != nil {
		return nil, e
	}
	return communityConfigOutput(policy), nil
}
func (s *Recommendations) SaveCommunitySignals(ctx context.Context, actor Actor, raw Object) (Object, error) {
	input, e := parseCommunitySignals(raw)
	if e != nil {
		return nil, e
	}
	return s.command(ctx, actor, "community-signals", input, func(tx pgx.Tx) (recommendationChange, error) {
		before, e := s.policy(ctx, tx)
		if e != nil {
			return recommendationChange{}, e
		}
		if number(before, "version") != number(input, "expectedVersion") {
			return recommendationChange{}, qualityFailure("recommendation_policy_changed")
		}
		value := Object{}
		for _, k := range []string{"enabled", "matchWeight", "recognitionWeight", "authorWeight", "smoothing"} {
			value[k] = input[k]
		}
		next := number(before, "version") + 1
		_, e = tx.Exec(ctx, `INSERT INTO operations_recommendation_policy_v1(endpoint,revision,enabled,directions,controls,community_signals,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(endpoint) DO UPDATE SET revision=excluded.revision,community_signals=excluded.community_signals,updated_at=excluded.updated_at`, s.Endpoint, next, before["enabled"], jsonString(before["directions"]), jsonString(before["controls"]), jsonString(value), s.now())
		if e != nil {
			return recommendationChange{}, e
		}
		policy := merge(merge(Object{}, before), Object{"version": next, "communitySignals": value, "updatedAt": iso(s.now().Unix())})
		return recommendationChange{Result: Object{"policy": policy, "communitySignals": communityConfigOutput(policy)}, Kind: "policy-updated", ThemeKey: "community-signals", Version: next, Changes: diff(object(before["communitySignals"]), value, "enabled", "matchWeight", "recognitionWeight", "authorWeight", "smoothing")}, nil
	})
}
func (s *Recommendations) rankCommunity(ctx context.Context, candidates []recommendationCandidate, config Object) ([]recommendationCandidate, error) {
	if len(candidates) == 0 {
		return candidates, nil
	}
	input := make([]CommunityCandidate, 0, len(candidates))
	for _, row := range candidates {
		d := row.Document
		author := ""
		if d.AuthorAccountID != nil {
			author = *d.AuthorAccountID
		}
		input = append(input, CommunityCandidate{Key: d.ID, Kind: d.Kind, ID: d.SourceID, Topic: d.Topic, AuthorAccountID: author})
	}
	signals, e := s.CommunitySignals(ctx, input)
	if e != nil {
		return nil, e
	}
	recognition := make([]float64, len(input))
	authors := make([]float64, len(input))
	out := append([]recommendationCandidate{}, candidates...)
	for i, c := range input {
		v, ok := signals[c.Key]
		authors[i] = 0.5
		if ok {
			if !math.IsNaN(v.Recognition) && !math.IsInf(v.Recognition, 0) && v.Recognition >= 0 {
				recognition[i] = v.Recognition
			}
			if v.Author != nil && !math.IsNaN(*v.Author) && !math.IsInf(*v.Author, 0) && *v.Author >= 0 && *v.Author <= 1 {
				authors[i] = *v.Author
			}
			out[i].ResultIDs = append([]string{}, v.ResultIDs...)
		}
	}
	ranks := func(values []float64) []int {
		order := make([]int, len(values))
		for i := range order {
			order[i] = i
		}
		sort.SliceStable(order, func(i, j int) bool { return values[order[i]] > values[order[j]] })
		rank := make([]int, len(values))
		for i, index := range order {
			r := i + 1
			if i > 0 && values[index] == values[order[i-1]] {
				r = rank[order[i-1]]
			}
			rank[index] = r
		}
		return rank
	}
	rr, ar := ranks(recognition), ranks(authors)
	match, _ := decimal(config["matchWeight"])
	rw, _ := decimal(config["recognitionWeight"])
	aw, _ := decimal(config["authorWeight"])
	smooth, _ := decimal(config["smoothing"])
	type scored struct {
		row   recommendationCandidate
		score float64
	}
	scores := make([]scored, len(out))
	for i, row := range out {
		scores[i] = scored{row, match/(smooth+float64(i+1)) + math.Max(rw/(smooth+float64(rr[i])), aw/(smooth+float64(ar[i])))}
	}
	sort.SliceStable(scores, func(i, j int) bool { return scores[i].score > scores[j].score })
	for i := range scores {
		out[i] = scores[i].row
	}
	return out, nil
}
