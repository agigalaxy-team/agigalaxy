package discovery

import "context"

func parseRecommendation(input Object) (RecommendationRequest, error) {
	request := RecommendationRequest{Mode: "personalized", Limit: 12}
	if !onlyKeys(input, "mode", "limit", "topic") {
		return request, invalid()
	}
	if value, present := input["mode"]; present {
		mode, ok := value.(string)
		if !ok || (mode != "personalized" && mode != "latest") {
			return request, invalid()
		}
		request.Mode = mode
	}
	if value, present := input["limit"]; present {
		n, ok := integer(value)
		if !ok || n < 1 || n > 30 {
			return request, invalid()
		}
		request.Limit = int(n)
	}
	if value, present := input["topic"]; present {
		topic, ok := value.(string)
		if !ok || !topics[topic] {
			return request, invalid()
		}
		request.Topic = topic
	}
	return request, nil
}
func (r *Runtime) Recommend(ctx context.Context, identity UsageIdentity, input Object) (Object, error) {
	if r.Gorse == nil {
		return nil, fail("discovery_recommendations_not_connected")
	}
	request, e := parseRecommendation(input)
	if e != nil {
		return nil, e
	}
	owner, e := r.identity(ctx, identity)
	if e != nil {
		return nil, e
	}
	profile := str(owner, "profileId")
	excluded, e := r.Store.Excluded(ctx, profile)
	if e != nil {
		return nil, e
	}
	plan := RecommendationPlan{}
	if r.Recommendations != nil {
		plan, e = r.Recommendations.PublicPlan(ctx, profile)
		if e != nil {
			return nil, e
		}
	}
	controlled := request.Mode == "personalized" && plan.Policy["enabled"] == true
	target := request.Limit
	if controlled {
		target = min(100, request.Limit*3)
	}
	accepted := []recommendationCandidate{}
	seen := map[string]bool{}
	received := 0
	fallback := false
	collect := func(mode string) error {
		offset := 0
		batchSize := min(100, request.Limit*3)
		for len(accepted) < target {
			reserve := 0
			if mode == "personalized" {
				reserve = max(0, request.Limit-len(accepted))
			}
			limit := min(batchSize, 100-received-reserve)
			if limit <= 0 {
				break
			}
			nativeRequest := request
			nativeRequest.Mode = mode
			nativeRequest.Limit = limit
			candidates, e := r.Gorse.Recommend(ctx, nativeRequest, profile, offset)
			if e != nil {
				return e
			}
			received += len(candidates)
			offset += len(candidates)
			for _, candidate := range candidates {
				key := str(candidate, "id")
				if seen[key] {
					continue
				}
				seen[key] = true
				if excluded[key] {
					continue
				}
				reference := ItemReference(key)
				if reference == nil {
					continue
				}
				document, e := r.Source.Load(ctx, *reference)
				if e != nil {
					return e
				}
				if document == nil {
					if e = r.Store.Enqueue(ctx, *reference); e != nil {
						return e
					}
					continue
				}
				if request.Topic != "" && document.Topic != request.Topic {
					continue
				}
				accepted = append(accepted, recommendationCandidate{Document: document, Candidate: candidate, Mode: mode})
				if len(accepted) == target {
					break
				}
			}
			if len(candidates) < limit {
				break
			}
			batchSize = min(100, batchSize*2)
		}
		return nil
	}
	if e = collect(request.Mode); e != nil {
		return nil, e
	}
	if request.Mode == "personalized" && len(accepted) < request.Limit && received < 100 {
		fallback = true
		if e = collect("latest"); e != nil {
			return nil, e
		}
	}
	ordered := accepted
	if controlled {
		ordered = applyControl(accepted, plan)
	}
	selected := []recommendationCandidate{}
	for _, candidate := range ordered {
		if r.Recommendations != nil {
			reference := ItemReference(candidate.Document.ID)
			current, e := r.Source.Load(ctx, *reference)
			if e != nil {
				return nil, e
			}
			if current == nil || current.IndexVersion != candidate.Document.IndexVersion || request.Topic != "" && current.Topic != request.Topic {
				if e = r.Store.Enqueue(ctx, *reference); e != nil {
					return nil, e
				}
				continue
			}
			candidate.Document = current
		}
		selected = append(selected, candidate)
		if len(selected) == request.Limit {
			break
		}
	}
	var attribution Object
	if r.Recommendations != nil {
		attribution, e = r.Recommendations.issue(ctx, profile, request.Mode, selected, plan)
		if e != nil {
			return nil, e
		}
	}
	items := []Object{}
	for index, candidate := range selected {
		code, label := "recommendation-candidate", "公开内容推荐"
		if candidate.Mode == "latest" {
			code = "current-new-content"
			label = "当前公开的新内容"
		}
		item := View(candidate.Document)
		item["reason"] = Object{"code": code, "label": label, "candidateSource": candidate.Candidate["source"]}
		if attribution != nil {
			item["recommendation"] = merge(merge(Object{}, attribution), Object{"position": index + 1, "candidateSource": candidate.Candidate["source"]})
		}
		items = append(items, item)
	}
	result := Object{"items": items, "mode": request.Mode, "fallback": fallback, "source": "gorse", "qualification": "current-anonymous-public-reader", "checkedAt": r.now(), "readExpiresAt": r.now() + 15}
	if attribution != nil {
		result["recommendation"] = attribution
	}
	return result, nil
}
