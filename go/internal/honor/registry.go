package honor

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

var ruleIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,79}$`)
var ruleVersionPattern = regexp.MustCompile(`^[0-9]+(?:\.[0-9]+){0,2}$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var ruleFields = []string{"sourceProfile", "id", "version", "title", "capabilityId", "communityId", "kind", "members", "relatedPartyGroups", "notBefore", "notAfter", "revoked", "windowFrom", "windowUntil", "minAcceptedCases", "minProofs", "repositories", "rankingEnabled", "privacyReview", "minimumCohort", "minimumCasesPerMember"}

func orderedRule(rule Object) *protocol.OrderedObject {
	out := protocol.NewOrderedObject()
	for _, k := range ruleFields {
		if v, ok := rule[k]; ok {
			if k == "repositories" {
				repos := []any{}
				for _, v := range array(v) {
					r := object(v)
					repos = append(repos, ordered("owner", r["owner"], "repository", r["repository"]))
				}
				v = repos
			}
			out.Set(k, v)
		}
	}
	return out
}
func Definition(input Object) (Object, string, error) {
	rule, e := ParseRule(input)
	if e != nil {
		return nil, "", e
	}
	rule["revoked"] = false
	sortArray := func(v any) []any {
		a := append([]any{}, array(v)...)
		sort.SliceStable(a, func(i, j int) bool { return text(a[i]) < text(a[j]) })
		return a
	}
	rule["members"] = sortArray(rule["members"])
	groups := []any{}
	for _, group := range array(rule["relatedPartyGroups"]) {
		groups = append(groups, sortArray(group))
	}
	jsonKey := func(v any) string { b, _ := protocol.EncodeJS(v); return string(b) }
	sort.SliceStable(groups, func(i, j int) bool { return jsonKey(groups[i]) < jsonKey(groups[j]) })
	rule["relatedPartyGroups"] = groups
	repos := []any{}
	for _, v := range array(rule["repositories"]) {
		r := object(v)
		repos = append(repos, ordered("owner", strings.ToLower(str(r, "owner")), "repository", strings.ToLower(str(r, "repository"))))
	}
	sort.SliceStable(repos, func(i, j int) bool { return jsonKey(repos[i]) < jsonKey(repos[j]) })
	plain := []any{}
	for _, v := range repos {
		plain = append(plain, object(v))
	}
	rule["repositories"] = plain
	raw, e := identity.Canonical(rule)
	if e != nil {
		return nil, "", e
	}
	return rule, identity.Digest(raw), nil
}
func RegistryManifest(rules []Object) (Object, error) {
	if len(rules) > 8 {
		return nil, fmtError("invalid Honor registry")
	}
	seen := map[string]bool{}
	refs := []any{}
	for _, r := range rules {
		_, hash, e := Definition(r)
		if e != nil {
			return nil, e
		}
		key := str(r, "id") + "@" + str(r, "version")
		if seen[key] {
			return nil, fmtError("Duplicate Honor rule version")
		}
		seen[key] = true
		revoked := false
		if r["revoked"] == true {
			revoked = true
		}
		refs = append(refs, Object{"ruleId": r["id"], "ruleVersion": r["version"], "definitionHash": hash, "revoked": revoked})
	}
	sort.SliceStable(refs, func(i, j int) bool {
		a, b := object(refs[i]), object(refs[j])
		return str(a, "ruleId")+"@"+str(a, "ruleVersion") < str(b, "ruleId")+"@"+str(b, "ruleVersion")
	})
	return Object{"version": 1, "rules": refs}, nil
}
func fmtError(s string) error { return fmt.Errorf("%s", s) }
func CurrentRegistryWithin(ctx context.Context, tx pgx.Tx, endpoint string) (Object, error) {
	current, e := row(ctx, tx, "SELECT to_jsonb(r) FROM runtime_config_events r WHERE endpoint=$1 AND component='api' ORDER BY sequence DESC LIMIT 1", endpoint)
	if e != nil {
		return nil, e
	}
	snapshot := object(object(current["payload"])["snapshot"])
	registry := object(snapshot["honorRegistry"])
	if !closed(registry, []string{"version", "rules"}, nil) || !exactOne(registry["version"]) {
		return nil, fail("honor_registry_unavailable", 503)
	}
	refs, ok := registry["rules"].([]any)
	if !ok || len(refs) > 8 {
		return nil, fail("honor_registry_unavailable", 503)
	}
	for _, v := range refs {
		r := object(v)
		if !closed(r, []string{"ruleId", "ruleVersion", "definitionHash", "revoked"}, nil) || !ruleIDPattern.MatchString(str(r, "ruleId")) || !ruleVersionPattern.MatchString(str(r, "ruleVersion")) || !hashPattern.MatchString(str(r, "definitionHash")) {
			return nil, fail("honor_registry_unavailable", 503)
		}
		if _, ok := r["revoked"].(bool); !ok {
			return nil, fail("honor_registry_unavailable", 503)
		}
	}
	return Object{"configurationEventId": current["id"], "sequence": current["sequence"], "observedAt": object(current["payload"])["observedAt"], "rules": refs}, nil
}

type selectedRule struct {
	Rule       Object
	Configured bool
	Registry   Object
}

func (s *Service) selectRule(ctx context.Context, tx pgx.Tx, id, version string, state, rowHint Object) (selectedRule, error) {
	if !s.registryEnabled {
		for _, r := range s.rules {
			if r["id"] == id && r["version"] == version {
				return selectedRule{Rule: r, Configured: true}, nil
			}
		}
		return selectedRule{}, fail("honor_rule_unavailable", 404)
	}
	var e error
	if state == nil {
		state, e = CurrentRegistryWithin(ctx, tx, s.Endpoint)
		if e != nil {
			return selectedRule{}, e
		}
	}
	record := rowHint
	if record == nil {
		record, e = row(ctx, tx, "SELECT to_jsonb(v) FROM honor_rule_versions v WHERE endpoint=$1 AND rule_id=$2 AND rule_version=$3", s.Endpoint, id, version)
		if e != nil {
			return selectedRule{}, e
		}
	}
	if record == nil {
		return selectedRule{}, fail("honor_rule_unavailable", 404)
	}
	definition, hash, e := Definition(object(record["definition"]))
	if e != nil {
		return selectedRule{}, e
	}
	if hash != record["definition_hash"] {
		return selectedRule{}, fail("honor_registry_inconsistent", 503)
	}
	var configured, observation Object
	for _, v := range array(state["rules"]) {
		r := object(v)
		if r["ruleId"] == id && r["ruleVersion"] == version {
			configured = r
			observation = r
			break
		}
	}
	mentioned := state["configurationEventId"]
	if observation == nil {
		ref, _ := json.Marshal([]any{Object{"ruleId": id, "ruleVersion": version}})
		previous, e := row(ctx, tx, "SELECT to_jsonb(r) FROM runtime_config_events r WHERE endpoint=$1 AND component='api' AND sequence<=$2 AND payload->'snapshot'->'honorRegistry'->'rules' @> $3::jsonb ORDER BY sequence DESC LIMIT 1", s.Endpoint, state["sequence"], ref)
		if e != nil {
			return selectedRule{}, e
		}
		mentioned = previous["id"]
		for _, v := range array(object(object(object(previous["payload"])["snapshot"])["honorRegistry"])["rules"]) {
			r := object(v)
			if r["ruleId"] == id && r["ruleVersion"] == version {
				observation = r
				break
			}
		}
	}
	if observation == nil || observation["definitionHash"] != hash {
		return selectedRule{}, fail("honor_registry_inconsistent", 503)
	}
	definition["revoked"] = observation["revoked"]
	created, e := time.Parse(time.RFC3339Nano, str(record, "created_at"))
	if e != nil {
		return selectedRule{}, e
	}
	registry := Object{"version": 1, "definitionHash": hash, "introducedConfigurationId": record["introduced_config_id"], "introducedAt": created.UTC().Format("2006-01-02T15:04:05.000Z"), "configurationEventId": state["configurationEventId"], "configurationSequence": state["sequence"], "lastMentionedConfigurationId": mentioned, "configured": configured != nil, "revoked": observation["revoked"], "independentlyCertified": false}
	return selectedRule{Rule: definition, Configured: configured != nil, Registry: registry}, nil
}
func (s *Service) UseRegistry(ctx context.Context) error {
	_, e := s.read(ctx, nil, false, func(tx pgx.Tx) (Object, error) { return CurrentRegistryWithin(ctx, tx, s.Endpoint) })
	if e != nil {
		return e
	}
	s.registryEnabled = true
	return nil
}
func (s *Service) publicRule(rule Object, v2 bool) *protocol.OrderedObject {
	out := protocol.NewOrderedObject()
	full := orderedRule(rule)
	for _, key := range full.Keys() {
		if key != "members" && key != "relatedPartyGroups" {
			out.Set(key, full.Values()[key])
		}
	}
	out.Set("issuer", s.Endpoint)
	if rule["sourceProfile"] == "facts-v2" {
		out.Set("requiredApiVersion", 2)
	}
	method := "distinct accepted source Cases; distinct numeric CI repository/run/attempt sources, conflicts excluded"
	if rule["sourceProfile"] == "facts-v2" {
		method = "facts-v2 sources; use /v2/honor"
	}
	out.Set("method", method)
	out.Set("independence", "Related parties are issuer-declared; other relationships are unverified.")
	out.Set("capabilityVerified", false)
	if v2 {
		out.Set("method", "current scoped contributions from real distinct Cases; multiple actual roles; selected disclosed fields only")
		out.Set("sourceProfile", "facts-v2")
	}
	return out
}
