package systemsettings

import (
	"regexp"
	"strconv"
	"time"
)

func safeError(e error, fallback string) string {
	code := errorCode(e)
	if includes(ErrorCodes, code) {
		return code
	}
	return fallback
}
func validDate(v any) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	_, e := time.Parse(time.RFC3339Nano, s)
	return e == nil && regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$`).MatchString(s)
}
func ParseOperation(input Object) (Object, error) {
	if !closed(input, []string{"operationId", "section", "kind", "state", "versionId", "revision", "phases", "startedAt", "finishedAt"}, []string{"credentialRef"}) {
		return nil, invalid()
	}
	x := clone(input)
	if !setUUID(x, "operationId", true) || !includes(sections, str(x["section"])) || !includes([]string{"save", "test", "apply", "credential"}, str(x["kind"])) || !includes([]string{"accepted", "completed", "partial", "failed", "unknown"}, str(x["state"])) || !whole(x["revision"], 0, 2147483646) || !validDate(x["startedAt"]) || x["finishedAt"] != nil && !validDate(x["finishedAt"]) {
		return nil, invalid()
	}
	if x["versionId"] != nil && !setUUID(x, "versionId", true) {
		return nil, invalid()
	}
	if v, ok := x["credentialRef"]; ok && !keyRefPattern.MatchString(str(v)) {
		return nil, invalid()
	}
	raw, ok := x["phases"].([]any)
	if !ok || len(raw) > 20 {
		return nil, invalid()
	}
	phases := []any{}
	for _, v := range raw {
		p := clone(obj(v))
		if !closed(p, []string{"target", "state", "code", "adoptedVersionId"}, []string{"checks"}) || !text(p, "target", 100) || !includes([]string{"pending", "running", "completed", "failed", "unknown"}, str(p["state"])) || p["code"] != nil && !includes(ErrorCodes, str(p["code"])) || p["adoptedVersionId"] != nil && !setUUID(p, "adoptedVersionId", true) {
			return nil, invalid()
		}
		if v, ok := p["checks"]; ok {
			checks, ok := v.([]any)
			if !ok || len(checks) > 12 {
				return nil, invalid()
			}
			for _, v := range checks {
				c := obj(v)
				if !closed(c, []string{"kind", "state"}, nil) || !includes([]string{"transport", "authentication", "index", "reader-authentication", "writer-authentication", "scanner-signatures", "runtime", "execution-signature"}, str(c["kind"])) || !includes([]string{"passed", "failed", "not-tested"}, str(c["state"])) {
					return nil, invalid()
				}
			}
		}
		phases = append(phases, p)
	}
	x["phases"] = phases
	return x, nil
}
func VersionView(row Object) any {
	if row == nil {
		return nil
	}
	return Object{"id": row["id"], "revision": row["revision"], "configuration": row["configuration"], "createdAt": iso(row["created_at"])}
}
func OperationView(row Object) (any, error) {
	if row == nil {
		return nil, nil
	}
	result := obj(row["result"])
	phases := result["phases"]
	if phases == nil {
		phases = []any{}
	}
	var finished any
	if includes([]string{"completed", "partial", "failed"}, str(row["state"])) {
		finished = iso(row["updated_at"])
	}
	out := Object{"operationId": row["operation_id"], "section": row["section"], "kind": row["kind"], "state": row["state"], "versionId": row["version_id"], "revision": row["revision"], "phases": phases, "startedAt": iso(row["created_at"]), "finishedAt": finished}
	if str(result["credentialRef"]) != "" {
		out["credentialRef"] = result["credentialRef"]
	}
	return ParseOperation(out)
}
func EmptyConfiguration(section string) Object {
	if section == "mail" {
		return Object{"connections": []any{}, "bindings": Object{"operations": nil, "account-authentication": nil, "runtime-alerts": nil}}
	}
	return Object{"connections": []any{}}
}
func unavailableOverview(configured bool) Object {
	state := "not-configured"
	if configured {
		state = "unavailable"
	}
	return Object{"availability": Object{"state": state}, "current": []any{}, "credentials": []any{}, "observedConfiguration": nil, "capabilities": Object{"canTest": false, "canApply": false, "canWriteCredential": false}}
}
func ParseOverview(input Object) (Object, error) {
	if !closed(input, []string{"availability", "current", "credentials", "observedConfiguration", "capabilities"}, nil) || !closed(obj(input["availability"]), []string{"state"}, nil) || !includes([]string{"available", "unavailable", "not-configured"}, str(obj(input["availability"])["state"])) || !closed(obj(input["capabilities"]), []string{"canTest", "canApply", "canWriteCredential"}, nil) {
		return nil, invalid()
	}
	for _, k := range []string{"canTest", "canApply", "canWriteCredential"} {
		if _, ok := obj(input["capabilities"])[k].(bool); !ok {
			return nil, invalid()
		}
	}
	current, cok := input["current"].([]any)
	credentials, kok := input["credentials"].([]any)
	if !cok || !kok || len(current) > 20 || len(credentials) > 100 {
		return nil, invalid()
	}
	for _, v := range current {
		r := obj(v)
		if !closed(r, []string{"target", "state", "adoptedVersionId", "connectionId", "source", "configured"}, nil) || !regexp.MustCompile(`^[a-z][a-z0-9-]{0,79}$`).MatchString(str(r["target"])) || !includes([]string{"configured", "not-configured", "unavailable", "unknown"}, str(r["state"])) || !includes([]string{"operations-database", "native-keycloak", "native-alertmanager", "protected-runtime", "consumer-ack", "not-connected"}, str(r["source"])) {
			return nil, invalid()
		}
		for _, k := range []string{"adoptedVersionId", "connectionId"} {
			if r[k] != nil {
				if _, ok := parseUUID(r[k], false); !ok {
					return nil, invalid()
				}
			}
		}
		if r["configured"] != nil {
			if _, ok := r["configured"].(bool); !ok {
				return nil, invalid()
			}
		}
	}
	for _, v := range credentials {
		r := obj(v)
		if !closed(r, []string{"reference", "connectionId", "configured"}, nil) || !keyRefPattern.MatchString(str(r["reference"])) {
			return nil, invalid()
		}
		if _, ok := parseUUID(r["connectionId"], false); !ok {
			return nil, invalid()
		}
		if _, ok := r["configured"].(bool); !ok {
			return nil, invalid()
		}
	}
	return clone(input), nil
}
func ParseHistory(input Object) (Object, error) {
	if !closed(input, nil, []string{"after", "limit"}) {
		return nil, invalid()
	}
	x := clone(input)
	if _, ok := x["limit"]; !ok {
		x["limit"] = 20
	}
	if !whole(x["limit"], 1, 50) {
		return nil, invalid()
	}
	if v, ok := x["after"]; ok {
		if !regexp.MustCompile(`^[1-9][0-9]{0,18}$`).MatchString(str(v)) {
			return nil, invalid()
		}
		if _, e := strconv.ParseInt(str(v), 10, 64); e != nil {
			return nil, invalid()
		}
	}
	return x, nil
}
