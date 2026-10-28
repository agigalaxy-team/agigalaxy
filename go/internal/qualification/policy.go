// Package qualification retains policy-specific participation checks and
// explicitly selected current evidence; it never certifies professional skill.
package qualification

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

type Object = map[string]any
type Actor struct {
	deviceauth.Actor
	HTTPRequestID *string
}
type Service struct {
	Pool                      *pgxpool.Pool
	Endpoint                  string
	Devices                   *deviceauth.Service
	Now                       func() time.Time
	Resources                 *resourcebudget.Service
	IsBlockedWithin           func(context.Context, pgx.Tx, string, string) (bool, error)
	Assistance                *taskmaterials.Service
	Proofs                    *evidence.ProofService
	Cases                     *cases.Service
	ReadExperienceReview      func(context.Context, pgx.Tx, deviceauth.Actor, Object) (Object, error)
	ReadExperienceCalculation func(context.Context, pgx.Tx, deviceauth.Actor, Object, func(Object) error) (Object, error)
	ReadCapsuleUse            func(context.Context, pgx.Tx, deviceauth.Actor, Object) (Object, error)
	policies                  []Object
	registryEnabled           bool
}

func text(v any) string               { s, _ := v.(string); return s }
func str(v Object, key string) string { return text(v[key]) }
func object(v any) Object             { x, _ := v.(map[string]any); return x }
func array(v any) []any {
	switch x := v.(type) {
	case []any:
		return x
	case []Object:
		out := make([]any, len(x))
		for i, value := range x {
			out[i] = value
		}
		return out
	}
	return nil
}
func number(v any) int64 {
	switch n := v.(type) {
	case int:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	case json.Number:
		f, _ := n.Float64()
		return int64(f)
	}
	return 0
}
func cloneValue(v any) any {
	switch x := v.(type) {
	case json.Number:
		f, _ := x.Float64()
		return f
	case map[string]any:
		out := Object{}
		for key, value := range x {
			out[key] = cloneValue(value)
		}
		return out
	case []any:
		out := []any{}
		for _, value := range x {
			out = append(out, cloneValue(value))
		}
		return out
	case []Object:
		out := []any{}
		for _, value := range x {
			out = append(out, cloneValue(value))
		}
		return out
	}
	return v
}
func fail(code string, status ...int) error {
	n := 409
	if len(status) > 0 {
		n = status[0]
	}
	return fault.New(code, n)
}
func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}

// ParsePolicy consumes the existing single governance schema rather than
// maintaining a second implementation of its policy fields or defaults.
func ParsePolicy(input Object) (Object, error) {
	parsed, e := community.ParseGovernance(Object{"qualificationPolicies": []any{cloneValue(input)}})
	if e != nil {
		return nil, e
	}
	policies, ok := parsed["qualificationPolicies"].([]any)
	if !ok || len(policies) != 1 {
		return nil, fmt.Errorf("invalid qualification policy")
	}
	return policies[0].(map[string]any), nil
}
func New(pool *pgxpool.Pool, endpoint string, devices *deviceauth.Service, policies []Object, now func() time.Time) (*Service, error) {
	s := &Service{Pool: pool, Endpoint: endpoint, Devices: devices, Now: now, policies: []Object{}}
	seen := map[string]bool{}
	for _, input := range policies {
		policy, e := ParsePolicy(input)
		if e != nil {
			return nil, e
		}
		key := str(policy, "id") + "@" + str(policy, "version")
		if seen[key] {
			return nil, fmt.Errorf("Duplicate qualification policy")
		}
		seen[key] = true
		s.policies = append(s.policies, policy)
	}
	return s, nil
}
func DefinitionHash(input Object) (string, error) {
	policy, e := ParsePolicy(input)
	if e != nil {
		return "", e
	}
	repositories := map[string]Object{}
	for _, value := range array(policy["repositories"]) {
		r := object(value)
		normalized := Object{"owner": strings.ToLower(str(r, "owner")), "repository": strings.ToLower(str(r, "repository"))}
		raw, e := identity.Canonical(normalized)
		if e != nil {
			return "", e
		}
		repositories[string(raw)] = normalized
	}
	keys := []string{}
	for key := range repositories {
		keys = append(keys, key)
	}
	c := collate.New(language.English)
	sort.SliceStable(keys, func(i, j int) bool { return c.CompareString(keys[i], keys[j]) < 0 })
	normalized := []any{}
	for _, key := range keys {
		normalized = append(normalized, repositories[key])
	}
	policy["repositories"] = normalized
	raw, e := identity.Canonical(policy)
	if e != nil {
		return "", e
	}
	return identity.Digest(raw), nil
}
func RegistryManifest(policies []Object) (Object, error) {
	rows := []any{}
	seen := map[string]bool{}
	for _, input := range policies {
		policy, e := ParsePolicy(input)
		if e != nil {
			return nil, e
		}
		key := str(policy, "id") + "@" + str(policy, "version")
		if seen[key] {
			return nil, fmt.Errorf("Duplicate qualification policy version")
		}
		seen[key] = true
		hash, e := DefinitionHash(policy)
		if e != nil {
			return nil, e
		}
		rows = append(rows, Object{"policyId": policy["id"], "policyVersion": policy["version"], "definitionHash": hash})
	}
	if len(rows) > 64 {
		return nil, fmt.Errorf("invalid qualification registry")
	}
	c := collate.New(language.English)
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := object(rows[i]), object(rows[j])
		return c.CompareString(str(a, "policyId")+"@"+str(a, "policyVersion"), str(b, "policyId")+"@"+str(b, "policyVersion")) < 0
	})
	return Object{"version": 1, "policies": rows}, nil
}
func (s *Service) Policy(id, version, capability, collaboration string) (Object, error) {
	for _, p := range s.policies {
		if p["id"] == id && p["version"] == version && p["capabilityId"] == capability && (collaboration == "" || p["collaboration"] == collaboration) && s.now() >= number(p["notBefore"]) && s.now() < number(p["notAfter"]) {
			return cloneValue(p).(map[string]any), nil
		}
	}
	return nil, fail("qualification_policy_unavailable")
}
func (s *Service) run(ctx context.Context, a Actor, fn func(pgx.Tx) (any, error)) (any, error) {
	if s == nil || s.Pool == nil || s.Devices == nil || s.Endpoint == "" || s.Endpoint != s.Devices.Endpoint {
		return nil, fail("qualification_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (any, error) {
		if e := s.Devices.AuthorizeWithin(ctx, tx, a.Actor, "assistance"); e != nil {
			return nil, e
		}
		return fn(tx)
	})
}
