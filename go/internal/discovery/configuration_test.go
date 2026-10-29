package discovery

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestProtectedConfigurationAndSharedSourceExcerpt(t *testing.T) {
	endpoint := "https://discovery.example.invalid"
	key := strings.Repeat("synthetic-", 5)
	base := Object{"version": 1, "endpoint": endpoint, "websiteOrigin": "https://website.example.invalid", "visitorSecret": key, "meilisearch": Object{"url": "https://MEILI.example.invalid:443/", "apiKey": key}, "gorse": Object{"url": "http://127.0.0.1:7700/?", "apiKey": key}, "openpanel": Object{"url": "https://panel.example.invalid/", "clientId": "00000000-0000-4000-8000-000000000001", "readClientId": "00000000-0000-4000-8000-000000000002", "projectId": "00000000-0000-4000-8000-000000000003", "clientSecret": key, "readClientSecret": key}, "sourceMetadata": Object{"moderatorIds": []string{}, "identityProviders": []Object{{"issuer": "https://accounts.example.invalid", "clientId": "reader"}}}}
	values := []Object{base}
	for _, field := range []string{"extra", "websiteOrigin", "endpoint", "sourceMetadata", "meilisearch", "gorse", "version", "visitorSecret"} {
		var c Object
		_ = decode([]byte(jsonString(base)), &c)
		switch field {
		case "extra":
			c[field] = true
		case "websiteOrigin":
			c[field] = "https://WEBSITE.example.invalid"
		case "endpoint":
			c[field] = "https://other.example.invalid"
		case "sourceMetadata":
			c[field] = nil
		case "meilisearch":
			object(c[field])["index"] = nil
		case "gorse":
			object(c[field])["url"] = "http://public.example.invalid"
		case "version":
			c[field] = 2
		case "visitorSecret":
			c[field] = "too-short"
		}
		values = append(values, c)
	}
	type result struct {
		Accepted bool
		Value    any
	}
	results := []result{}
	for i, value := range values {
		path := filepath.Join(t.TempDir(), "discovery.json")
		if e := os.WriteFile(path, []byte(jsonString(value)), 0600); e != nil {
			t.Fatal(e)
		}
		config, e := LoadConfiguration(path, endpoint)
		var projected any
		if config != nil {
			_ = json.Unmarshal([]byte(jsonString(config)), &projected)
		}
		results = append(results, result{Accepted: e == nil, Value: projected})
		_ = i
	}
	var original []result
	loadWireFixture(t, "configuration", &original)
	if !reflect.DeepEqual(results, original) {
		for i := range results {
			if !reflect.DeepEqual(results[i], original[i]) {
				t.Errorf("protected configuration case %d accepted %v expected %v", i, results[i].Accepted, original[i].Accepted)
			}
		}
	}
	bodies := []string{"前段\n\n后段", "前段\n```go\nfmt.Println(1)\n```\n后段", "```\n未关闭", "😀\u00a0<&>\ufeff正文\r\n  结束", "```c++\r\nint x;\r\n```\r\n末段"}
	raw, _ := json.Marshal(bodies)
	script := `import{forumBodyExcerpt}from './packages/galaxy-contracts/src/community-forum-body-text.mjs';console.log(JSON.stringify(JSON.parse(process.argv[1]).map(forumBodyExcerpt)))`
	root, _ := filepath.Abs("../../..")
	cmd := exec.Command("node", "--input-type=module", "-e", script, string(raw))
	cmd.Dir = root
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatal(e)
	}
	var excerpts []string
	if e = json.Unmarshal(out, &excerpts); e != nil {
		t.Fatal(e)
	}
	for i, body := range bodies {
		if got := bodyExcerpt(body); got != excerpts[i] {
			t.Errorf("excerpt %d Go %q JS %q", i, got, excerpts[i])
		}
	}
}
