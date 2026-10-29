package publicwrites

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestOriginalPolicyLosslessVersionAndStrictLimits(t *testing.T) {
	dir := t.TempDir()
	cases := []string{}
	base := DefaultPolicy()
	raw, _ := json.Marshal(base)
	cases = append(cases, string(raw))
	for _, mutate := range []func(Object){
		func(p Object) { p["version"] = "" }, func(p Object) { p["promotionDays"] = 0 }, func(p Object) { p["invitationCooldownDays"] = 366 }, func(p Object) { p["extra"] = true }, func(p Object) { object(p["new"])["task"] = 0 }, func(p Object) { object(p["new"])["comment"] = 1.5 }, func(p Object) { object(p["normal"])["invitation"] = 9007199254740992.0 },
	} {
		p := DefaultPolicy()
		mutate(p)
		raw, _ := json.Marshal(p)
		cases = append(cases, string(raw))
	}
	cases = append(cases, `{"version":"\ud800","new":{"task":2,"comment":20,"invitation":5},"normal":{"task":10,"comment":100,"invitation":20},"promotionDays":7,"invitationCooldownDays":7}`)
	output, e := os.ReadFile("testdata/policy-original.json")
	if e != nil {
		t.Fatal(e)
	}
	var expected []struct {
		Accepted bool
		Value    Object
	}
	if e = json.Unmarshal(output, &expected); e != nil {
		t.Fatal(e)
	}
	for i, input := range cases {
		path := filepath.Join(dir, "policy.json")
		_ = os.WriteFile(path, []byte(input), 0600)
		actual, e := LoadPolicy(path)
		if (e == nil) != expected[i].Accepted {
			t.Errorf("original policy acceptance differs at %d", i)
		}
		if e == nil {
			raw, _ := json.Marshal(actual)
			var decoded Object
			_ = json.Unmarshal(raw, &decoded)
			left, _ := json.Marshal(decoded)
			right, _ := json.Marshal(expected[i].Value)
			if !bytes.Equal(left, right) {
				t.Errorf("original policy values differ at %d", i)
			}
			if i == len(cases)-1 && !bytes.Contains(raw, []byte(`\ud800`)) {
				t.Fatal("lossless version damaged")
			}
		}
	}
}
