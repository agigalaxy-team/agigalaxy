package operationsqueries

import (
	"encoding/json"
	"github.com/google/uuid"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestSystemSettingsProjectionMatchesOriginalClosedViews(t *testing.T) {
	id, version := uuid.NewString(), uuid.NewString()
	common := Object{"revision": 3, "version": Object{"id": version, "revision": 3, "createdAt": "2033-05-18T11:33:20+08:00"}, "configurationBasis": "saved-version", "availability": Object{"state": "available"}, "current": []any{Object{"target": "worker", "state": "configured", "adoptedVersionId": version, "connectionId": id, "source": "protected-runtime", "configured": true, "credential": "private-credential-material"}}, "credentials": []any{Object{"connectionId": id, "configured": true, "reference": "private-credential-material"}}, "pending": Object{"kind": "apply", "state": "accepted", "versionId": version, "revision": 3}}
	mail := merge(common, Object{"configuration": Object{"connections": []any{Object{"id": id, "name": "Current mail", "host": "smtp.example.invalid", "port": 465, "tls": "implicit", "credentialRef": "private-credential-material"}}, "bindings": Object{"operations": id}}})
	connections := merge(common, Object{"configuration": Object{"connections": []any{Object{"id": id, "kind": "search", "url": "https://search.example.invalid:443/", "index": "current", "credentialRef": "private-credential-material"}, Object{"id": uuid.NewString(), "kind": "analysis", "url": "https://user:private-credential-material@analysis.example.invalid/"}, Object{"id": uuid.NewString(), "kind": "file-scanning", "host": "::1", "port": 3310, "timeoutMs": 5000}}}})
	advanced := Object{"revision": 3, "versionId": version, "connections": []any{Object{"id": id, "name": "Current mail", "connectionTimeoutMs": 1000, "greetingTimeoutMs": 2000, "socketTimeoutMs": 3000, "maxConnections": 2, "rateLimit": 3, "rateWindowSeconds": 30, "dkimSelector": "galaxy", "password": "private-credential-material"}}, "source": "mail-configuration", "limitsScope": "per-worker-process", "current": common["current"]}
	general := Object{"publication": Object{"id": version, "state": "available"}, "configuration": Object{"siteTitle": "Published title", "description": "Published description", "footerLinks": []any{Object{"label": "Current help", "href": "https://docs.example.invalid/"}}, "savedDraft": "private-credential-material"}}
	cases := []Object{{"kind": "mail", "value": mail}, {"kind": "connections", "value": connections}, {"kind": "advanced", "value": advanced}, {"kind": "general", "value": general}, {"kind": "general", "value": Object{"publication": Object{"id": nil, "state": "unavailable"}, "configuration": Object{"siteTitle": "private-credential-material"}}}}
	code := `import {systemMailQuery,systemConnectionsQuery,systemAdvancedQuery,systemGeneralQuery} from './packages/galaxy-official/src/operations/agentos/query-extensions-view.mjs';let s='';for await(const b of process.stdin)s+=b;const f={mail:systemMailQuery,connections:systemConnectionsQuery,advanced:systemAdvancedQuery,general:systemGeneralQuery};console.log(JSON.stringify(JSON.parse(s).map(x=>f[x.kind](x.value))));`
	root, _ := filepath.Abs("../../..")
	cmd := exec.Command("node", "--input-type=module", "-e", code)
	cmd.Dir = root
	cmd.Stdin = strings.NewReader(encoded(cases))
	raw, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original projections %v %s", e, raw)
	}
	var expected []Object
	if json.Unmarshal(raw, &expected) != nil {
		t.Fatal("invalid original projections")
	}
	functions := map[string]func(Object) (Object, error){"mail": systemMail, "connections": systemConnections, "advanced": systemAdvanced, "general": systemGeneral}
	for i, input := range cases {
		result, e := functions[str(input["kind"])](object(input["value"]))
		if e != nil {
			t.Fatal(e)
		}
		var normalized Object
		json.Unmarshal([]byte(encoded(result)), &normalized)
		if !reflect.DeepEqual(normalized, expected[i]) {
			t.Fatalf("view%d differs Go%s JS%s", i, encoded(normalized), encoded(expected[i]))
		}
		if strings.Contains(encoded(result), "private-credential-material") {
			t.Fatal("credential/source outside closed view escaped")
		}
	}
}
