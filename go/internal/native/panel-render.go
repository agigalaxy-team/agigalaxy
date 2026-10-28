package native

import (
	"context"
	"fmt"
)

func panelPick(row panelMap, keys ...string) panelMap {
	out := panelMap{}
	for _, key := range keys {
		if v, ok := row[key]; ok {
			out[key] = v
		}
	}
	return out
}
func panelDefault(v, f any) any {
	if v == nil {
		return f
	}
	return v
}
func panelPath(object panelMap) string {
	if object == nil {
		return ""
	}
	route := map[string]string{"task": "tasks", "room": "rooms", "messages": "rooms", "project": "projects", "capsule": "capsules", "match": "match", "publish": "publish", "participate": "participate", "identity": "settings/identity", "privacy": "settings/privacy", "search": "search", "capsules": "capsules", "summaries": "settings/summaries", "notifications": "notifications"}[text(object["kind"])]
	if route == "" {
		route = "undefined"
	}
	path := "/app/" + route
	if id := text(object["id"]); id != "" {
		path += "/" + id
	}
	if version := text(object["versionId"]); version != "" {
		path += "/versions/" + version
	}
	return path
}
func panelProject(object, data panelMap) panelMap {
	kind, id := text(object["kind"]), data["taskId"]
	switch kind {
	case "task":
		out := panelPick(data, "state", "enrollmentOpen")
		out["title"], out["summary"], out["revision"] = panelTextValue(psObject(data["request"])["title"], 160), panelTextValue(psObject(data["request"])["summary"], 1600), data["version"]
		out["source"] = panelMap{"kind": "task", "id": id, "version": data["version"], "caseId": data["caseId"]}
		out["capabilityVerified"] = false
		var contacts any
		if data["contacts"] != nil {
			contacts = panelPick(psObject(data["contacts"]), "suggestions", "responses")
		}
		out["contacts"] = contacts
		participations := []any{}
		for _, v := range trustArray(data["participations"]) {
			participations = append(participations, panelPick(psObject(v), "participationId", "subjectId", "state", "scopeVersion"))
		}
		out["participations"] = participations
		return out
	case "room":
		out := panelPick(data, "state", "kind", "taskRefs", "transportAvailable", "revision")
		out["title"] = panelTextValue(data["title"], 160)
		out["source"] = panelMap{"kind": "room", "id": data["roomId"], "revision": data["revision"]}
		return out
	case "project":
		out := panelPick(data, "state", "revision", "classification")
		out["title"], out["summary"] = panelTextValue(psObject(data["document"])["title"], 160), panelTextValue(psObject(data["document"])["summary"], 1600)
		source := psObject(data["source"])
		out["source"] = panelMap{"kind": "project", "id": data["projectId"], "revision": data["revision"], "documentEventId": source["documentEventId"], "policyEventId": source["policyEventId"]}
		out["capabilityVerified"] = false
		return out
	}
	version := psObject(data["version"])
	method := panelMap{}
	for key, max := range map[string]int{"problemPattern": 4000, "solutionStrategy": 16000, "applicableScope": 4000, "verificationMethod": 4000, "license": 160} {
		method[key] = panelTextValue(version[key], max)
	}
	for _, key := range []string{"limitations", "tools", "skills", "mcpRefs"} {
		values := []any{}
		for _, v := range trustArray(version[key]) {
			if panelTextValue(v, 16000) != nil {
				values = append(values, v)
			}
		}
		method[key] = values
	}
	var environment any
	if version["environment"] != nil {
		row := psObject(version["environment"])
		environment = panelMap{"name": panelTextValue(row["name"], 300), "version": panelTextValue(row["version"], 160)}
	}
	method["environment"] = environment
	return panelMap{"title": panelTextValue(version["title"], 160), "summary": panelTextValue(version["summary"], 1600), "state": data["sourceStatus"], "revision": data["revision"], "source": panelMap{"kind": "capsule", "id": data["capsuleId"], "versionId": data["versionId"]}, "method": method, "deprecated": data["deprecated"], "securityIssue": data["securityIssue"], "sourceNeedsReview": data["sourceNeedsReview"], "readingIsReuse": false, "capabilityVerified": false}
}
func (l *panelLease) readObject(ctx context.Context, v *panelView) (panelMap, error) {
	object := psObject(l.panel.viewInput(v)["object"])
	id := text(object["id"])
	if id == "" {
		return nil, nil
	}
	var data panelMap
	var e error
	switch object["kind"] {
	case "task":
		data, e = l.call(ctx, "/v2/tasks/"+id, nil)
	case "room":
		data, e = l.call(ctx, "/v2/chat/rooms/"+id+"/read", panelMap{})
	case "project":
		data, e = l.call(ctx, "/v2/projects/"+id, nil)
	default:
		input := panelMap{"capsuleId": id}
		if version := object["versionId"]; version != nil {
			input["versionId"] = version
		}
		data, e = l.call(ctx, "/v2/capsules/read", input)
	}
	if e != nil {
		return nil, e
	}
	out := panelProject(object, data)
	source := psObject(out["source"])
	if source["id"] != id || object["versionId"] != nil && source["versionId"] != object["versionId"] {
		return nil, panelError("panel_source_reference_mismatch")
	}
	if object["kind"] == "room" {
		conversation, e := l.conversation(ctx, v, data)
		if e != nil {
			return nil, e
		}
		out["conversation"] = conversation
	}
	return out, nil
}
func (l *panelLease) profileLabels(ctx context.Context, ids []string) (map[string]any, error) {
	names := map[string]any{}
	subjects := []string{}
	seen := map[string]bool{}
	for _, id := range ids {
		if !seen[id] && helpSubject.MatchString(id) {
			subjects = append(subjects, id)
			seen[id] = true
			if len(subjects) == 100 {
				break
			}
		}
	}
	for _, id := range subjects {
		page, e := l.call(ctx, "/v1/history/query", panelMap{"subjectId": id, "limit": 1})
		if e != nil {
			if panelFatal(e) {
				return nil, e
			}
			continue
		}
		name := panelTextValue(helpTrim(psObject(page["selfDeclared"])["displayName"]), 80)
		if panelNonempty(name) {
			names[id] = name
		}
	}
	return names, l.check(ctx)
}
func (l *panelLease) replyGrant(ctx context.Context, v *panelView) (panelMap, error) {
	room := text(psObject(l.panel.viewInput(v)["object"])["id"])
	after := ""
	for page := 0; page < 8; page++ {
		data, e := l.call(ctx, "/v2/chat/rooms/"+room+"/agent-grants", panelMap{"after": after, "limit": 100})
		if e != nil {
			return nil, e
		}
		for _, value := range trustArray(data["items"]) {
			grant := psObject(value)
			if grant["state"] == "active" && grant["mode"] == "respond" && grant["bindingId"] == l.binding {
				return grant, nil
			}
		}
		next := text(data["next"])
		if next == "" || next == after {
			return nil, nil
		}
		after = next
	}
	return nil, nil
}
func (l *panelLease) conversation(ctx context.Context, v *panelView, room panelMap) (panelMap, error) {
	history, e := l.call(ctx, "/v2/chat/rooms/"+text(room["roomId"])+"/history", panelMap{"latest": true, "limit": 100})
	if e != nil {
		return nil, e
	}
	messages := trustArray(history["messages"])
	if len(messages) > 100 {
		messages = messages[len(messages)-100:]
	}
	ids := []string{}
	for _, message := range messages {
		ids = append(ids, text(psObject(message)["subjectId"]))
	}
	names, e := l.profileLabels(ctx, ids)
	if e != nil {
		return nil, e
	}
	grant, e := l.replyGrant(ctx, v)
	if e != nil {
		return nil, e
	}
	members := []string{}
	for _, member := range trustArray(room["members"]) {
		members = append(members, text(psObject(member)["subjectId"]))
	}
	rows := []any{}
	for _, value := range messages {
		message := psObject(value)
		mine := message["subjectId"] == v.owner
		var label any = "我"
		if !mine {
			label = names[text(message["subjectId"])]
			if label == nil {
				index := 0
				for i, id := range members {
					if id == message["subjectId"] {
						index = i + 1
						break
					}
				}
				if index < 1 {
					index = 1
				}
				label = fmt.Sprintf("成员 %d", index)
			}
		}
		out := panelPick(message, "messageId", "sequence", "revision", "state", "sentAt", "replyTo")
		var body any
		if message["state"] == "accepted" {
			body = message["text"]
		}
		out["text"], out["mine"], out["authorLabel"], out["attachments"] = body, mine, label, panelDefault(message["attachments"], []any{})
		rows = append(rows, out)
	}
	var unavailable any
	if room["transportAvailable"] != true {
		unavailable = "transport"
	} else if grant == nil {
		unavailable = "authorization"
	}
	return panelMap{"messages": rows, "complete": true, "historyProjection": "current-window", "earlierMessagesAvailable": panelNonempty(history["previous"]), "canReply": room["transportAvailable"] == true && !isOne(text(room["state"]), "archived", "owner-succession") && grant != nil, "replyUnavailable": unavailable}, nil
}
func (l *panelLease) render(ctx context.Context, v *panelView) (panelMap, error) {
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	var source, help panelMap
	var sourceError, helpError any
	selected, e := l.readObject(ctx, v)
	if e != nil {
		if panelFatal(e) {
			return nil, e
		}
		sourceError = panelCode(e)
	} else {
		source = selected
	}
	input := l.panel.viewInput(v)
	if session := text(input["helpSessionId"]); session != "" {
		review, e := l.helpCall(ctx, "galaxy_help_review", panelMap{"sessionId": session})
		if e == nil {
			row := psObject(review["session"])
			uncertain := false
			for _, value := range trustArray(row["actionOperations"]) {
				operation := psObject(value)
				if isOne(text(operation["state"]), "unknown", "submitting") {
					uncertain = true
					if _, err := l.helpCall(ctx, "galaxy_help_reconcile_action", panelMap{"sessionId": session, "operationId": operation["operationId"]}); err != nil && panelFatal(err) {
						return nil, err
					}
				}
			}
			if uncertain {
				review, e = l.helpCall(ctx, "galaxy_help_review", panelMap{"sessionId": session})
			}
		}
		if e != nil {
			if panelFatal(e) {
				return nil, e
			}
			helpError = panelCode(e)
		} else {
			row := psObject(review["session"])
			help = panelPick(row, "revision", "pauseState", "caseId", "taskId", "selectedHelpIds")
			delete(help, "pauseState")
			help["sessionId"], help["state"], help["sourceRefreshRequiredBeforeAction"], help["checkedAt"] = row["id"], row["pauseState"], true, review["checkedAt"]
			operations := []any{}
			for _, value := range trustArray(row["linkedOperations"]) {
				operations = append(operations, panelPick(psObject(value), "operationId", "taskId", "state", "version", "checkedAt"))
			}
			help["operations"], help["actionOperations"] = operations, panelDefault(row["actionOperations"], []any{})
			offers := []any{}
			for _, value := range trustArray(review["offers"]) {
				item := psObject(value)
				out := panelPick(item, "id", "state")
				offer := psObject(item["offer"])
				if item["state"] == "current" && offer != nil {
					for k, value := range panelPick(offer, "path", "kind", "helpDescription", "userFacingReason", "participants", "interventionKinds", "environmentDifferences", "conditions", "availability") {
						out[k] = value
					}
					out["explanationAuthor"] = "user-agent"
					refs := []any{}
					for _, raw := range trustArray(offer["basisRefs"]) {
						ref := panelPick(psObject(raw), "kind", "id", "sourceRevision", "checkedAt", "classification")
						ref["capabilityVerified"] = false
						refs = append(refs, ref)
					}
					out["basisRefs"] = refs
				}
				offers = append(offers, out)
			}
			help["offers"] = offers
			if input["object"] == nil && row["taskId"] != nil {
				l.panel.mu.Lock()
				v.input["object"] = panelMap{"kind": "task", "id": row["taskId"]}
				l.panel.mu.Unlock()
				input = l.panel.viewInput(v)
				selected, err := l.readObject(ctx, v)
				if err != nil {
					if panelFatal(err) {
						return nil, err
					}
					sourceError = panelCode(err)
				} else {
					source = selected
				}
			}
		}
	}
	saved, e := l.read(ctx, v.draftKey)
	if e != nil {
		return nil, e
	}
	reply, e := l.read(ctx, v.draftKey+":reply")
	if e != nil {
		return nil, e
	}
	var message any
	if psObject(input["object"])["kind"] == "room" {
		message, e = l.pendingMessage(ctx, v)
		if e != nil {
			return nil, e
		}
	}
	paths := []any{}
	for _, path := range []string{"continue-current-ai", "capsule-or-history", "open-assistance", "bounty-or-expert"} {
		count := 0
		for _, value := range trustArray(help["offers"]) {
			if psObject(value)["path"] == path {
				count++
			}
		}
		paths = append(paths, panelMap{"id": path, "label": map[string]string{"continue-current-ai": "继续当前 AI", "capsule-or-history": "Capsule／历史方案", "open-assistance": "开放协助", "bounty-or-expert": "赏金／专家协助"}[path], "availability": "由当前资料和用户模型判断", "selectedHelpCount": count})
	}
	var objectURL any
	if path := panelPath(psObject(input["object"])); path != "" {
		objectURL = l.panel.Runtime.config.Website + path
	}
	out := panelMap{"schemaVersion": 1, "viewId": v.id, "checkedAt": l.panel.Runtime.connection.now().Unix(), "subjectId": nullableText(v.owner), "object": input["object"], "source": source, "sourceError": sourceError, "help": help, "helpError": helpError, "paths": paths, "activeEntries": []any{panelMap{"id": "match", "label": "主动匹配"}, panelMap{"id": "publish", "label": "发布任务"}, panelMap{"id": "participate", "label": "参与任务"}}, "objectUrl": objectURL, "draft": panelMap{"text": panelDefault(saved["draft"], ""), "revision": psInt(saved["revision"]), "scope": "this-device-only"}, "replyDraft": panelMap{"text": panelDefault(reply["draft"], ""), "revision": psInt(reply["revision"]), "scope": "this-device-only"}, "messageResult": message, "presentation": panelMap{"embeddedHostAcceptance": "unverified", "completeRoom": "browser", "closingDoesNotCancel": true}, "businessMutation": false, "modelCalls": 0}
	if l.binding != "" {
		out["ownerScope"] = l.ownerScope()
	}
	return out, l.check(ctx)
}
