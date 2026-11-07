package discovery

import (
	"context"
	"encoding/json"
	"math"
	"strings"

	"github.com/jackc/pgx/v5"
)

type communityParameter struct {
	minimum, maximum, initial float64
}

var communityContentParameters = map[string]communityParameter{
	"likeWeight": {0, 10, 1}, "contentRecognitionWeight": {0, 10, 2},
	"diminishingScale": {1, 1000, 10}, "freshnessWeight": {0, 10, 1},
	"discussionWeight": {0, 10, 1}, "halfLifeHours": {1, 720, 72},
}

var communityRecommendationParameters = map[string]communityParameter{
	"matchWeight": {0.01, 10, 1}, "recognitionWeight": {0, 1, 0.1},
	"heatWeight": {0, 1, 0.05}, "smoothing": {1, 1000, 20}, "maxPositionChange": {0, 10, 2},
}

func defaultCommunitySignals() Object {
	return communitySignalsView(nil)
}

func communitySignalsView(stored Object) Object {
	enabled, _ := stored["enabled"].(bool)
	out := Object{"enabled": enabled}
	for _, parameters := range []map[string]communityParameter{communityContentParameters, communityRecommendationParameters} {
		for key, rule := range parameters {
			value, valid := normalizeCommunityValue(key, rule, stored[key])
			if !valid {
				value, _ = normalizeCommunityValue(key, rule, rule.initial)
			}
			out[key] = value
		}
	}
	// Older valid policies may reserve no weight for the new heat signal.
	if !validCommunityWeights(out) {
		out["heatWeight"] = float64(0)
		if !validCommunityWeights(out) {
			out["matchWeight"] = float64(1)
			out["recognitionWeight"] = float64(0.1)
		}
	}
	return out
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

func normalizeCommunityValue(key string, rule communityParameter, raw any) (any, bool) {
	value, ok := decimal(raw)
	if !ok || value < rule.minimum || value > rule.maximum {
		return nil, false
	}
	if key == "maxPositionChange" {
		return int64(value), math.Trunc(value) == value
	}
	return value, true
}

func communityParameterArea(area string) map[string]communityParameter {
	switch area {
	case "content-score":
		return communityContentParameters
	case "recommendation":
		return communityRecommendationParameters
	}
	return nil
}

func validCommunityWeights(config Object) bool {
	match, _ := decimal(config["matchWeight"])
	recognition, _ := decimal(config["recognitionWeight"])
	heat, _ := decimal(config["heatWeight"])
	return match > recognition+heat
}

func parseCommunitySignals(raw Object, area string) (Object, error) {
	version, ok := integer(raw["expectedVersion"])
	reason := strings.TrimFunc(str(raw, "reason"), jsSpace)
	operation := str(raw, "operationId")
	if !ok || version < 0 || version > 2147483646 || !validID(operation) || codePointLength(reason) < 1 || codePointLength(reason) > 500 {
		return nil, recommendationInvalid()
	}
	input := Object{"operationId": strings.ToLower(operation), "expectedVersion": version, "reason": reason}
	fields := 0
	for key, rawValue := range raw {
		switch key {
		case "operationId", "expectedVersion", "reason":
			continue
		case "enabled":
			value, valid := rawValue.(bool)
			if area != "" || !valid {
				return nil, recommendationInvalid()
			}
			input[key] = value
		case "authorWeight":
			// Legacy request shape remains replayable under the original hash.
			// This value is never applied to the current recommendation policy.
			value, valid := decimal(rawValue)
			if area != "" || !valid || value < 0 || value > 1 {
				return nil, recommendationInvalid()
			}
			input[key] = value
			continue
		default:
			rule, found := communityParameterArea(area)[key]
			if area == "" {
				rule, found = communityContentParameters[key]
				if !found {
					rule, found = communityRecommendationParameters[key]
				}
			}
			value, valid := normalizeCommunityValue(key, rule, rawValue)
			if !found || !valid {
				return nil, recommendationInvalid()
			}
			input[key] = value
		}
		fields++
	}
	if fields == 0 {
		return nil, recommendationInvalid()
	}
	return input, nil
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
	input, e := parseCommunitySignals(raw, "")
	if e != nil {
		return nil, e
	}
	return s.command(ctx, actor, "community-signals", input, s.communityParameterChange(ctx, input))
}

func (s *Recommendations) communityParameterChange(ctx context.Context, input Object) func(pgx.Tx) (recommendationChange, error) {
	return func(tx pgx.Tx) (recommendationChange, error) {
		before, e := s.policy(ctx, tx)
		if e != nil {
			return recommendationChange{}, e
		}
		if number(before, "version") != number(input, "expectedVersion") {
			return recommendationChange{}, qualityFailure("recommendation_policy_changed")
		}
		previous := object(before["communitySignals"])
		value := merge(Object{}, previous)
		keys := make([]string, 0, len(previous))
		for key := range previous {
			if v, ok := input[key]; ok {
				value[key] = v
				keys = append(keys, key)
			}
		}
		if !validCommunityWeights(value) {
			return recommendationChange{}, recommendationInvalid()
		}
		next := number(before, "version") + 1
		now := s.now()
		_, e = tx.Exec(ctx, `INSERT INTO operations_recommendation_policy_v1(endpoint,revision,enabled,directions,controls,community_signals,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(endpoint) DO UPDATE SET revision=excluded.revision,community_signals=excluded.community_signals,updated_at=excluded.updated_at`, s.Endpoint, next, before["enabled"], jsonString(before["directions"]), jsonString(before["controls"]), jsonString(value), now)
		if e != nil {
			return recommendationChange{}, e
		}
		policy := merge(merge(Object{}, before), Object{"version": next, "communitySignals": value, "updatedAt": iso(now.Unix())})
		return recommendationChange{Result: Object{"policy": policy, "communitySignals": communityConfigOutput(policy)}, Kind: "policy-updated", ThemeKey: "community-signals", Version: next, Changes: diff(previous, value, keys...)}, nil
	}
}

func (s *Recommendations) PreviewCommunityParametersWithin(ctx context.Context, tx pgx.Tx, actor Actor, area string, patch Object) (Object, error) {
	rules := communityParameterArea(area)
	if rules == nil {
		return nil, recommendationInvalid()
	}
	if _, e := s.business().require(ctx, tx, actor, "recommendations.read"); e != nil {
		return nil, e
	}
	policy, e := s.policy(ctx, tx)
	if e != nil {
		return nil, e
	}
	current := object(policy["communitySignals"])
	proposed := merge(Object{}, current)
	before, after := Object{}, Object{}
	for key, raw := range patch {
		rule, found := rules[key]
		value, valid := normalizeCommunityValue(key, rule, raw)
		if !found || !valid {
			return nil, recommendationInvalid()
		}
		before[key], after[key], proposed[key] = current[key], value, value
	}
	if !validCommunityWeights(proposed) {
		return nil, recommendationInvalid()
	}
	if len(patch) == 0 {
		for key := range rules {
			before[key], after[key] = current[key], current[key]
		}
	}
	out := Object{"version": policy["version"], "before": before, "after": after, "sample": nil}
	if s.CommunitySampleWithin != nil {
		var priorRules, proposedRules *CommunityScoringRules
		if area == "content-score" && len(patch) > 0 {
			version := number(policy, "version")
			a, b := communityScoringRules(current, version), communityScoringRules(proposed, version)
			if a.LikeWeight != b.LikeWeight || a.ContentRecognitionWeight != b.ContentRecognitionWeight || a.DiminishingScale != b.DiminishingScale {
				priorRules, proposedRules = &a, &b
			}
		}
		sample, err := s.CommunitySampleWithin(ctx, tx, priorRules, proposedRules)
		if err != nil {
			return nil, err
		}
		if sample != nil {
			out["sampleSummary"] = sample["summary"]
			delete(sample, "summary")
			out["sample"] = sample
		}
	}
	return out, nil
}

func (s *Recommendations) AdoptCommunityParametersWithin(ctx context.Context, tx pgx.Tx, actor Actor, area string, raw Object) (Object, error) {
	if communityParameterArea(area) == nil {
		return nil, recommendationInvalid()
	}
	input, e := parseCommunitySignals(raw, area)
	if e != nil {
		return nil, e
	}
	if actor.AIProof != nil {
		return nil, qualityFailure("operations_agentos_human_review_required", 403)
	}
	return s.commandWithin(ctx, tx, actor, "community-signals", input, s.communityParameterChange(ctx, input))
}

func (s *Recommendations) CommunityParametersReceiptWithin(ctx context.Context, tx pgx.Tx, actor Actor, area string, raw Object) (Object, error) {
	if communityParameterArea(area) == nil {
		return nil, recommendationInvalid()
	}
	input, e := parseCommunitySignals(raw, area)
	if e != nil {
		return nil, e
	}
	if _, e = s.business().require(ctx, tx, actor, "recommendations.read"); e != nil {
		return nil, e
	}
	hash, e := recommendationRequestHash("community-signals", input)
	if e != nil {
		return nil, e
	}
	return s.recommendationReceiptWithin(ctx, tx, actor.ID, str(input, "operationId"), hash)
}
