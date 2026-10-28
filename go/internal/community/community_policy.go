package community

import (
	"bytes"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"os"
	"path/filepath"
)

// LoadCommunityPolicy preserves the original GALAXY_COMMUNITY_QUOTA_FILE,
// including all Task/comment/invitation limits and the forum tier transition.
func LoadCommunityPolicy(path string) (Object, error) {
	var raw any = Object{"version": "community-quota/1", "new": Object{"task": 2, "comment": 20, "invitation": 5}, "normal": Object{"task": 10, "comment": 100, "invitation": 20}, "promotionDays": 7, "invitationCooldownDays": 7}
	if path != "" {
		if !filepath.IsAbs(path) {
			return nil, fmt.Errorf("absolute community policy path required")
		}
		info, e := os.Lstat(path)
		if e != nil {
			return nil, e
		}
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 8192 {
			return nil, fmt.Errorf("invalid community policy file")
		}
		data, e := os.ReadFile(path)
		if e != nil {
			return nil, e
		}
		raw, e = governanceJSON(data)
		if e != nil {
			return nil, e
		}
	}
	return parseCommunityPolicy(raw)
}
func parseCommunityPolicy(raw any) (Object, error) {
	p, ok := raw.(map[string]any)
	if !ok || !strict(p, "version", "new", "normal", "promotionDays", "invitationCooldownDays") || len(p) != 5 {
		return nil, fmt.Errorf("invalid community policy")
	}
	versionLength := govStringLength(p["version"])
	if versionLength < 1 || versionLength > 80 || !govInt(p["promotionDays"], 1, 365) || !govInt(p["invitationCooldownDays"], 1, 365) {
		return nil, fmt.Errorf("invalid community policy")
	}
	for _, tier := range []string{"new", "normal"} {
		limits := obj(p, tier)
		if limits == nil || !strict(limits, "task", "comment", "invitation") || len(limits) != 3 {
			return nil, fmt.Errorf("invalid community policy")
		}
		for _, kind := range []string{"task", "comment", "invitation"} {
			if !govInt(limits[kind], 1, safeInteger) {
				return nil, fmt.Errorf("invalid community policy")
			}
		}
	}
	return p, nil
}
func CommunityPolicyHash(policy Object) (string, error) {
	raw, e := protocol.Encode(policy)
	if e != nil {
		return "", e
	}
	value, e := governanceJSON(raw)
	if e != nil {
		return "", e
	}
	p, e := parseCommunityPolicy(value)
	if e != nil {
		return "", e
	}
	var out bytes.Buffer
	out.WriteByte('{')
	for i, key := range []string{"version", "new", "normal", "promotionDays", "invitationCooldownDays"} {
		if i > 0 {
			out.WriteByte(',')
		}
		encodedKey, _ := governanceBytes(key)
		out.Write(encodedKey)
		out.WriteByte(':')
		if key == "new" || key == "normal" {
			out.WriteByte('{')
			for j, kind := range []string{"task", "comment", "invitation"} {
				if j > 0 {
					out.WriteByte(',')
				}
				encoded, _ := governanceBytes(kind)
				out.Write(encoded)
				out.WriteByte(':')
				encoded, e := governanceBytes(obj(p, key)[kind])
				if e != nil {
					return "", e
				}
				out.Write(encoded)
			}
			out.WriteByte('}')
		} else {
			encoded, e := governanceBytes(p[key])
			if e != nil {
				return "", e
			}
			out.Write(encoded)
		}
	}
	out.WriteByte('}')
	return identity.Digest(out.Bytes()), nil
}
func CommunityPromotionDays(policy Object) (int, error) {
	if !govInt(policy["promotionDays"], 1, 365) {
		return 0, fmt.Errorf("invalid community policy")
	}
	return int(govNum(policy, "promotionDays")), nil
}
