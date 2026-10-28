package community

import (
	"fmt"
	"math"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

var governanceSubject = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var governanceUUID = regexp.MustCompile(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var governanceID = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,79}$`)
var governanceVersion = regexp.MustCompile(`^[0-9]+(?:\.[0-9]+){0,2}$`)
var governanceCapability = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$`)
var governanceSHA = regexp.MustCompile(`^[a-f0-9]{64}$`)
var governanceReference = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$`)

const safeInteger = int64(9007199254740991)

func govError() error { return fmt.Errorf("invalid governance configuration") }
func govInt(v any, min, max int64) bool {
	switch n := v.(type) {
	case float64:
		return !math.IsNaN(n) && !math.IsInf(n, 0) && n == math.Trunc(n) && n >= float64(min) && n <= float64(max)
	case int:
		return int64(n) >= min && int64(n) <= max
	case int64:
		return n >= min && n <= max
	}
	return false
}
func govNum(o Object, k string) int64 {
	switch n := o[k].(type) {
	case float64:
		return int64(n)
	case int:
		return int64(n)
	case int64:
		return n
	}
	return 0
}
func govBool(o Object, k string, def *bool) bool {
	v, ok := o[k]
	if !ok && def != nil {
		o[k] = *def
		return true
	}
	_, ok = v.(bool)
	return ok
}
func govWhitespace(v uint16) bool {
	return v >= 9 && v <= 13 || v == 0x20 || v == 0xa0 || v == 0x1680 || v >= 0x2000 && v <= 0x200a || v == 0x2028 || v == 0x2029 || v == 0x202f || v == 0x205f || v == 0x3000 || v == 0xfeff
}
func govText(o Object, k string, max int) bool {
	var units []uint16
	special := false
	switch v := o[k].(type) {
	case string:
		units = utf16.Encode([]rune(v))
	case governanceString:
		units = v
		special = true
	default:
		return false
	}
	for len(units) > 0 && govWhitespace(units[0]) {
		units = units[1:]
	}
	for len(units) > 0 && govWhitespace(units[len(units)-1]) {
		units = units[:len(units)-1]
	}
	if n := govCodePoints(units); n < 1 || n > max {
		return false
	}
	if special {
		o[k] = governanceString(units)
	} else {
		o[k] = string(utf16.Decode(units))
	}
	return true
}
func govStringLength(v any) int {
	switch s := v.(type) {
	case string:
		return govCodePoints(utf16.Encode([]rune(s)))
	case governanceString:
		return govCodePoints(s)
	}
	return -1
}

// Zod string min/max counts code points. Preserve lone UTF-16 surrogates in
// governanceString for the separate original JSON/signature byte contract.
func govCodePoints(units []uint16) int {
	n := 0
	for i := 0; i < len(units); i++ {
		n++
		if units[i] >= 0xd800 && units[i] <= 0xdbff && i+1 < len(units) && units[i+1] >= 0xdc00 && units[i+1] <= 0xdfff {
			i++
		}
	}
	return n
}
func govStrings(v any, min, max int, pattern *regexp.Regexp, unique bool) ([]string, bool) {
	values, ok := v.([]any)
	if !ok || len(values) < min || len(values) > max {
		return nil, false
	}
	out := []string{}
	for _, value := range values {
		s, ok := value.(string)
		if !ok || pattern != nil && !pattern.MatchString(s) || unique && hasString(out, s) {
			return nil, false
		}
		out = append(out, s)
	}
	return out, true
}
func govArray(o Object, key string, max int, optional bool) ([]any, bool) {
	v, present := o[key]
	if !present {
		if optional {
			return nil, true
		}
		o[key] = []any{}
		return []any{}, true
	}
	a, ok := v.([]any)
	return a, ok && len(a) <= max
}
func govValidity(o Object, from, until string) bool {
	return govInt(o[from], 0, safeInteger) && govInt(o[until], 1, safeInteger) && govNum(o, until) > govNum(o, from)
}
func govRepositories(v any) bool {
	a, ok := v.([]any)
	if !ok || len(a) > 16 {
		return false
	}
	owner := regexp.MustCompile(`^[A-Za-z0-9-]{1,100}$`)
	repo := regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)
	for _, value := range a {
		r, ok := value.(map[string]any)
		if !ok || !strict(r, "owner", "repository") || !owner.MatchString(str(r, "owner")) || !repo.MatchString(str(r, "repository")) {
			return false
		}
	}
	return true
}
func govURL(value any) bool {
	s, ok := value.(string)
	if !ok {
		if special, yes := value.(governanceString); yes {
			s = string(utf16.Decode(special))
		} else {
			return false
		}
	}
	if govStringLength(value) > 500 {
		return false
	}
	s = strings.TrimFunc(s, func(r rune) bool { return r <= 0x20 })
	s = strings.NewReplacer("\t", "", "\r", "", "\n", "").Replace(s)
	u, e := url.Parse(s)
	if e != nil || !strings.EqualFold(u.Scheme, "https") || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	if port := u.Port(); port != "" {
		n, e := strconv.Atoi(port)
		if e != nil || n > 65535 {
			return false
		}
	}
	return true
}
func parseGovernanceConfiguration(input any) (Object, error) {
	o, ok := input.(map[string]any)
	if !ok || !strict(o, "experienceReviewers", "auditReaderIds", "auditReviewerIds", "conformanceSuitePins", "builderAssessorIds", "honorRules", "qualificationPolicies", "moderatorIds") {
		return nil, govError()
	}
	for key, max := range map[string]int{"auditReaderIds": 32, "auditReviewerIds": 32, "builderAssessorIds": 8, "moderatorIds": 8} {
		a, ok := govArray(o, key, max, false)
		if !ok {
			return nil, govError()
		}
		if _, ok = govStrings(a, 0, max, governanceSubject, true); !ok {
			return nil, govError()
		}
	}
	if a, ok := govArray(o, "experienceReviewers", 128, true); !ok {
		return nil, govError()
	} else if a != nil {
		for _, value := range a {
			r, ok := value.(map[string]any)
			if !ok || !strict(r, "subjectId", "capabilityIds", "kinds", "scope", "notBefore", "notAfter", "authorityReference", "synthetic") || !governanceSubject.MatchString(str(r, "subjectId")) || !govText(r, "scope", 1600) || !govText(r, "authorityReference", 1600) || !govValidity(r, "notBefore", "notAfter") {
				return nil, govError()
			}
			if _, ok := govStrings(r["capabilityIds"], 1, 32, governanceCapability, false); !ok {
				return nil, govError()
			}
			kinds, ok := govStrings(r["kinds"], 1, 2, nil, false)
			if !ok {
				return nil, govError()
			}
			for _, kind := range kinds {
				if kind != "external-work" && kind != "challenge" {
					return nil, govError()
				}
			}
			def := false
			if !govBool(r, "synthetic", &def) {
				return nil, govError()
			}
		}
	}
	pins, ok := govArray(o, "conformanceSuitePins", 32, false)
	if !ok {
		return nil, govError()
	}
	seen := map[string]bool{}
	for _, value := range pins {
		r, ok := value.(map[string]any)
		if !ok || !strict(r, "name", "version", "sha256", "source", "notBefore", "notAfter", "revoked") || !govText(r, "name", 100) || !govText(r, "version", 80) || !governanceSHA.MatchString(str(r, "sha256")) || !govURL(r["source"]) || !govValidity(r, "notBefore", "notAfter") || !govBool(r, "revoked", nil) {
			return nil, govError()
		}
		key, _ := governanceBytes([]any{r["name"], r["version"]})
		if seen[string(key)] {
			return nil, govError()
		}
		seen[string(key)] = true
	}
	honors, ok := govArray(o, "honorRules", 8, false)
	if !ok {
		return nil, govError()
	}
	for _, value := range honors {
		r, ok := value.(map[string]any)
		if !ok || !strict(r, "sourceProfile", "id", "version", "title", "capabilityId", "communityId", "kind", "members", "relatedPartyGroups", "notBefore", "notAfter", "revoked", "windowFrom", "windowUntil", "minAcceptedCases", "minProofs", "repositories", "rankingEnabled", "privacyReview", "minimumCohort", "minimumCasesPerMember") {
			return nil, govError()
		}
		if v, present := r["sourceProfile"]; present && v != "facts-v2" {
			return nil, govError()
		}
		if !governanceID.MatchString(str(r, "id")) || !governanceVersion.MatchString(str(r, "version")) || !govText(r, "title", 160) || !governanceCapability.MatchString(str(r, "capabilityId")) || !governanceID.MatchString(str(r, "communityId")) || !hasString([]string{"open-contributor", "ci-backed-contributor"}, str(r, "kind")) || !govValidity(r, "notBefore", "notAfter") || !govValidity(r, "windowFrom", "windowUntil") || !govInt(r["minAcceptedCases"], 1, 50) || !govInt(r["minProofs"], 0, 50) || !govRepositories(r["repositories"]) {
			return nil, govError()
		}
		members, ok := govStrings(r["members"], 2, 128, governanceSubject, true)
		if !ok {
			return nil, govError()
		}
		groups, ok := govArray(r, "relatedPartyGroups", 16, false)
		if !ok {
			return nil, govError()
		}
		for _, group := range groups {
			ids, ok := govStrings(group, 2, 16, governanceSubject, true)
			if !ok {
				return nil, govError()
			}
			for _, id := range ids {
				if !hasString(members, id) {
					return nil, govError()
				}
			}
		}
		def := false
		if !govBool(r, "revoked", &def) || !govBool(r, "rankingEnabled", &def) {
			return nil, govError()
		}
		if _, present := r["privacyReview"]; !present {
			r["privacyReview"] = "pending"
		}
		if !hasString([]string{"pending", "approved"}, str(r, "privacyReview")) {
			return nil, govError()
		}
		if _, present := r["minimumCohort"]; !present {
			r["minimumCohort"] = 5
		}
		if _, present := r["minimumCasesPerMember"]; !present {
			r["minimumCasesPerMember"] = 3
		}
		if !govInt(r["minimumCohort"], 5, 128) || !govInt(r["minimumCasesPerMember"], 3, 50) || truth(r, "rankingEnabled") && str(r, "privacyReview") != "approved" {
			return nil, govError()
		}
		repos := r["repositories"].([]any)
		if str(r, "kind") == "ci-backed-contributor" {
			if govNum(r, "minProofs") < 1 || len(repos) == 0 {
				return nil, govError()
			}
		} else if govNum(r, "minProofs") != 0 {
			return nil, govError()
		}
	}
	policies, ok := govArray(o, "qualificationPolicies", 64, false)
	if !ok {
		return nil, govError()
	}
	for _, value := range policies {
		r, ok := value.(map[string]any)
		if !ok || !strict(r, "id", "version", "capabilityId", "title", "collaboration", "notBefore", "notAfter", "minProofs", "minAcceptedCollaborations", "historyWindowSeconds", "requireCiSuccess", "repositories") || !governanceID.MatchString(str(r, "id")) || !governanceVersion.MatchString(str(r, "version")) || !governanceCapability.MatchString(str(r, "capabilityId")) || !govText(r, "title", 160) || !hasString([]string{"open-assistance", "basic-bounty"}, str(r, "collaboration")) || !govValidity(r, "notBefore", "notAfter") || !govInt(r["minProofs"], 0, 16) || !govInt(r["minAcceptedCollaborations"], 0, 16) || !govInt(r["historyWindowSeconds"], 1, 31536000) || !govBool(r, "requireCiSuccess", nil) || !govRepositories(r["repositories"]) {
			return nil, govError()
		}
		if str(r, "collaboration") == "basic-bounty" && govNum(r, "minAcceptedCollaborations") < 1 || govNum(r, "minProofs") > 0 && len(r["repositories"].([]any)) == 0 {
			return nil, govError()
		}
	}
	return o, nil
}
func governanceEndpoint(endpoint string) bool {
	u, e := url.Parse(endpoint)
	if e != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery {
		return false
	}
	if strings.ToLower(u.Host) != u.Host {
		return false
	}
	if port := u.Port(); port != "" {
		n, e := strconv.Atoi(port)
		if e != nil || n > 65535 || n == 443 || strconv.Itoa(n) != port {
			return false
		}
	}
	host := u.Hostname()
	if ip := net.ParseIP(host); ip != nil {
		if ip.String() != host {
			return false
		}
	} else {
		parts := strings.Split(strings.TrimSuffix(host, "."), ".")
		last := parts[len(parts)-1]
		if regexp.MustCompile(`^(?:[0-9]+|0x[0-9a-f]+)$`).MatchString(last) {
			return false
		}
	}
	return "https://"+u.Host == endpoint
}
