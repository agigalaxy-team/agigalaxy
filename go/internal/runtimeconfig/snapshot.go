package runtimeconfig

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"reflect"
	"regexp"
	"sort"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/incident"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/retirement"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

type Object = map[string]any

var roleFields = []string{"auditReaderIds", "auditReviewerIds", "builderAssessorIds", "moderatorIds"}
var snapshotFields = []string{"version", "incident", "requestQuotaHash", "resourceBudgetHash", "identityConfigurationHash", "governance", "retirement", "searchIndexMode", "communityQuotaHash", "forumPolicyHash", "browserPolicyHash", "chatConfigurationHash", "honorRegistry", "qualificationRegistry", "personalMcpConfigurationHash", "officialAccountConfigurationHash", "experienceReviewerRegistry", "network", "release", "signingKeyId", "trustSequence"}
var sha = regexp.MustCompile(`^[a-f0-9]{64}$`)
var ref = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$`)
var slug = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,79}$`)
var version = regexp.MustCompile(`^[0-9]+(?:\.[0-9]+){0,2}$`)
var subject = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)

func invalid() error      { return errors.New("Invalid runtime configuration") }
func object(v any) Object { o, _ := v.(map[string]any); return o }
func str(v any) string    { s, _ := v.(string); return s }
func num(v any) int64 {
	switch n := v.(type) {
	case int:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	case json.Number:
		r, _ := n.Int64()
		return r
	}
	return 0
}
func integer(v any, min int64) bool {
	switch n := v.(type) {
	case int:
		return int64(n) >= min && int64(n) <= 9007199254740991
	case int64:
		return n >= min && n <= 9007199254740991
	case float64:
		return !math.IsNaN(n) && !math.IsInf(n, 0) && n == math.Trunc(n) && n >= float64(min) && n <= 9007199254740991
	case json.Number:
		f, e := n.Float64()
		return e == nil && integer(f, min)
	}
	return false
}
func array(v any) []any { a, _ := v.([]any); return a }
func exact(o Object, required, optional []string) bool {
	if o == nil {
		return false
	}
	for _, k := range required {
		if _, ok := o[k]; !ok {
			return false
		}
	}
	for k := range o {
		found := false
		for _, a := range append(append([]string{}, required...), optional...) {
			if k == a {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func origin(s string) bool {
	u, e := url.Parse(s)
	return e == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && s == "https://"+u.Host && u.Host == strings.ToLower(u.Host) && u.Port() != "443"
}
func clone(v any) any { b, _ := protocol.Encode(v); var out any; json.Unmarshal(b, &out); return out }
func hash(v any) string {
	b, e := canonical(v)
	if e != nil {
		return ""
	}
	return identity.Digest(b)
}
func Hash(v any) (string, error) {
	b, e := canonical(v)
	if e != nil {
		return "", e
	}
	return identity.Digest(b), nil
}
func orderedStrings(v any, dedupe bool, locale bool) []any {
	result := []string{}
	seen := map[string]bool{}
	for _, v := range array(v) {
		s := str(v)
		if !dedupe || !seen[s] {
			result = append(result, s)
			seen[s] = true
		}
	}
	if locale {
		c := collate.New(language.English)
		sort.SliceStable(result, func(i, j int) bool { return c.CompareString(result[i], result[j]) < 0 })
	} else {
		sort.Strings(result)
	}
	out := []any{}
	for _, s := range result {
		out = append(out, s)
	}
	return out
}
func parseGovernance(v any) (Object, error) {
	o := object(clone(v))
	return community.ParseGovernance(o)
}

// Build uses the already loaded process values; it never reads environment or
// reopens configuration files. Absent optional keys remain absent.
func Build(input Object) (Object, error) {
	result := Object{"version": 1, "governance": nil, "retirement": nil, "release": nil, "signingKeyId": nil, "trustSequence": nil}
	for _, k := range []string{"signingKeyId", "trustSequence", "requestQuotaHash", "communityQuotaHash", "forumPolicyHash", "browserPolicyHash", "chatConfigurationHash", "resourceBudgetHash", "searchIndexMode", "network", "identityConfigurationHash", "personalMcpConfigurationHash", "officialAccountConfigurationHash"} {
		if v, ok := input[k]; ok {
			result[k] = clone(v)
		}
	}
	if v, ok := input["incident"]; ok {
		result["incident"] = nil
		if v != nil {
			var p incident.Policy
			b, _ := protocol.Encode(v)
			if protocol.Decode(b, &p) != nil || p.Validate() != nil {
				return nil, invalid()
			}
			p.PublicMessage = trim(p.PublicMessage)
			result["incident"] = Object{"id": p.ID, "revision": p.Revision, "state": p.State, "updatedAt": p.UpdatedAt, "sha256": hash(p)}
		}
	}
	if v := input["governance"]; v != nil {
		config, e := parseGovernance(v)
		if e != nil {
			return nil, e
		}
		configurationHash, e := community.GovernanceConfigurationHash(config)
		if e != nil {
			return nil, e
		}
		roles := Object{}
		for _, k := range roleFields {
			roles[k] = orderedStrings(config[k], true, true)
		}
		review := input["governanceReview"]
		result["governance"] = Object{"configurationSha256": configurationHash, "review": clone(review), "roles": roles, "policyHashes": Object{"honorRules": hash(config["honorRules"]), "qualificationPolicies": hash(config["qualificationPolicies"]), "conformanceSuitePins": hash(config["conformanceSuitePins"])}}
	}
	if v := input["retirement"]; v != nil {
		var p retirement.Policy
		b, _ := protocol.Encode(v)
		if protocol.Decode(b, &p) != nil || p.Validate() != nil {
			return nil, invalid()
		}
		result["retirement"] = Object{"id": p.ID, "sha256": hash(p), "announcedAt": p.AnnouncedAt, "stopWritesAt": p.StopWritesAt, "takeoutUntil": p.TakeoutUntil, "statusUntil": p.StatusUntil}
	}
	if v := input["release"]; v != nil {
		r := object(v)
		result["release"] = Object{"id": r["releaseId"], "configurationVersion": r["configurationVersion"], "manifestSha256": r["manifestSha256"]}
	}
	if e := validateSnapshot(result); e != nil {
		return nil, e
	}
	return result, nil
}
func trim(s string) string {
	return strings.Trim(s, "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
}
func validateSnapshot(s Object) error {
	if !exact(s, []string{"version", "governance", "retirement", "release", "signingKeyId", "trustSequence"}, snapshotFields) || num(s["version"]) != 1 || !integer(s["version"], 1) {
		return invalid()
	}
	for _, k := range []string{"requestQuotaHash", "resourceBudgetHash", "identityConfigurationHash", "communityQuotaHash", "forumPolicyHash", "browserPolicyHash", "chatConfigurationHash", "personalMcpConfigurationHash", "officialAccountConfigurationHash"} {
		if v, ok := s[k]; ok {
			nullable := k == "chatConfigurationHash" || k == "personalMcpConfigurationHash" || k == "officialAccountConfigurationHash"
			if !(nullable && v == nil) && !sha.MatchString(str(v)) {
				return invalid()
			}
		}
	}
	if v := s["signingKeyId"]; v != nil && (protocol.TextLength(str(v)) < 1 || protocol.TextLength(str(v)) > 200) {
		return invalid()
	}
	if v := s["trustSequence"]; v != nil && !integer(v, 0) {
		return invalid()
	}
	if v, ok := s["searchIndexMode"]; ok && v != "enabled" && v != "disabled" && v != "unconfigured" {
		return invalid()
	}
	if v, ok := s["network"]; ok {
		o := object(v)
		if !exact(o, []string{"type", "manifestSha256"}, nil) || (o["type"] != "official" && o["type"] != "hub") || !sha.MatchString(str(o["manifestSha256"])) {
			return invalid()
		}
	}
	if v, ok := s["incident"]; ok && v != nil {
		o := object(v)
		if !exact(o, []string{"id", "revision", "state", "updatedAt", "sha256"}, nil) || !ref.MatchString(str(o["id"])) || !integer(o["revision"], 1) || !integer(o["updatedAt"], 0) || !sha.MatchString(str(o["sha256"])) || (o["state"] != "contained" && o["state"] != "recovery" && o["state"] != "resolved") {
			return invalid()
		}
	}
	if v := s["retirement"]; v != nil {
		o := object(v)
		if !exact(o, []string{"id", "sha256", "announcedAt", "stopWritesAt", "takeoutUntil", "statusUntil"}, nil) || !ref.MatchString(str(o["id"])) || !sha.MatchString(str(o["sha256"])) {
			return invalid()
		}
		for _, k := range []string{"announcedAt", "stopWritesAt", "takeoutUntil", "statusUntil"} {
			if !integer(o[k], 0) {
				return invalid()
			}
		}
	}
	if v := s["release"]; v != nil {
		o := object(v)
		if !exact(o, []string{"id", "configurationVersion", "manifestSha256"}, nil) || !ref.MatchString(str(o["id"])) || !ref.MatchString(str(o["configurationVersion"])) || !sha.MatchString(str(o["manifestSha256"])) {
			return invalid()
		}
	}
	if v := s["governance"]; v != nil {
		o := object(v)
		if !exact(o, []string{"roles", "policyHashes"}, []string{"configurationSha256", "review"}) {
			return invalid()
		}
		if h, ok := o["configurationSha256"]; ok && !sha.MatchString(str(h)) {
			return invalid()
		}
		if r := o["review"]; r != nil {
			if e := community.ValidateGovernanceReviewRecord(object(r)); e != nil {
				return e
			}
		}
		roles := object(o["roles"])
		if !exact(roles, roleFields, nil) {
			return invalid()
		}
		for _, k := range roleFields {
			a, ok := roles[k].([]any)
			if !ok || len(a) > 128 {
				return invalid()
			}
			for _, id := range a {
				if !subject.MatchString(str(id)) {
					return invalid()
				}
			}
		}
		ph := object(o["policyHashes"])
		if !exact(ph, []string{"honorRules", "qualificationPolicies", "conformanceSuitePins"}, nil) {
			return invalid()
		}
		for _, v := range ph {
			if !sha.MatchString(str(v)) {
				return invalid()
			}
		}
	}
	for _, k := range []string{"honorRegistry", "qualificationRegistry", "experienceReviewerRegistry"} {
		if v, ok := s[k]; ok {
			if e := validateRegistry(k, object(v)); e != nil {
				return e
			}
		}
	}
	return nil
}
func validateRegistry(kind string, o Object) error {
	field, max := "rules", 8
	if kind == "qualificationRegistry" {
		field, max = "policies", 64
	}
	if kind == "experienceReviewerRegistry" {
		field, max = "reviewers", 128
	}
	if !exact(o, []string{"version", field}, nil) || num(o["version"]) != 1 || !integer(o["version"], 1) {
		return invalid()
	}
	a, ok := o[field].([]any)
	if !ok || len(a) > max {
		return invalid()
	}
	for _, v := range a {
		r := object(v)
		switch kind {
		case "honorRegistry":
			if !exact(r, []string{"ruleId", "ruleVersion", "definitionHash", "revoked"}, nil) || !slug.MatchString(str(r["ruleId"])) || !version.MatchString(str(r["ruleVersion"])) {
				return invalid()
			}
			if _, ok := r["revoked"].(bool); !ok {
				return invalid()
			}
		case "qualificationRegistry":
			if !exact(r, []string{"policyId", "policyVersion", "definitionHash"}, nil) || !slug.MatchString(str(r["policyId"])) || !version.MatchString(str(r["policyVersion"])) {
				return invalid()
			}
		default:
			if !exact(r, []string{"subjectId", "definitionHash"}, nil) || !subject.MatchString(str(r["subjectId"])) {
				return invalid()
			}
		}
		if !sha.MatchString(str(r["definitionHash"])) {
			return invalid()
		}
	}
	return nil
}
func equal(a, b any) bool { return hash(a) == hash(b) }
func contains(a []any, v any) bool {
	for _, x := range a {
		if reflect.DeepEqual(x, v) {
			return true
		}
	}
	return false
}
func difference(previous, next Object) Object {
	changed := []any{}
	for _, k := range snapshotFields {
		if v, ok := next[k]; ok && !equal(previous[k], v) {
			changed = append(changed, k)
		}
	}
	roles := Object{}
	before := object(object(previous["governance"])["roles"])
	after := object(object(next["governance"])["roles"])
	for _, k := range roleFields {
		added, removed := []any{}, []any{}
		for _, id := range array(after[k]) {
			if !contains(array(before[k]), id) {
				added = append(added, id)
			}
		}
		for _, id := range array(before[k]) {
			if !contains(array(after[k]), id) {
				removed = append(removed, id)
			}
		}
		roles[k] = Object{"added": added, "removed": removed}
	}
	return Object{"changedSections": changed, "roles": roles}
}
func command(input Object) (Object, error) {
	o := object(clone(input))
	if !exact(o, []string{"id", "endpoint", "component", "snapshot"}, []string{"operatorRef"}) || !uuidPattern.MatchString(str(o["id"])) || !origin(str(o["endpoint"])) || (o["component"] != "api" && o["component"] != "worker") {
		return nil, invalid()
	}
	if _, ok := o["operatorRef"]; !ok {
		o["operatorRef"] = "unattributed-runtime"
	}
	if !ref.MatchString(str(o["operatorRef"])) {
		return nil, invalid()
	}
	if e := validateSnapshot(object(o["snapshot"])); e != nil {
		return nil, e
	}
	return o, nil
}
func mismatch(s string) error { return fmt.Errorf("%s", s) }
