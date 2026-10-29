package actions

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"slices"
)

func (s *Service) discoveryAuthority(a Actor) (*operationspermissions.BusinessAuthority, error) {
	authority, ok := s.authority(a).(*operationspermissions.BusinessAuthority)
	if !ok {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	return authority, nil
}
func (s *Service) searchQuality(a Actor, fresh Authorize) (*discovery.SearchQuality, error) {
	if s.SearchQuality == nil {
		return nil, fail("operations_agentos_action_not_connected", 503)
	}
	authority, e := s.discoveryAuthority(a)
	if e != nil {
		return nil, e
	}
	return s.SearchQuality.WithAuthorize(authority, fresh), nil
}
func (s *Service) recommendations(a Actor, fresh Authorize) (*discovery.Recommendations, error) {
	if s.Recommendations == nil {
		return nil, fail("operations_agentos_action_not_connected", 503)
	}
	authority, e := s.discoveryAuthority(a)
	if e != nil {
		return nil, e
	}
	return s.Recommendations.WithAuthorize(authority, fresh), nil
}
func unknownRecommendation(operationID string) Object {
	return Object{"operationId": operationID, "state": "unknown", "summary": "正在确认保存结果…", "receipt": nil}
}
func (s *Service) executeDiscovery(ctx context.Context, a Actor, x, command Object, fresh Authorize) (Object, error) {
	if x["kind"] == "recommendation-direction" {
		service, e := s.recommendations(a, fresh)
		if e != nil {
			return nil, e
		}
		result, e := service.SavePolicy(ctx, a, recommendationPolicyBody(command), &discovery.ThemeExpectation{Key: str(command["themeKey"]), ExpectedVersion: num(command["themeVersion"]), Enabled: command["themeEnabled"] == true})
		if e != nil && !slices.Contains([]string{"invalid_recommendation_request", "recommendation_policy_changed", "recommendation_theme_changed", "recommendation_theme_unavailable", "recommendation_operation_conflict"}, fault.Code(e)) {
			return unknownRecommendation(str(command["operationId"])), nil
		}
		return result, e
	}
	service, e := s.searchQuality(a, fresh)
	if e != nil {
		return nil, e
	}
	if x["kind"] == "search-draft-save" {
		return service.CommandPreparedDraft(ctx, a, command)
	}
	method := "apply"
	if x["kind"] == "search-restore" {
		method = "restore"
	}
	return service.Command(ctx, a, method, command)
}
func (s *Service) recoverDiscovery(ctx context.Context, a Actor, x, command Object, operationID string) (Object, error) {
	conflict := func() (Object, error) { return nil, fail("operations_agentos_operation_conflict", 409) }
	if x["kind"] == "recommendation-direction" {
		service, e := s.recommendations(a, nil)
		if e != nil {
			return nil, e
		}
		saved, e := service.CommandResult(ctx, a, operationID)
		if e != nil {
			return nil, e
		}
		row, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return service.CommandRecordWithin(ctx, tx, operationID) })
		if e != nil {
			return nil, e
		}
		if row == nil {
			if saved["state"] == "recorded" {
				return conflict()
			}
			return unknownRecommendation(operationID), nil
		}
		canonical, e := identity.Canonical(Object{"kind": "policy", "input": recommendationPolicyBody(command)})
		if e != nil {
			return nil, e
		}
		digest := sha256.Sum256(canonical)
		hash := hex.EncodeToString(digest[:])
		receipt := obj(saved["result"])
		if row["operator_id"] != a.ID || row["kind"] != "policy-updated" || row["theme_key"] != x["themeKey"] || row["request_hash"] != hash || num(row["revision"]) != num(command["expectedVersion"])+1 || saved["state"] != "recorded" || saved["operationId"] != operationID || saved["kind"] != "policy" || num(receipt["version"]) != num(row["revision"]) || receipt["themeKey"] != x["themeKey"] {
			return conflict()
		}
		result := clone(obj(row["result"]))
		result["replayed"] = true
		return result, nil
	}
	service, e := s.searchQuality(a, nil)
	if e != nil {
		return nil, e
	}
	row, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return service.CommandRecordWithin(ctx, tx, operationID) })
	if e != nil {
		return nil, e
	}
	if row == nil {
		return nil, nil
	}
	method := "apply"
	if x["kind"] == "search-draft-save" {
		method = "draft"
	}
	if x["kind"] == "search-restore" {
		method = "restore"
	}
	if row["operator_id"] != a.ID || row["kind"] != method || !same(row["input"], command) || method != "draft" && row["version_id"] != command["versionId"] {
		return conflict()
	}
	result, e := service.Operation(ctx, a, operationID)
	if fault.Code(e) == "search_quality_operation_unavailable" && fault.Status(e) == 404 {
		return nil, nil
	}
	return result, e
}
func (s *Service) qualifyDiscoveryWithin(ctx context.Context, tx pgx.Tx, a Actor, request, command Object, grantID string) error {
	if request["kind"] == "recommendation-direction" {
		service, e := s.recommendations(a, nil)
		if e != nil {
			return e
		}
		catalog, e := service.CatalogWithin(ctx, tx)
		if e != nil {
			return e
		}
		for _, theme := range catalog {
			if theme["key"] == request["themeKey"] && theme["enabled"] == true {
				return nil
			}
		}
		return fail("recommendation_theme_unavailable", 409)
	}
	service, e := s.searchQuality(a, nil)
	if e != nil {
		return e
	}
	row, e := service.VersionWithin(ctx, tx, str(command["versionId"]))
	if e != nil {
		return e
	}
	if row == nil {
		return fail("search_quality_version_unavailable", 409)
	}
	return nil
}
