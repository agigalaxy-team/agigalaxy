package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/capsules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"sort"
	"sync"
	"time"
)

type capsuleWorkFlight struct {
	done   chan struct{}
	result any
	err    error
}
type NativeCapsuleWork struct {
	runtime *Runtime
	mu      sync.Mutex
	closed  bool
	flights map[string]*capsuleWorkFlight
}

func NewNativeCapsuleWork(r *Runtime) *NativeCapsuleWork {
	return &NativeCapsuleWork{runtime: r, flights: map[string]*capsuleWorkFlight{}}
}
func (h *NativeCapsuleWork) Close() { h.mu.Lock(); h.closed = true; h.mu.Unlock() }
func workPurposeContracts() map[string]any {
	var out map[string]any
	_ = protocol.Decode([]byte(workPurposeContractsJSON), &out)
	return out
}
func workPurposeNormalize(name string, input any) (map[string]any, error) {
	contract := uploadObject(workPurposeContracts()[name])
	if contract == nil {
		return nil, remoteFactsInvalid()
	}
	raw, e := protocol.Encode(input)
	if e != nil {
		return nil, e
	}
	v, e := connectionObject(raw)
	if e != nil {
		return nil, e
	}
	schema := uploadObject(contract["schema"])
	if name == "galaxy_capsule_work_prepare" {
		for _, k := range []string{"note", "environmentDifference"} {
			if value, ok := v[k].(string); ok {
				v[k] = uploadTrim(value)
			}
		}
		if parts, ok := v["adoptedParts"].([]any); ok {
			for i, part := range parts {
				if t, ok := part.(string); ok {
					parts[i] = uploadTrim(t)
				}
			}
		}
		if method := uploadObject(v["method"]); method != nil {
			for _, k := range []string{"title", "problemPattern", "solutionStrategy", "verificationMethod", "applicableScope", "license"} {
				if value, ok := method[k].(string); ok {
					method[k] = uploadTrim(value)
				}
			}
			if env := uploadObject(method["environment"]); env != nil {
				for _, k := range []string{"name", "version"} {
					if value, ok := env[k].(string); ok {
						env[k] = uploadTrim(value)
					}
				}
			}
			for _, k := range []string{"tools", "skills", "mcpRefs", "limitations"} {
				for i, item := range uploadRows(method[k]) {
					if value, ok := item.(string); ok {
						uploadRows(method[k])[i] = uploadTrim(value)
					}
				}
			}
		}
	}
	if name == "galaxy_capsule_work_prepare" {
		for _, branch := range uploadRows(schema["oneOf"]) {
			b := uploadObject(branch)
			action := uploadObject(uploadObject(b["properties"])["action"])
			match := action["const"] == v["action"]
			for _, x := range uploadRows(action["enum"]) {
				match = match || x == v["action"]
			}
			if match {
				remoteDefaults(b, v)
				break
			}
		}
	} else {
		remoteDefaults(schema, v)
	}
	if remoteChatValidate(schema, v) != nil {
		return nil, remoteFactsInvalid()
	}
	return v, nil
}
func (h *NativeCapsuleWork) begin(ctx context.Context) (context.Context, func(), *nativeIdentityLease, error) {
	h.mu.Lock()
	closed := h.closed
	h.mu.Unlock()
	if closed {
		return nil, nil, nil, connectionFailure("native_runtime_closed")
	}
	return h.runtime.identityLease(ctx, true)
}
func (h *NativeCapsuleWork) check(ctx context.Context, l *nativeIdentityLease) error {
	h.mu.Lock()
	closed := h.closed
	h.mu.Unlock()
	if closed {
		return connectionFailure("native_runtime_closed")
	}
	return l.check(ctx)
}
func capsuleWorkOwner(l *nativeIdentityLease) string {
	return hostJSONString([]any{l.scope.Endpoint, l.scope.Owner, l.connection.bindingID, l.connection.generation})
}
func capsuleWorkKey(l *nativeIdentityLease, id string) string {
	return "native-capsule-work:" + l.scope.Endpoint + ":" + l.scope.Owner + ":" + id
}
func (h *NativeCapsuleWork) read(ctx context.Context, l *nativeIdentityLease, path string, input any) (map[string]any, error) {
	if e := h.check(ctx, l); e != nil {
		return nil, e
	}
	v, e := l.call(ctx, path, input, false)
	if check := h.check(ctx, l); check != nil {
		return nil, check
	}
	return v, e
}
func (h *NativeCapsuleWork) load(ctx context.Context, l *nativeIdentityLease, id string, readOnly bool) (map[string]any, error) {
	row, e := l.read(ctx, capsuleWorkKey(l, id))
	if e != nil {
		return nil, e
	}
	if row == nil || row["subjectId"] != l.scope.Owner {
		return nil, connectionFailure("capsule_work_unavailable")
	}
	if !readOnly && row["owner"] != capsuleWorkOwner(l) {
		return nil, connectionFailure("capsule_work_identity_changed")
	}
	return row, h.check(ctx, l)
}
func (h *NativeCapsuleWork) save(ctx context.Context, l *nativeIdentityLease, row map[string]any) error {
	if e := h.check(ctx, l); e != nil {
		return e
	}
	return l.update(ctx, capsuleWorkKey(l, text(row["handle"])), func(old map[string]any) (map[string]any, error) {
		if old != nil && (old["payloadJson"] != row["payloadJson"] || old["payloadHash"] != row["payloadHash"]) {
			return nil, connectionFailure("capsule_work_original_changed")
		}
		if old["state"] == "acknowledged" && row["state"] != "acknowledged" {
			return old, nil
		}
		return row, nil
	})
}
func workLatest(rows []any) []map[string]any {
	values := []map[string]any{}
	for _, raw := range rows {
		r := uploadObject(raw)
		if r["supersededInVisibleHistory"] != true {
			values = append(values, r)
		}
	}
	sort.SliceStable(values, func(i, j int) bool { return integer(values[i]["version"]) < integer(values[j]["version"]) })
	out := []map[string]any{}
	indices := map[string]int{}
	for _, r := range values {
		id := text(r["id"])
		if i, ok := indices[id]; ok {
			out[i] = r
		} else {
			indices[id] = len(out)
			out = append(out, r)
		}
	}
	return out
}
func workSame(a, b map[string]any) bool {
	return a["id"] == b["id"] && integer(a["version"]) == integer(b["version"])
}
func workRef(v map[string]any) map[string]any {
	return map[string]any{"id": v["id"], "version": v["version"]}
}
func workOrigin(view, result map[string]any) map[string]any {
	origin := uploadObject(result["origin"])
	key := "interventions"
	if origin["kind"] == "attempt" {
		key = "attempts"
	}
	for _, raw := range uploadRows(view[key]) {
		v := uploadObject(raw)
		if workSame(v, origin) && v["actorId"] == result["actorId"] {
			return v
		}
	}
	return nil
}
func workResults(view map[string]any, owner, action string) []map[string]any {
	out := []map[string]any{}
	for _, r := range workLatest(uploadRows(view["results"])) {
		if r["provenance"] == "native-v2" && (action == "publish" && r["reportedOutcome"] == "succeeded" || action != "publish" && r["actorId"] == owner) && workOrigin(view, r) != nil {
			out = append(out, r)
		}
	}
	return out
}
func workResult(view map[string]any, owner, action string, ref map[string]any) map[string]any {
	for _, r := range workResults(view, owner, action) {
		if workSame(r, ref) {
			return r
		}
	}
	return nil
}
func workVerificationRefs(view, result map[string]any) []any {
	out := []any{}
	for _, raw := range uploadRows(view["verificationRecords"]) {
		v := uploadObject(raw)
		record := uploadObject(v["record"])
		target := uploadObject(record["target"])
		if v["type"] == "verification" && record != nil && v["referenceStatus"] != "unavailable" && target["type"] == "result" && workSame(target, result) {
			out = append(out, workRef(v))
		}
	}
	return out
}
func capsulePurposeName(action string) string {
	return map[string]string{"publish": "方法保存", "apply": "实际应用", "reverify": "再次验证", "reference": "方法引用"}[action]
}
func (h *NativeCapsuleWork) sources(ctx context.Context, l *nativeIdentityLease, x map[string]any) (any, error) {
	page, e := h.read(ctx, l, "/v2/history/query", map[string]any{"subjectId": l.scope.Owner, "limit": 7, "after": x["after"]})
	if e != nil {
		return nil, e
	}
	items := []any{}
	for _, raw := range uploadRows(page["items"]) {
		w := uploadObject(raw)
		if w["kind"] != "case-history" || w["caseId"] == nil {
			continue
		}
		results := []any{}
		for _, r := range workResults(w, l.scope.Owner, text(x["action"])) {
			f := workRef(r)
			f["summary"] = r["summary"]
			f["reportedOutcome"] = r["reportedOutcome"]
			f["verificationRefs"] = workVerificationRefs(w, r)
			results = append(results, f)
		}
		if x["action"] != "reference" && len(results) == 0 {
			continue
		}
		title := w["title"]
		if title == nil {
			title = "当前工作"
		}
		summary := w["summary"]
		if summary == nil {
			summary = ""
		}
		items = append(items, map[string]any{"caseId": w["caseId"], "title": title, "summary": summary, "synthetic": w["synthetic"], "results": results})
	}
	return map[string]any{"items": items, "nextCursor": page["nextCursor"], "subjectId": l.scope.Owner}, nil
}
func (h *NativeCapsuleWork) work(ctx context.Context, l *nativeIdentityLease, x map[string]any) (map[string]any, error) {
	input := map[string]any{}
	if x["taskId"] != nil {
		input["taskId"] = x["taskId"]
	}
	view, e := h.read(ctx, l, "/v2/cases/"+text(x["caseId"])+"/read", input)
	if e != nil {
		return nil, e
	}
	view["subjectId"] = l.scope.Owner
	view["title"] = "当前工作"
	view["summary"] = ""
	for _, v := range uploadRows(view["events"]) {
		event := uploadObject(v)
		if event["kind"] == "case-created" {
			if event["title"] != nil {
				view["title"] = event["title"]
			}
			if event["summary"] != nil {
				view["summary"] = event["summary"]
			}
			break
		}
	}
	return view, nil
}
func (h *NativeCapsuleWork) original(ctx context.Context, l *nativeIdentityLease, x, result, origin map[string]any) (map[string]any, error) {
	var after any
	for {
		query := map[string]any{"capsuleId": x["capsuleId"], "versionId": x["versionId"], "caseId": x["caseId"], "limit": 20}
		if after != nil {
			query["after"] = after
		}
		page, e := h.read(ctx, l, "/v2/capsules/uses/query", query)
		if e != nil {
			return nil, e
		}
		for _, raw := range uploadRows(page["items"]) {
			u := uploadObject(raw)
			record := uploadObject(u["record"])
			priorOrigin := uploadObject(record["originRef"])
			if u["subjectId"] == l.scope.Owner && u["kind"] == "apply" && u["sourceStatus"] == "current" && workSame(uploadObject(record["resultRef"]), result) && priorOrigin["kind"] == origin["kind"] && workSame(priorOrigin, origin) {
				return u, nil
			}
		}
		after = page["nextAfter"]
		if after == nil {
			break
		}
	}
	return nil, connectionFailure("capsule_application_required")
}
func (h *NativeCapsuleWork) originalApplication(ctx context.Context, l *nativeIdentityLease, x map[string]any) (any, error) {
	view, e := h.read(ctx, l, "/v2/cases/"+text(x["caseId"])+"/read", map[string]any{})
	if e != nil {
		return nil, e
	}
	result := workResult(view, l.scope.Owner, "reverify", uploadObject(x["resultRef"]))
	if result == nil {
		return nil, connectionFailure("capsule_work_current_result_required")
	}
	origin := workRef(workOrigin(view, result))
	origin["kind"] = uploadObject(result["origin"])["kind"]
	return h.original(ctx, l, x, result, origin)
}
func (h *NativeCapsuleWork) prepare(ctx context.Context, l *nativeIdentityLease, x map[string]any) (any, error) {
	view, e := h.work(ctx, l, x)
	if e != nil {
		return nil, e
	}
	var payload map[string]any
	action := text(x["action"])
	if action == "publish" {
		result := workResult(view, l.scope.Owner, "publish", uploadObject(x["resultRef"]))
		if result == nil {
			return nil, connectionFailure("capsule_work_current_success_required")
		}
		source := workRef(workOrigin(view, result))
		source["kind"] = uploadObject(result["origin"])["kind"]
		source["caseId"] = x["caseId"]
		if _, ok := view["synthetic"].(bool); !ok {
			return nil, connectionFailure("capsule_work_native_source_required")
		}
		var management map[string]any
		if x["capsuleId"] != nil {
			prior, e := h.read(ctx, l, "/v2/capsules/read", map[string]any{"capsuleId": x["capsuleId"]})
			if e != nil {
				return nil, e
			}
			if prior["authorId"] != l.scope.Owner || integer(uploadObject(prior["version"])["schemaVersion"]) != 2 {
				return nil, connectionFailure("capsule_work_author_required")
			}
			versions, e := h.read(ctx, l, "/v2/capsules/versions", map[string]any{"capsuleId": x["capsuleId"], "limit": 1})
			if e != nil {
				return nil, e
			}
			management = uploadObject(versions["management"])
		}
		method := uploadObject(x["method"])
		permissions := []any{}
		seen := map[string]bool{}
		var after any
		for {
			query := map[string]any{"view": "granted", "limit": 20}
			if after != nil {
				query["after"] = after
			}
			page, e := h.read(ctx, l, "/v2/capsules/permissions/query", query)
			if e != nil {
				return nil, e
			}
			for _, raw := range uploadRows(page["items"]) {
				p := uploadObject(raw)
				license := uploadObject(p["payload"])
				if p["revoked"] == true || p["expired"] == true || p["sourceStatus"] != "current" || license["license"] != method["license"] || x["visibility"] == "Public" && license["allowPublic"] != true {
					continue
				}
				match := false
				for _, v := range uploadRows(license["sources"]) {
					s := uploadObject(v)
					match = match || s["caseId"] == x["caseId"] && (s["kind"] == source["kind"] && workSame(s, source) || s["kind"] == "result" && workSame(s, result))
				}
				if match && !seen[text(p["permissionId"])] {
					seen[text(p["permissionId"])] = true
					permissions = append(permissions, p["permissionId"])
				}
			}
			after = page["nextAfter"]
			if after == nil || len(permissions) >= 64 {
				break
			}
		}
		id := x["capsuleId"]
		if id == nil {
			id = uuid.NewString()
		}
		payload = map[string]any{"schemaVersion": 2, "id": uuid.NewString(), "capsuleId": id, "kind": "version", "expectedRevision": integer(management["revision"]), "version": integer(management["publishedVersionCount"]) + 1, "publicationClass": "formal-source-success", "synthetic": view["synthetic"], "contributors": []any{}, "sourceResolution": map[string]any{"caseId": x["caseId"], "resultId": result["id"], "resultVersion": result["version"]}, "sourceRefs": []any{source}, "permissionRefs": permissions[:min(len(permissions), 64)], "attributionRefs": []any{}, "externalReferences": []any{}, "redactionConfirmed": true}
		for k, v := range method {
			payload[k] = v
		}
	} else {
		capsule, e := h.read(ctx, l, "/v2/capsules/read", map[string]any{"capsuleId": x["capsuleId"], "versionId": x["versionId"]})
		if e != nil {
			return nil, e
		}
		payload = map[string]any{"schemaVersion": 2, "id": uuid.NewString(), "kind": action, "capsuleId": x["capsuleId"], "versionId": x["versionId"], "caseId": x["caseId"], "attribution": capsule["authorId"]}
		if x["note"] != nil {
			payload["note"] = x["note"]
		}
		if action == "reference" {
			if x["taskId"] != nil {
				payload["taskId"] = x["taskId"]
			}
		} else {
			version := uploadObject(capsule["version"])
			if capsule["newApplicationAllowed"] != true || integer(version["schemaVersion"]) != 2 {
				return nil, connectionFailure("capsule_not_applicable")
			}
			if x["caseId"] == uploadObject(version["sourceResolution"])["caseId"] {
				return nil, connectionFailure("capsule_new_case_required")
			}
			result := workResult(view, l.scope.Owner, action, uploadObject(x["resultRef"]))
			if result == nil {
				return nil, connectionFailure("capsule_work_current_result_required")
			}
			origin := workOrigin(view, result)
			if origin == nil || origin["actorId"] != l.scope.Owner {
				return nil, connectionFailure("capsule_application_author_required")
			}
			selected := workRef(origin)
			selected["kind"] = uploadObject(result["origin"])["kind"]
			var prior map[string]any
			if action == "reverify" {
				prior, e = h.original(ctx, l, x, result, selected)
				if e != nil {
					return nil, e
				}
			}
			old := uploadObject(prior["record"])
			if action == "apply" && (text(x["note"]) == "" || len(uploadRows(x["adoptedParts"])) == 0) {
				return nil, connectionFailure("capsule_actual_use_description_required")
			}
			configuration := old["configurationRef"]
			if configuration == nil {
				configuration = x["configurationRef"]
			}
			environment := map[string]any{"name": "unknown", "version": "unknown"}
			if selected["kind"] == "attempt" {
				env := uploadObject(origin["environment"])
				if text(env["name"]) != "" && text(env["version"]) != "" {
					environment = env
				}
			}
			if configuration != nil {
				found := false
				for _, v := range uploadRows(origin["sourceRefs"]) {
					r := uploadObject(v)
					found = found || r["kind"] == "configuration" && workSame(r, uploadObject(configuration))
				}
				if selected["kind"] != "intervention" || !found {
					return nil, connectionFailure("capsule_configuration_not_in_origin")
				}
				config, e := h.read(ctx, l, "/v2/configurations/read", configuration)
				if e != nil {
					return nil, e
				}
				record := uploadObject(config["record"])
				if config["contentAvailable"] != true || record == nil {
					return nil, connectionFailure("capsule_configuration_source_unavailable")
				}
				env := uploadObject(uploadObject(record["conditions"])["environment"])
				environment = map[string]any{"name": "unknown", "version": "unknown"}
				for _, k := range []string{"name", "version"} {
					if env[k] != nil {
						environment[k] = env[k]
					}
				}
				payload["configurationRef"] = configuration
			}
			payload["originRef"] = selected
			payload["resultRef"] = workRef(result)
			payload["environment"] = environment
			if payload["note"] == nil {
				payload["note"] = old["note"]
			}
			difference := x["environmentDifference"]
			if difference == nil {
				difference = old["environmentDifference"]
			}
			if difference == nil {
				other := uploadObject(version["environment"])
				difference = "本次记录环境：" + text(environment["name"]) + " " + text(environment["version"]) + "；方法适用环境：" + text(other["name"]) + " " + text(other["version"]) + "。兼容性未由这些记录独立确认。"
			}
			payload["environmentDifference"] = difference
			parts := old["adoptedParts"]
			if parts == nil {
				parts = x["adoptedParts"]
			}
			payload["adoptedParts"] = parts
			payload["outcome"] = result["reportedOutcome"]
			for _, k := range []string{"taskId", "participationId"} {
				if result[k] != nil {
					payload[k] = result[k]
				}
			}
			if action == "reverify" {
				refs := uploadRows(x["verificationRefs"])
				if len(refs) == 0 {
					return nil, connectionFailure("capsule_work_verification_required")
				}
				for _, raw := range refs {
					r := uploadObject(raw)
					query := map[string]any{"type": "verification", "id": r["id"], "version": r["version"]}
					v, e := h.read(ctx, l, "/v2/verification-records/read", query)
					if e != nil {
						return nil, e
					}
					record := uploadObject(v["record"])
					target := uploadObject(record["target"])
					if record == nil || target["type"] != "result" || !workSame(target, result) {
						return nil, connectionFailure("capsule_verification_mismatch")
					}
				}
				payload["priorUseId"] = prior["eventId"]
				payload["verificationRefs"] = refs
			}
		}
	}
	kind := "use"
	if action == "publish" {
		kind = "event"
	}
	raw, e := protocol.EncodeJS(payload)
	if e != nil {
		return nil, e
	}
	normalized, e := capsules.ParsePayloadV2(kind, string(raw))
	if e != nil {
		return nil, e
	}
	if action == "publish" {
		value, e := protocol.DecodeOrdered(normalized)
		if e != nil {
			return nil, e
		}
		preview, e := h.read(ctx, l, "/v2/capsules/preview", map[string]any{"payload": value})
		if e != nil {
			return nil, e
		}
		if preview["readyForPublicPublication"] != true && !(x["visibility"] == "Private" && preview["reason"] == "capsule_publication_not_permitted") {
			code := text(preview["reason"])
			if code == "" {
				code = "capsule_work_source_unavailable"
			}
			return nil, connectionFailure(code)
		}
	}
	handle := uuid.NewString()
	title := "当前方法的" + capsulePurposeName(action)
	if action == "publish" {
		title = text(payload["title"])
	}
	row := map[string]any{"handle": handle, "subjectId": l.scope.Owner, "owner": capsuleWorkOwner(l), "state": "prepared", "action": action, "payloadJson": string(normalized), "payloadHash": identity.Digest(normalized), "consentRequestId": uuid.NewString(), "visibility": x["visibility"], "viewers": x["viewers"], "title": title, "expiresAt": time.Now().UnixMilli() + 1800000}
	if e = h.save(ctx, l, row); e != nil {
		return nil, e
	}
	e = l.updateAny(ctx, capsuleWorkKey(l, "index"), func(v any) (any, error) {
		index := []any{}
		found := map[string]bool{}
		for _, id := range append(uploadRows(v), handle) {
			if !found[text(id)] {
				found[text(id)] = true
				index = append(index, id)
			}
		}
		if len(index) > 64 {
			index = index[len(index)-64:]
		}
		return index, nil
	})
	if e != nil {
		return nil, e
	}
	return map[string]any{"handle": handle, "state": "prepared", "action": action, "title": title, "payloadJson": string(normalized), "visibility": row["visibility"], "viewers": row["viewers"], "expiresAt": row["expiresAt"]}, nil
}
