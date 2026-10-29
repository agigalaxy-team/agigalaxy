package community

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestGovernanceOriginalAstralSchemaAndHash(t *testing.T) {
	raw, e := os.ReadFile("testdata/governance-astral-fixture.json")
	if e != nil {
		t.Fatal(e)
	}
	value, e := governanceJSON(raw)
	if e != nil {
		t.Fatal(e)
	}
	for _, item := range value.([]any) {
		v := item.(map[string]any)
		parsed, e := parseGovernanceConfiguration(obj(v, "configuration"))
		if (e == nil) != truth(v, "accepted") {
			t.Fatalf("original astral decision: %v", e)
		}
		if e == nil {
			equal(t, parsed, v["normalized"])
			hash, e := GovernanceConfigurationHash(parsed)
			if e != nil || hash != str(v, "hash") {
				t.Fatal("astral hash", e)
			}
		}
	}
	// This helper is shared by Zod policy and pin strings; its raw codec must
	// continue preserving an unpaired surrogate rather than replacing it.
	var rawString json.RawMessage = []byte(`"🚀\ud800"`)
	v, e := governanceJSON(rawString)
	if e != nil || govStringLength(v) != 2 {
		t.Fatal("code point length", e)
	}
	b, e := governanceBytes(v)
	if e != nil || string(b) != string(rawString) {
		t.Fatal("surrogate bytes changed", e)
	}
}

func TestReviewedGovernanceMatchesOriginalConfigurationAndSignatures(t *testing.T) {
	raw, e := os.ReadFile("testdata/governance-fixture.json")
	if e != nil {
		t.Fatal(e)
	}
	value, e := governanceJSON(raw)
	if e != nil {
		t.Fatal(e)
	}
	f := value.(map[string]any)
	config := obj(f, "configuration")
	endpoint := str(f, "endpoint")
	now := govNum(f, "now")
	hash, e := GovernanceConfigurationHash(config)
	if e != nil || hash != str(f, "configurationHash") {
		t.Fatalf("original normalized hash mismatch: %s %v", hash, e)
	}
	parsed, e := parseGovernanceConfiguration(obj(f, "configuration"))
	if e != nil {
		t.Fatal(e)
	}
	equal(t, parsed, f["normalized"])
	review, e := VerifyGovernanceReview(config, f["envelope"], f["authorities"], endpoint, now)
	if e != nil {
		t.Fatal(e)
	}
	equal(t, review, f["review"])
	variants := f["variants"].([]any)
	for _, value := range variants {
		v := value.(map[string]any)
		t.Run(str(v, "name"), func(t *testing.T) {
			_, e := VerifyGovernanceReview(obj(v, "configuration"), v["envelope"], v["authorities"], str(v, "endpoint"), govNum(v, "now"))
			if (e == nil) != truth(v, "accepted") {
				t.Fatalf("original decision differed: Go err=%v JS accepted=%v", e, v["accepted"])
			}
		})
	}
	empty, e := GovernanceConfigurationHash(Object{})
	if e != nil || empty != str(f, "emptyHash") {
		t.Fatal(empty, e)
	}
	explicit, e := GovernanceConfigurationHash(Object{"experienceReviewers": []any{}})
	if e != nil || explicit != str(f, "explicitExperienceHash") || empty == explicit {
		t.Fatal("optional experienceReviewers changed legacy digest", e)
	}
	dir := t.TempDir()
	configurationPath := filepath.Join(dir, "governance.json")
	reviewPath := filepath.Join(dir, "review.json")
	authoritiesPath := filepath.Join(dir, "authorities.json")
	for path, value := range map[string]any{configurationPath: config, reviewPath: f["envelope"], authoritiesPath: f["authorities"]} {
		if e = os.WriteFile(path, encode(value), 0600); e != nil {
			t.Fatal(e)
		}
	}
	options := GovernanceOptions{ConfigurationPath: configurationPath, ReviewPath: reviewPath, AuthoritiesPath: authoritiesPath, Environment: "pilot", Endpoint: endpoint, Now: func() time.Time { return time.Unix(now, 0) }}
	loaded, e := LoadGovernanceForRuntime(options)
	if e != nil {
		t.Fatal(e)
	}
	equal(t, loaded.Configuration, f["normalized"])
	equal(t, loaded.Review, f["review"])
	partial := options
	partial.AuthoritiesPath = ""
	if _, e = LoadGovernanceForRuntime(partial); e == nil {
		t.Fatal("partial authority pins accepted")
	}
	partial = options
	partial.ConfigurationPath = ""
	if _, e = LoadGovernanceForRuntime(partial); e == nil {
		t.Fatal("review without configuration accepted")
	}
	partial = options
	partial.ReviewPath = ""
	partial.AuthoritiesPath = ""
	if _, e = LoadGovernanceForRuntime(partial); e == nil {
		t.Fatal("pilot governance role change without review accepted")
	}
	partial.Environment = "development"
	if _, e = LoadGovernanceForRuntime(partial); e != nil {
		t.Fatal("original unreviewed development configuration rejected", e)
	}
	emptyPilot, e := LoadGovernanceForRuntime(GovernanceOptions{Environment: "pilot"})
	if e != nil || emptyPilot.Review != nil {
		t.Fatal("empty original pilot configuration", e)
	}
	if _, present := emptyPilot.Configuration["experienceReviewers"]; present {
		t.Fatal("absent optional config field was introduced")
	}
	changed := clone(config)
	changed["moderatorIds"] = []any{}
	if e = os.WriteFile(configurationPath, encode(changed), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = LoadGovernanceForRuntime(options); e == nil {
		t.Fatal("review for old config authorized current changed config")
	}
}
