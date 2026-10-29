package servicemetadata

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestOriginalNetworkProfileConfigurationParity(t *testing.T) {
	dir := t.TempDir()
	type entry struct {
		Profile  map[string]any `json:"profile"`
		Endpoint string         `json:"endpoint"`
	}
	entries := []entry{}
	for _, value := range []string{"https://hub.example.invalid/charter", "https://localhost/charter", "https://127.0.0.1/charter", "https://2130706433/charter", "https://127.1/charter", "https://0x7f000001/charter", "https://0177.0.0.1/charter", "https://134744072/charter", "https://10.0.0.1/charter", "https://192.175.48.1/charter", "https://192.52.193.1/charter", "https://8.8.8.8/charter", "https://[::ffff:8.8.8.8]/charter", "https://[64:ff9b::808:808]/charter", "https://[2001:4860:4860::8888]/charter", "https://[2001:db8::1]/charter", "https://[3fff::1]/charter", "https://hub.example.invalid:8443/charter", "https://hub.example.invalid/charter?x=1", "https://hub.example.invalid/charter#part", "http://hub.example.invalid/charter"} {
		entries = append(entries, entry{map[string]any{"networkType": "hub", "displayName": "Hub", "serviceVersion": "1.2.3-beta.1", "hub": map[string]any{"profile": "galaxy-hub/1", "charter": value, "scope": "shared work", "exit": "leave", "export": "take data"}}, "https://device.example.invalid"})
	}
	for _, raw := range []string{`{"networkType":"official"}`, `{"networkType":"official","displayName":null}`, `{"networkType":"official","serviceVersion":"1.0.0"}`, `{"networkType":"official","operator":"override"}`, `{"networkType":"hub","displayName":"Hub","serviceVersion":"1.2.3","hub":null}`, `{"networkType":"official","displayName":""}`} {
		var p map[string]any
		_ = json.Unmarshal([]byte(raw), &p)
		entries = append(entries, entry{p, "https://device.example.invalid"})
	}
	for _, endpoint := range []string{"https://DEVICE.EXAMPLE.INVALID", "https://device.example.invalid:443", "https://device.example.invalid/", "https://127.1", "https://[2001:4860:0:0:0:0:0:8888]", "https://[2001:4860::8888]"} {
		entries = append(entries, entry{map[string]any{"networkType": "official"}, endpoint})
	}
	// Captured from the original validator before retiring its service dependency.
	expected := []bool{true, false, false, false, false, false, false, true, false, false, false, true, false, false, true, false, false, false, false, false, false, true, false, false, false, false, false, false, false, false, false, false, true}
	actual := []bool{}
	for _, entry := range entries {
		raw, _ := json.Marshal(entry.Profile)
		profile := filepath.Join(dir, "profile.json")
		_ = os.WriteFile(profile, raw, 0600)
		_, e := New(Configuration{Endpoint: entry.Endpoint, SigningKeyID: "fixture", Operator: "Operator", Region: "test", NetworkProfileFile: profile, Keyring: json.RawMessage(`{"signed":"fixture"}`), SignManifest: func(context.Context, any, int64) (string, error) { return "", nil }, AssertManifestAvailable: func(int64) error { return nil }, KeyStatuses: func() []KeyStatus { return nil }})
		actual = append(actual, e == nil)
	}
	if !reflect.DeepEqual(actual, expected) {
		for i := range actual {
			if actual[i] != expected[i] {
				t.Errorf("case %d original=%v Go=%v: %+v", i, expected[i], actual[i], entries[i])
			}
		}
	}
}
