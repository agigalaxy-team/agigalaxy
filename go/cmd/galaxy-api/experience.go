package main

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/experiencereviews"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/qualification"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
)

func experienceService(ctx context.Context, configuration community.GovernanceRuntime, q *qualification.Service, links *accountlinks.Service, budget *resourcebudget.Service, deferRegistry ...bool) (*experiencereviews.Service, error) {
	raw, ok := configuration.Configuration["experienceReviewers"].([]any)
	if _, present := configuration.Configuration["experienceReviewers"]; !present {
		raw, ok = []any{}, true
	}
	if !ok {
		return nil, fault.New("governance_configuration_invalid", 400)
	}
	reviewers := make([]experiencereviews.Object, 0, len(raw))
	for _, value := range raw {
		item, ok := value.(map[string]any)
		if !ok {
			return nil, fault.New("governance_configuration_invalid", 400)
		}
		reviewers = append(reviewers, item)
	}
	s, err := experiencereviews.New(q.Pool, q.Endpoint, q.Devices, reviewers, nil)
	if err != nil {
		return nil, err
	}
	s.Links, s.Resources = links, budget
	if len(deferRegistry) == 0 || !deferRegistry[0] {
		if err = s.UseRegistry(ctx); err != nil {
			return nil, err
		}
	}
	q.ReadExperienceReview = s.QualificationReadWithin
	q.ReadExperienceCalculation = s.ReadCalculationWithin
	return s, nil
}
