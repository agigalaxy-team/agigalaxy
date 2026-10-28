package community

import (
	"os"
	"path/filepath"
	"testing"
)

func TestForumPolicyOriginalFileContract(t *testing.T) {
	path := filepath.Join(t.TempDir(), "forum-policy.json")
	if e := os.WriteFile(path, encode(defaultPolicy()), 0600); e != nil {
		t.Fatal(e)
	}
	policy, e := LoadForumPolicy(path)
	if e != nil {
		t.Fatal(e)
	}
	hash, e := ForumPolicyHash(policy)
	if e != nil || hash != (&Service{}).policyHash() {
		t.Fatal("original policy hash", hash, e)
	}
	policy["maxLinks"] = -1
	if e = os.WriteFile(path, encode(policy), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = LoadForumPolicy(path); e == nil {
		t.Fatal("invalid policy accepted")
	}
	if _, e = LoadForumPolicy("relative.json"); e == nil {
		t.Fatal("relative path accepted")
	}
}
func TestCommunityPolicyKeepsOriginalLimitsPromotionAndHash(t *testing.T) {
	f := object(t, node(t, "postgres://127.0.0.1/galaxy_go_test_policy", "community-policy-fixture"))
	defaults, e := LoadCommunityPolicy("")
	if e != nil {
		t.Fatal(e)
	}
	equal(t, defaults, f["defaults"])
	hash, e := CommunityPolicyHash(defaults)
	if e != nil || hash != str(f, "defaultHash") {
		t.Fatal(hash, e)
	}
	path := filepath.Join(t.TempDir(), "community-policy.json")
	if e = os.WriteFile(path, encode(f["custom"]), 0600); e != nil {
		t.Fatal(e)
	}
	custom, e := LoadCommunityPolicy(path)
	if e != nil {
		t.Fatal(e)
	}
	equal(t, custom, f["normalized"])
	days, e := CommunityPromotionDays(custom)
	if e != nil || days != 23 {
		t.Fatal(days, e)
	}
	hash, e = CommunityPolicyHash(custom)
	if e != nil || hash != str(f, "customHash") {
		t.Fatal(hash, e)
	}
	obj(custom, "new")["task"] = 0
	if e = os.WriteFile(path, encode(custom), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = LoadCommunityPolicy(path); e == nil {
		t.Fatal("invalid original quota limit accepted")
	}
}
