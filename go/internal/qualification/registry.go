package qualification

import (
	"context"
	"encoding/json"
	"regexp"

	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

var policyID = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,79}$`)
var policyVersion = regexp.MustCompile(`^[0-9]+(?:\.[0-9]+){0,2}$`)
var sha256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func registryVersionOne(value any) bool {
	switch v := value.(type) {
	case float64:
		return v == 1
	case int:
		return v == 1
	case int64:
		return v == 1
	case json.Number:
		n, e := v.Float64()
		return e == nil && n == 1
	}
	return false
}

func closed(v Object, keys ...string) bool {
	if len(v) != len(keys) {
		return false
	}
	for _, key := range keys {
		if v[key] == nil {
			return false
		}
	}
	return true
}
func CurrentRegistryWithin(ctx context.Context, tx pgx.Tx, endpoint string) (Object, error) {
	var current Object
	if e := tx.QueryRow(ctx, "SELECT to_jsonb(r) FROM runtime_config_events r WHERE endpoint=$1 AND component='api' ORDER BY sequence DESC LIMIT 1", endpoint).Scan(&current); e != nil {
		if e == pgx.ErrNoRows {
			return nil, fail("qualification_registry_unavailable", 503)
		}
		return nil, e
	}
	registry := object(object(object(current["payload"])["snapshot"])["qualificationRegistry"])
	if !closed(registry, "version", "policies") || !registryVersionOne(registry["version"]) {
		return nil, fail("qualification_registry_unavailable", 503)
	}
	policies, ok := registry["policies"].([]any)
	if !ok || len(policies) > 64 {
		return nil, fail("qualification_registry_unavailable", 503)
	}
	for _, value := range policies {
		p := object(value)
		if !closed(p, "policyId", "policyVersion", "definitionHash") || !policyID.MatchString(str(p, "policyId")) || !policyVersion.MatchString(str(p, "policyVersion")) || !sha256Pattern.MatchString(str(p, "definitionHash")) {
			return nil, fail("qualification_registry_unavailable", 503)
		}
	}
	return Object{"configurationEventId": current["id"], "version": 1, "policies": policies}, nil
}

// UseRegistry is explicit startup preparation after the original runtime
// configuration has been recorded. It never creates an observation or policy.
func (s *Service) UseRegistry(ctx context.Context) error {
	if _, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return CurrentRegistryWithin(ctx, tx, s.Endpoint) }); e != nil {
		return e
	}
	s.registryEnabled = true
	return nil
}
func registered(registry Object, policy Object, hash string) bool {
	for _, value := range array(registry["policies"]) {
		p := object(value)
		if p["policyId"] == policy["id"] && p["policyVersion"] == policy["version"] && p["definitionHash"] == hash {
			return true
		}
	}
	return false
}
func (s *Service) PolicyWithin(ctx context.Context, tx pgx.Tx, id, version, capability, collaboration string) (Object, error) {
	policy, e := s.Policy(id, version, capability, collaboration)
	if e != nil {
		return nil, e
	}
	if s.registryEnabled {
		registry, e := CurrentRegistryWithin(ctx, tx, s.Endpoint)
		if e != nil {
			return nil, e
		}
		hash, e := DefinitionHash(policy)
		if e != nil {
			return nil, e
		}
		if !registered(registry, policy, hash) {
			return nil, fail("qualification_policy_unavailable")
		}
	}
	return policy, nil
}
func (s *Service) List(ctx context.Context, a Actor) (any, error) {
	return s.run(ctx, a, func(tx pgx.Tx) (any, error) {
		var registry Object
		var e error
		if s.registryEnabled {
			registry, e = CurrentRegistryWithin(ctx, tx, s.Endpoint)
			if e != nil {
				return nil, e
			}
		}
		policies := []any{}
		for _, policy := range s.policies {
			if number(policy["notBefore"]) > s.now() || number(policy["notAfter"]) <= s.now() {
				continue
			}
			hash, e := DefinitionHash(policy)
			if e != nil {
				return nil, e
			}
			if registry != nil && !registered(registry, policy, hash) {
				continue
			}
			p := cloneValue(policy).(map[string]any)
			p["definitionHash"] = hash
			p["purpose"] = "participation-eligibility"
			p["capabilityVerified"] = false
			policies = append(policies, p)
		}
		var configuration any
		if registry != nil {
			configuration = registry["configurationEventId"]
		}
		return Object{"issuer": s.Endpoint, "configurationEventId": configuration, "registeredPolicyVersions": registry != nil, "policies": policies}, nil
	})
}
