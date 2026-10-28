package systemsettings_test

import (
	"encoding/json"
	s "github.com/agigalaxy-team/agigalaxy/go/internal/systemsettings"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type object = map[string]any

func obj(v any) object    { o, _ := v.(map[string]any); return o }
func str(v any) string    { v0, _ := v.(string); return v0 }
func encode(v any) string { b, _ := json.Marshal(v); return string(b) }
func copyObject(v object) object {
	o := object{}
	for k, x := range v {
		o[k] = x
	}
	return o
}
func TestSystemSettingsOriginalSchemaConfigurationsAndMetadata(t *testing.T) {
	id := "ABCDEFAB-1111-4111-8111-111111111111"
	lower := strings.ToLower(id)
	op := "11111111-1111-4111-8111-111111111111"
	ref := "system-key:" + op
	connection := object{"id": id, "name": " 原连接😀 ", "host": "\ufeffSMTP.EXAMPLE.INVALID\ufeff", "port": 465, "tls": "implicit", "credentialRef": ref, "connectionTimeoutMs": nil, "greetingTimeoutMs": nil, "socketTimeoutMs": nil, "maxConnections": nil, "rateLimit": nil, "rateWindowSeconds": nil, "dkimSelector": nil}
	mail := object{"connections": []any{connection}, "bindings": object{"operations": lower, "account-authentication": nil, "runtime-alerts": nil}}
	configs := []object{{"section": "mail", "configuration": mail}, {"section": "mail", "configuration": s.EmptyConfiguration("mail")}, {"section": "service-connections", "configuration": s.EmptyConfiguration("service-connections")}}
	for _, address := range []string{"https://服务.example/", "https://EXAMPLE.invalid:443/", "https://example.invalid?", "https://example.invalid#", "https://@example.invalid/", "http://localhost:8080/", "http://[::1]:80/", "http://external.example.invalid/", "https://example.invalid/a"} {
		configs = append(configs, object{"section": "service-connections", "configuration": object{"connections": []any{object{"id": id, "kind": "search", "url": address, "index": "original-index", "credentialRef": nil}}}})
	}
	credentials := []object{}
	for _, entry := range []object{{"section": "mail", "binding": object{"id": id, "host": " SMTP.EXAMPLE.INVALID ", "port": 465, "tls": "implicit"}, "credential": object{"user": "隔离用户", "password": strings.Repeat("😀", 4096)}}, {"section": "service-connections", "binding": object{"id": lower, "kind": "ai-execution", "url": "https://EXAMPLE.invalid:443/"}, "credential": object{"signingKey": strings.Repeat("😀", 32), "serviceKey": strings.Repeat("x", 32)}}, {"section": "service-connections", "binding": object{"id": lower, "kind": "file-scanning", "host": "localhost", "port": 3310, "timeoutMs": 1000}, "credential": object{}}} {
		entry = copyObject(entry)
		entry["operationId"], entry["expectedRevision"], entry["connectionId"] = op, 0, id
		credentials = append(credentials, entry)
	}
	native, authorization := []object{}, []object{}
	for _, v := range credentials {
		x := copyObject(v)
		x["kind"], x["operatorId"] = "settings-credential-provision", strings.Repeat("a", 64)
		native = append(native, x)
		x = copyObject(x)
		delete(x, "credential")
		authorization = append(authorization, x)
	}
	native = append(native, object{"kind": "settings-overview", "section": "mail"}, object{"kind": "settings-apply", "operationId": id, "operatorId": strings.Repeat("a", 64), "section": "mail", "revision": 1, "versionId": id, "configuration": mail})
	authorization = append(authorization, native[len(native)-1])
	general := []object{{"siteTitle": strings.Repeat("😀", 120), "description": "原说明\n允许换行", "footerLinks": []any{object{"label": " 原链接 ", "href": "https://服务.example/a?q=1#片段"}}}, {"siteTitle": strings.Repeat("😀", 121), "description": "", "footerLinks": []any{}}, {"siteTitle": "原网站", "description": "坏\u0001字段", "footerLinks": []any{}}}
	inputs := object{"configurations": configs, "save": []object{{"operationId": id, "expectedRevision": 0, "configuration": nil}}, "apply": []object{{"operationId": id, "expectedRevision": 1, "versionId": id}}, "test": []object{{"operationId": id, "expectedRevision": 1, "versionId": id, "connectionId": id}}, "credential": credentials, "native": native, "authorization": authorization, "history": []object{{}, {"after": "9223372036854775807", "limit": 50}, {"after": "9223372036854775808"}}, "general": general, "publish": []object{{"operationId": id, "expectedPublicationId": id, "versionId": id, "settingsRevision": 0, "settings": general[0]}}}
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", filepath.Join(root, "scripts/go/system-settings-interop.mjs"), "schema")
	cmd.Dir = root
	cmd.Stdin = strings.NewReader(encode(inputs))
	raw, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original schema %v %s", e, raw)
	}
	var expected object
	if json.Unmarshal(raw, &expected) != nil {
		t.Fatal("invalid source schema")
	}
	actual := object{}
	for _, key := range []string{"save", "test", "apply", "credential", "history", "native", "authorization", "general", "publish", "operation", "overview"} {
		out := []any{}
		if values, ok := inputs[key].([]object); ok {
			for _, v := range values {
				var parsed object
				var e error
				switch key {
				case "save", "test", "apply", "credential":
					parsed, e = s.ParseCommand(key, v)
				case "history":
					parsed, e = s.ParseHistory(v)
				case "native", "authorization":
					parsed, e = s.ParseNativeCommand(v, key == "authorization")
				case "general":
					parsed, e = s.ParseGeneralConfiguration(v)
				case "publish":
					parsed, e = s.ParseGeneralPublish(v)
				}
				if e != nil {
					out = append(out, nil)
				} else {
					out = append(out, parsed)
				}
			}
		}
		actual[key] = out
	}
	out := []any{}
	for _, v := range configs {
		p, e := s.ParseConfiguration(str(v["section"]), obj(v["configuration"]))
		if e != nil {
			out = append(out, nil)
		} else {
			out = append(out, p)
		}
	}
	actual["configurations"] = out
	var normalized any
	json.Unmarshal([]byte(encode(actual)), &normalized)
	if !reflect.DeepEqual(normalized, expected) {
		t.Fatalf("system settings source schema differs\nGo%s\nJS%s", encode(actual), encode(expected))
	}
}
