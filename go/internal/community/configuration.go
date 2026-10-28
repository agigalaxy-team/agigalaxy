package community

import (
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"os"
	"path/filepath"
)

// LoadForumPolicy consumes the original GALAXY_FORUM_POLICY_FILE contract.
// Governance role/review files remain separately verified configuration.
func LoadForumPolicy(path string) (Object, error) {
	if path == "" {
		return defaultPolicy(), nil
	}
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("absolute forum policy path required")
	}
	info, e := os.Lstat(path)
	if e != nil {
		return nil, e
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 8192 {
		return nil, fmt.Errorf("invalid forum policy file")
	}
	raw, e := os.ReadFile(path)
	if e != nil {
		return nil, e
	}
	var policy Object
	if protocol.Decode(raw, &policy) != nil {
		return nil, fmt.Errorf("invalid forum policy")
	}
	return parseForumPolicy(policy)
}
func parseForumPolicy(policy Object) (Object, error) {
	base := defaultPolicy()
	if len(policy) != len(base) || str(policy, "version") != "forum-quota/1" {
		return nil, fmt.Errorf("invalid forum policy")
	}
	for key := range policy {
		if _, ok := base[key]; !ok {
			return nil, fmt.Errorf("invalid forum policy")
		}
	}
	for _, key := range []string{"new", "normal"} {
		limits := obj(policy, key)
		if limits == nil || len(limits) != 4 || !strict(limits, "post", "version", "reply", "report") {
			return nil, fmt.Errorf("invalid forum policy")
		}
		for _, category := range []string{"post", "version", "reply", "report"} {
			if !integer(limits[category], 1, 100000) {
				return nil, fmt.Errorf("invalid forum policy")
			}
		}
	}
	bounds := map[string][2]int64{"maxPermissionSeconds": {60, 2592000}, "maxGovernanceHideSeconds": {60, 86400}, "accountForumMaxBytes": {65536, 8388608}, "maxTitleCodePoints": {1, 160}, "maxBodyCodePoints": {1, 8000}, "maxReplyCodePoints": {1, 2000}, "maxReportCodePoints": {1, 1600}, "maxLinks": {0, 8}, "maxLinkCodePoints": {1, 2048}, "maxPayloadBytes": {4096, 49152}, "maxAppeals": {1, 3}, "maxReportEvents": {4, 100}, "dailyUsageDays": {1, 30}, "auditDays": {1, 180}}
	for key, bound := range bounds {
		if !integer(policy[key], bound[0], bound[1]) {
			return nil, fmt.Errorf("invalid forum policy")
		}
	}
	return policy, nil
}

// ParseForumPolicy shares the existing loader normalization with the formal
// product-policy consumer; it does not change file loading or policy meaning.
func ParseForumPolicy(policy Object) (Object, error) { return parseForumPolicy(policy) }
func ForumPolicyHash(policy Object) (string, error) {
	var normalized Object
	if protocol.Decode(encode(policy), &normalized) != nil {
		return "", fmt.Errorf("invalid forum policy")
	}
	p, e := parseForumPolicy(normalized)
	if e != nil {
		return "", e
	}
	return (&Service{Policy: p}).policyHash(), nil
}
