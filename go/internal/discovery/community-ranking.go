package discovery

import (
	"context"
	"math"
	"sort"
	"time"
)

type CommunityCandidate struct {
	Key, Kind, ID, Version string
}

type CommunityScoringRules struct {
	Version                              int64
	LikeWeight, ContentRecognitionWeight float64
	DiminishingScale, FreshnessWeight    float64
	DiscussionWeight, HalfLifeHours      float64
}

type CommunitySignal struct {
	Recognition, Heat float64
	Version           int64
	CalculatedAt      time.Time
}

func communityScoringRules(config Object, version int64) CommunityScoringRules {
	like, _ := decimal(config["likeWeight"])
	recognition, _ := decimal(config["contentRecognitionWeight"])
	scale, _ := decimal(config["diminishingScale"])
	freshness, _ := decimal(config["freshnessWeight"])
	discussion, _ := decimal(config["discussionWeight"])
	halfLife, _ := decimal(config["halfLifeHours"])
	return CommunityScoringRules{
		Version: version, LikeWeight: like, ContentRecognitionWeight: recognition,
		DiminishingScale: scale, FreshnessWeight: freshness, DiscussionWeight: discussion, HalfLifeHours: halfLife,
	}
}

func DefaultCommunityScoringRules() CommunityScoringRules {
	return communityScoringRules(defaultCommunitySignals(), 0)
}

func (s *Recommendations) rankCommunity(ctx context.Context, candidates []recommendationCandidate, config Object, version int64) ([]recommendationCandidate, error) {
	limit, _ := integer(config["maxPositionChange"])
	match, _ := decimal(config["matchWeight"])
	recognition, _ := decimal(config["recognitionWeight"])
	heat, _ := decimal(config["heatWeight"])
	smoothing, _ := decimal(config["smoothing"])
	if len(candidates) < 2 || limit == 0 || recognition+heat == 0 || s.CommunitySignals == nil {
		return candidates, nil
	}
	// The latest fallback follows the personalized candidates in original time order.
	personalized := 0
	for personalized < len(candidates) && candidates[personalized].Mode == "personalized" {
		personalized++
	}
	if personalized < 2 {
		return candidates, nil
	}
	input := make([]CommunityCandidate, personalized)
	for i, row := range candidates[:personalized] {
		d := row.Document
		input[i] = CommunityCandidate{Key: d.ID, Kind: d.Kind, ID: d.SourceID, Version: d.Version}
	}
	rules := communityScoringRules(config, version)
	if heat == 0 {
		rules.DiscussionWeight, rules.FreshnessWeight = 0, 0
	}
	signals, e := s.CommunitySignals(ctx, input, rules)
	if e != nil {
		return nil, e
	}
	recognitions, heats := make([]float64, personalized), make([]float64, personalized)
	for i, candidate := range input {
		value, ok := signals[candidate.Key]
		if ok && value.Version == version && !value.CalculatedAt.IsZero() {
			recognitions[i] = positiveSignal(value.Recognition)
			heats[i] = positiveSignal(value.Heat)
		}
	}
	order := communityOrder(recognitions, heats, match, recognition, heat, smoothing, int(limit))
	out := append([]recommendationCandidate(nil), candidates...)
	for i, index := range order {
		out[i] = candidates[index]
		if recognitions[index]*recognition+heats[index]*heat > 0 {
			value := signals[input[index].Key]
			out[i].CommunitySignal = &value
		}
	}
	return out, nil
}

func positiveSignal(n float64) float64 {
	if n > 0 && !math.IsInf(n, 0) {
		return n
	}
	return 0
}

func communityRanks(values []float64) []int {
	order := make([]int, 0, len(values))
	for i, value := range values {
		if value > 0 {
			order = append(order, i)
		}
	}
	sort.SliceStable(order, func(i, j int) bool { return values[order[i]] > values[order[j]] })
	ranks := make([]int, len(values))
	for i, index := range order {
		ranks[index] = i + 1
		if i > 0 && values[index] == values[order[i-1]] {
			ranks[index] = ranks[order[i-1]]
		}
	}
	return ranks
}

func communityOrder(recognitions, heats []float64, match, recognition, heat, smoothing float64, limit int) []int {
	rr, hr := communityRanks(recognitions), communityRanks(heats)
	scores := make([]float64, len(rr))
	for i := range scores {
		base := match / (smoothing + float64(i+1))
		auxiliary := 0.0
		if rr[i] > 0 {
			auxiliary += recognition / (smoothing + float64(rr[i]))
		}
		if hr[i] > 0 {
			auxiliary += heat / (smoothing + float64(hr[i]))
		}
		scores[i] = base + min(auxiliary, base)
	}
	order := make([]int, 0, len(scores))
	used := make([]bool, len(scores))
	first := 0
	for i := range scores {
		// A candidate at its last allowed position takes precedence. Otherwise
		// choose the best eligible score, breaking ties in the original order.
		choice := first
		if i-first < limit {
			for j := first + 1; j < len(scores) && j <= i+limit; j++ {
				if !used[j] && scores[j] > scores[choice] {
					choice = j
				}
			}
		}
		order = append(order, choice)
		used[choice] = true
		for first < len(used) && used[first] {
			first++
		}
	}
	return order
}
