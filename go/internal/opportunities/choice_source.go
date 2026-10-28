package opportunities

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

// ReadChoiceWireWithin is the original ChoiceSourceReaderV2 opportunity read.
// The choice owner checks its history scope and owns the persistent locator;
// this method rechecks the exact current source and opportunity ID, with the
// same record member order used by QueryWireWithin for dependency hashes.
func (s *Service) ReadChoiceWireWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, locator, query Object) (json.RawMessage, error) {
	ref := obj(locator, "source")
	var sourceContext Object
	var e error
	if query != nil {
		sourceContext, e = s.ContextWithin(ctx, tx, a, query)
		if e != nil {
			return nil, e
		}
	} else {
		var project Object
		switch str(ref, "sourceKind") {
		case "recruitment":
			reader, ok := s.Recruitment.(interface {
				ReadWithin(context.Context, pgx.Tx, *deviceauth.Actor, string, bool) (map[string]any, error)
			})
			if !ok {
				return nil, fail("discovery_recruitment_unavailable", 503)
			}
			view, err := reader.ReadWithin(ctx, tx, a, str(ref, "recruitmentId"), true)
			if err != nil {
				return nil, err
			}
			project = obj(view, "document")
		case "project":
			if s.Projects == nil {
				return nil, fail("discovery_project_unavailable", 503)
			}
			view, err := s.Projects.ReadWithin(ctx, tx, a, str(ref, "projectId"))
			if err != nil {
				return nil, err
			}
			project = obj(view, "document")
		default:
			if s.Profiles == nil {
				return nil, fail("discovery_profile_unavailable", 503)
			}
			view, err := s.Profiles.ReadWithin(ctx, tx, a, str(ref, "subjectId"))
			if err != nil {
				return nil, err
			}
			for _, p := range objectItems(obj(view, "selfDeclared")["projects"]) {
				if str(p, "id") == str(ref, "projectId") {
					project = p
					break
				}
			}
		}
		if project == nil {
			return nil, fail("choice_source_unavailable", 409)
		}
		sourceContext = Object{"source": project, "wish": Object{"enabled": true, "purposes": locator["purposes"], "functions": []string{}}}
	}
	candidates, e := s.opportunityWithin(ctx, tx, a, str(ref, "subjectId"), sourceContext)
	if e != nil {
		return nil, e
	}
	for _, candidate := range candidates {
		if str(candidate, "id") == str(locator, "id") {
			wire, e := s.cardWire(ctx, tx, a, candidate)
			if e != nil {
				return nil, e
			}
			b, e := protocol.EncodeJS(wire)
			return json.RawMessage(b), e
		}
	}
	return nil, nil
}
