package taskmaterials

import (
	"context"
	"encoding/json"
	"math"
	"net/url"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

type SourceState struct {
	Available, Permanent bool
	Reasons              []string
	Row, Payload         Object
	AvailableUntil       int64
	Text                 string
}

// ForumSource returns the original version and its exact Public publication
// authority, including current revocation, governance and permanence reasons.
type ForumSource func(context.Context, pgx.Tx, Object, string, bool) (SourceState, error)
type Selection struct {
	MaterialID string  `json:"materialId"`
	Field      string  `json:"field"`
	Start      int     `json:"start"`
	End        int     `json:"end"`
	Text       *string `json:"text,omitempty"`
}
type PrepareInput struct {
	Source struct {
		PostID    string `json:"postId"`
		VersionID string `json:"versionId"`
	} `json:"source"`
	Selections []Selection `json:"selections"`
	ExpiresAt  int64       `json:"expiresAt"`
}
type MaterialRow struct {
	Descriptor Object
	Text       string
	ExpiresAt  int64
}

// ParsePrepare preserves required numeric fields before converting to the typed
// selection: omitted start must not silently become a valid zero offset.
func ParsePrepare(raw []byte) (PrepareInput, error) {
	var out PrepareInput
	x, err := parseObject(string(raw))
	invalid := func() (PrepareInput, error) { return out, fail("invalid_task_material_request", 400) }
	if err != nil || !exactFields(x, []string{"source", "selections", "expiresAt"}, nil) || !validInt(x["expiresAt"], 1, math.MaxInt64) {
		return invalid()
	}
	source := obj(x, "source")
	if !exactFields(source, []string{"postId", "versionId"}, nil) || !validID(str(source, "postId")) || !validID(str(source, "versionId")) {
		return invalid()
	}
	out.Source.PostID, out.Source.VersionID, out.ExpiresAt = str(source, "postId"), str(source, "versionId"), num(x["expiresAt"])
	selections, ok := x["selections"].([]any)
	if !ok || len(selections) < 1 || len(selections) > 8 {
		return invalid()
	}
	seen := map[string]bool{}
	for _, value := range selections {
		v, ok := value.(map[string]any)
		if !ok || !exactFields(v, []string{"materialId", "field", "start", "end"}, []string{"text"}) || !validID(str(v, "materialId")) || seen[str(v, "materialId")] || !contains([]string{"title", "body"}, str(v, "field")) || !validInt(v["start"], 0, math.MaxInt64) || !validInt(v["end"], 1, math.MaxInt64) || num(v["end"]) <= num(v["start"]) {
			return invalid()
		}
		selection := Selection{MaterialID: str(v, "materialId"), Field: str(v, "field"), Start: int(num(v["start"])), End: int(num(v["end"]))}
		if text, present := v["text"]; present {
			text, ok := text.(string)
			if !ok || protocol.TextLength(text) < 1 || protocol.TextLength(text) > 10000 {
				return invalid()
			}
			selection.Text = &text
		}
		seen[selection.MaterialID] = true
		out.Selections = append(out.Selections, selection)
	}
	return out, nil
}

func (s *Service) source(ctx context.Context, tx pgx.Tx, source Object, owner string, lock bool) (SourceState, error) {
	if endpoint := str(source, "endpoint"); endpoint != "" && endpoint != s.Endpoint {
		return SourceState{Permanent: true, Reasons: []string{"source-endpoint-mismatch"}}, nil
	}
	if s.Forum == nil {
		return SourceState{}, fail("task_material_source_reader_unavailable", 503)
	}
	return s.Forum(ctx, tx, source, owner, lock)
}
func selection(state SourceState, source Object) (string, error) {
	field := str(source, "field")
	value, ok := state.Payload[field].(string)
	if !contains([]string{"title", "body"}, field) || !ok {
		return "", fail("task_material_source_mismatch")
	}
	points := []rune(value)
	start, end := int(num(source["start"])), int(num(source["end"]))
	if start < 0 || end > len(points) || start >= end {
		return "", fail("task_material_selection_mismatch")
	}
	return string(points[start:end]), nil
}
func (s *Service) Prepare(ctx context.Context, a Actor, input PrepareInput) (any, error) {
	if !validID(input.Source.PostID) || !validID(input.Source.VersionID) || len(input.Selections) < 1 || len(input.Selections) > 8 || input.ExpiresAt < 1 {
		return nil, fail("invalid_task_material_request", 400)
	}
	seen := map[string]bool{}
	for _, v := range input.Selections {
		if !validID(v.MaterialID) || seen[v.MaterialID] || !contains([]string{"title", "body"}, v.Field) || v.Start < 0 || v.End <= v.Start || v.Text != nil && !validText(*v.Text, 10000) {
			return nil, fail("invalid_task_material_request", 400)
		}
		seen[v.MaterialID] = true
	}
	return s.run(ctx, a, "assistance", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		state, e := s.source(ctx, tx, Object{"postId": input.Source.PostID, "versionId": input.Source.VersionID}, a.SubjectID, true)
		if e != nil {
			return nil, e
		}
		if !state.Available {
			return nil, fail("task_material_source_unavailable", 403)
		}
		if input.ExpiresAt <= s.now() || input.ExpiresAt > state.AvailableUntil {
			return nil, fail("task_material_expiry_invalid", 403)
		}
		source := Object{"kind": "forum-post-version", "endpoint": s.Endpoint, "postId": input.Source.PostID, "versionId": input.Source.VersionID, "permissionId": state.Row["permission_id"], "payloadHash": state.Row["payload_hash"]}
		descriptors := []Object{}
		bodies := []Object{}
		size := 0
		for _, v := range input.Selections {
			selected, e := selection(state, Object{"field": v.Field, "start": v.Start, "end": v.End})
			if e != nil {
				return nil, e
			}
			body := selected
			if v.Text != nil {
				body = *v.Text
			}
			size += len([]byte(body))
			ref := Object{}
			for k, v := range source {
				ref[k] = v
			}
			ref["field"] = v.Field
			ref["start"] = v.Start
			ref["end"] = v.End
			ref["selectionHash"] = identity.Digest([]byte(selected))
			descriptors = append(descriptors, Object{"materialId": v.MaterialID, "source": ref, "textHash": identity.Digest([]byte(body)), "purpose": "task-context", "expiresAt": input.ExpiresAt})
			bodies = append(bodies, Object{"materialId": v.MaterialID, "text": body})
		}
		if size > 49152 {
			return nil, fail("task_material_body_too_large", 413)
		}
		return Object{"descriptors": descriptors, "materialBodies": bodies, "checkedAt": s.now(), "source": source, "sourceAvailableUntil": state.AvailableUntil}, nil
	})
}
func validDescriptor(d Object) bool {
	if !exactFields(d, []string{"materialId", "source", "textHash", "purpose", "expiresAt"}, nil) || !validID(str(d, "materialId")) || !hashPattern.MatchString(str(d, "textHash")) || str(d, "purpose") != "task-context" || !validInt(d["expiresAt"], 1, math.MaxInt64) {
		return false
	}
	v := obj(d, "source")
	u, e := url.Parse(str(v, "endpoint"))
	return exactFields(v, []string{"kind", "endpoint", "postId", "versionId", "permissionId", "payloadHash", "field", "start", "end", "selectionHash"}, nil) && str(v, "kind") == "forum-post-version" && e == nil && u.Scheme != "" && u.Host != "" && validID(str(v, "postId")) && validID(str(v, "versionId")) && validID(str(v, "permissionId")) && hashPattern.MatchString(str(v, "payloadHash")) && hashPattern.MatchString(str(v, "selectionHash")) && contains([]string{"title", "body"}, str(v, "field")) && validInt(v["start"], 0, math.MaxInt64) && validInt(v["end"], 1, math.MaxInt64) && num(v["end"]) > num(v["start"])
}
func textFields(request Object) Object {
	work := obj(request, "workContext")
	fields := Object{"title": request["title"], "summary": request["summary"], "goal": work["goal"], "currentSituation": work["currentSituation"]}
	if v, ok := request["expectedOutcome"]; ok {
		fields["expectedOutcome"] = v
	}
	return fields
}
func materialIDs(value any) []string {
	ids := []string{}
	v, ok := value.(map[string]any)
	if !ok {
		return ids
	}
	for _, item := range arr(v["segments"]) {
		segment, _ := item.(map[string]any)
		if str(segment, "kind") == "material" {
			ids = append(ids, str(segment, "materialId"))
		}
	}
	return ids
}
func (s *Service) ValidateWithin(ctx context.Context, tx pgx.Tx, a Actor, request Object, bodies []Object, grant deviceauth.ConsentIntent) ([]MaterialRow, error) {
	descriptors := arr(request["materials"])
	if len(descriptors) < 1 || len(descriptors) > 8 || len(bodies) != len(descriptors) {
		return nil, fail("task_material_body_mismatch")
	}
	bodyMap := map[string]string{}
	size := 0
	for _, b := range bodies {
		if !exactFields(b, []string{"materialId", "text"}, nil) || !validID(str(b, "materialId")) || !validText(b["text"], 10000) {
			return nil, fail("task_material_body_mismatch")
		}
		if _, ok := bodyMap[str(b, "materialId")]; ok {
			return nil, fail("task_material_body_mismatch")
		}
		bodyMap[str(b, "materialId")] = str(b, "text")
		size += len([]byte(str(b, "text")))
	}
	if size > 49152 {
		return nil, fail("task_material_body_mismatch")
	}
	refs := []string{}
	for _, field := range textFields(request) {
		refs = append(refs, materialIDs(field)...)
	}
	seen := map[string]bool{}
	purpose := "operational"
	if str(request, "visibility") == "Public" {
		purpose = "public-profile"
	}
	if grant.Purpose != purpose || !contains(grant.Fields, "materials") || grant.CurrentVisibility != nil && grant.CurrentVisibility.DeletionPending {
		return nil, fail("task_material_reuse_consent_required", 403)
	}
	out := []MaterialRow{}
	resolved := map[string]SourceState{}
	for _, value := range descriptors {
		d, ok := value.(map[string]any)
		if !ok || !validDescriptor(d) || seen[str(d, "materialId")] || !contains(refs, str(d, "materialId")) {
			return nil, fail("task_material_body_mismatch")
		}
		seen[str(d, "materialId")] = true
		var exists bool
		if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM task_materials_v1 WHERE material_id=$1)", d["materialId"]).Scan(&exists); e != nil {
			return nil, e
		}
		if exists {
			return nil, fail("task_material_id_conflict")
		}
		state, e := s.source(ctx, tx, obj(d, "source"), a.SubjectID, true)
		if e != nil {
			return nil, e
		}
		if !state.Available {
			return nil, fail("task_material_source_unavailable", 403)
		}
		if num(d["expiresAt"]) <= s.now() || num(d["expiresAt"]) > state.AvailableUntil {
			return nil, fail("task_material_expiry_invalid", 403)
		}
		selected, e := selection(state, obj(d, "source"))
		if e != nil {
			return nil, e
		}
		if identity.Digest([]byte(selected)) != str(obj(d, "source"), "selectionHash") {
			return nil, fail("task_material_selection_mismatch")
		}
		body, ok := bodyMap[str(d, "materialId")]
		if !ok || identity.Digest([]byte(body)) != str(d, "textHash") {
			return nil, fail("task_material_body_mismatch")
		}
		expiry := min(num(d["expiresAt"]), grant.ExpiresAt, state.AvailableUntil)
		out = append(out, MaterialRow{d, body, expiry})
		resolved[str(d, "materialId")] = SourceState{Available: true, Text: body, AvailableUntil: expiry}
	}
	for _, id := range refs {
		if !seen[id] {
			return nil, fail("task_material_body_mismatch")
		}
	}
	fields := s.ProjectText(request, resolved)
	for key, maximum := range map[string]int{"title": 120, "summary": 10000, "goal": 10000, "currentSituation": 10000, "expectedOutcome": 1500} {
		field, ok := fields[key].(Object)
		if !ok {
			continue
		}
		value := str(field, "text")
		if jsTrim(value) == "" || protocol.TextLength(value) > maximum {
			return nil, fail("task_material_field_invalid", 400)
		}
	}
	return out, nil
}
func (s *Service) InsertWithin(ctx context.Context, tx pgx.Tx, a Actor, request Object, consentID string, materials []MaterialRow) error {
	for _, m := range materials {
		if _, e := tx.Exec(ctx, `INSERT INTO task_materials_v1(material_id,task_id,subject_id,root_event_id,consent_id,descriptor,body_text,text_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`, m.Descriptor["materialId"], request["taskId"], a.SubjectID, request["operationId"], consentID, jsonBytes(m.Descriptor), m.Text, m.Descriptor["textHash"], stamp(s.now()), stamp(m.ExpiresAt)); e != nil {
			return e
		}
	}
	return nil
}
func (s *Service) StatusWithin(ctx context.Context, tx pgx.Tx, row Object, lock bool) (SourceState, error) {
	unavailable := func(reason string) SourceState { return SourceState{Permanent: true, Reasons: []string{reason}} }
	if row["erased_at"] != nil || str(row, "body_text") == "" {
		return unavailable("material-erased"), nil
	}
	if sec(row["expires_at"]) <= s.now() {
		return unavailable("material-expired"), nil
	}
	d := obj(row, "descriptor")
	if identity.Digest([]byte(str(row, "body_text"))) != str(row, "text_hash") || str(d, "textHash") != str(row, "text_hash") {
		return unavailable("material-integrity-invalid"), nil
	}
	target, e := rowTarget(ctx, tx, row)
	if e != nil {
		return SourceState{}, e
	}
	intent := obj(target, "intent")
	if target == nil || target["revoked_at"] != nil || target["binding_revoked"] != nil || sec(target["binding_expires"]) <= s.now() || num(intent["expiresAt"]) <= s.now() || truth(obj(target, "snapshot")["contentDeleted"]) || str(target, "payload_text") == "" || str(intent, "payloadHash") != str(target, "payload_hash") {
		return unavailable("target-permission-unavailable"), nil
	}
	if target["case_id"] != nil {
		parent, e := rowCase(ctx, tx, target["case_id"])
		if e != nil {
			return SourceState{}, e
		}
		if parent == nil || str(parent, "state") == "withdrawn" {
			return unavailable("target-case-unavailable"), nil
		}
	}
	source, e := s.source(ctx, tx, obj(d, "source"), str(row, "subject_id"), lock)
	if e != nil {
		return SourceState{}, e
	}
	if !source.Available {
		return source, nil
	}
	selected, e := selection(source, obj(d, "source"))
	if e != nil {
		return SourceState{}, e
	}
	if identity.Digest([]byte(selected)) != str(obj(d, "source"), "selectionHash") {
		return unavailable("source-selection-changed"), nil
	}
	return SourceState{Available: true, Text: str(row, "body_text"), AvailableUntil: min(sec(row["expires_at"]), source.AvailableUntil, num(intent["expiresAt"]), sec(target["binding_expires"])), Reasons: []string{}}, nil
}
func rowTarget(ctx context.Context, tx pgx.Tx, m Object) (Object, error) {
	return row(ctx, tx, `SELECT to_jsonb(q) FROM (SELECT c.intent,c.revoked_at,b.revoked_at binding_revoked,b.expires_at binding_expires,e.payload_hash,e.payload_text,t.snapshot,t.case_id FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN task_events e ON e.id=$2 JOIN task_requests t ON t.id=e.task_id WHERE c.id=$1) q`, m["consent_id"], m["root_event_id"])
}
func rowCase(ctx context.Context, tx pgx.Tx, id any) (Object, error) {
	return row(ctx, tx, "SELECT to_jsonb(c) FROM cases c WHERE id=$1", id)
}
func (s *Service) ProjectText(request Object, resolved map[string]SourceState) Object {
	fields := Object{}
	for name, value := range textFields(request) {
		input := []any{}
		if literal, ok := value.(string); ok {
			input = append(input, Object{"kind": "literal", "text": literal})
		} else if v, ok := value.(map[string]any); ok {
			input = arr(v["segments"])
		}
		segments := []Object{}
		parts := []string{}
		until := []int64{}
		missing := 0
		for _, v := range input {
			segment, _ := v.(map[string]any)
			if str(segment, "kind") == "literal" {
				segments = append(segments, segment)
				parts = append(parts, str(segment, "text"))
				continue
			}
			id := str(segment, "materialId")
			current := resolved[id]
			if current.Available {
				segments = append(segments, Object{"kind": "material", "materialId": id, "status": "available", "text": current.Text})
				parts = append(parts, current.Text)
				until = append(until, current.AvailableUntil)
			} else {
				segments = append(segments, Object{"kind": "material", "materialId": id, "status": "unavailable"})
				missing++
			}
		}
		state := "available"
		if missing > 0 {
			state = "unavailable"
			if len(parts) > 0 {
				state = "partial"
			}
		}
		field := Object{"state": state, "text": strings.Join(parts, ""), "segments": segments, "checkedAt": s.now()}
		if len(until) > 0 {
			earliest := until[0]
			for _, v := range until {
				earliest = min(earliest, v)
			}
			field["availableUntil"] = earliest
		}
		fields[name] = field
	}
	return fields
}
func (s *Service) Status(ctx context.Context, a Actor, taskID string) (any, error) {
	if !validID(taskID) {
		return nil, fail("not_found", 404)
	}
	return s.run(ctx, a, "assistance", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		task, e := s.RequireTaskWithin(ctx, tx, &a.Actor, taskID, false)
		if e != nil {
			return nil, e
		}
		if str(task, "requesterId") != a.SubjectID {
			return nil, fail("not_found", 404)
		}
		materials, e := rows(ctx, tx, "SELECT to_jsonb(m) FROM task_materials_v1 m WHERE task_id=$1 ORDER BY material_id", taskID)
		if e != nil {
			return nil, e
		}
		items := []Object{}
		for _, m := range materials {
			state, e := s.StatusWithin(ctx, tx, m, true)
			if e != nil {
				return nil, e
			}
			status := "unavailable"
			if state.Available {
				status = "available"
			}
			item := Object{"materialId": m["material_id"], "descriptor": m["descriptor"], "status": status, "reasons": state.Reasons, "permanent": state.Permanent, "checkedAt": s.now()}
			if state.Available {
				item["availableUntil"] = state.AvailableUntil
			}
			items = append(items, item)
		}
		return Object{"taskId": taskID, "checkedAt": s.now(), "items": items}, nil
	})
}
func (s *Service) ProjectWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, task Object, selectedFields []string) (Object, error) {
	viewer := ""
	if a != nil {
		viewer = a.SubjectID
	}
	return s.projectViewerWithin(ctx, tx, viewer, task, selectedFields)
}
func (s *Service) projectViewerWithin(ctx context.Context, tx pgx.Tx, viewer string, task Object, selectedFields []string) (Object, error) {
	request := obj(obj(task, "snapshot"), "request")
	resolved := map[string]SourceState{}
	materials := []Object{}
	descriptors := []Object{}
	selected := map[string]bool{}
	if selectedFields != nil {
		fields := textFields(request)
		for _, field := range selectedFields {
			for _, id := range materialIDs(fields[field]) {
				selected[id] = true
			}
		}
	}
	for _, v := range arr(request["materials"]) {
		d, _ := v.(map[string]any)
		if selectedFields == nil || selected[str(d, "materialId")] {
			descriptors = append(descriptors, d)
		}
	}
	stored := []Object{}
	var e error
	if selectedFields == nil {
		stored, e = rows(ctx, tx, "SELECT to_jsonb(m) FROM task_materials_v1 m WHERE task_id=$1 ORDER BY material_id", task["id"])
	} else if len(descriptors) > 0 {
		ids := []string{}
		for _, d := range descriptors {
			ids = append(ids, str(d, "materialId"))
		}
		stored, e = rows(ctx, tx, "SELECT to_jsonb(m) FROM task_materials_v1 m WHERE task_id=$1 AND material_id=ANY($2::uuid[]) ORDER BY material_id", task["id"], ids)
	}
	if e != nil {
		return nil, e
	}
	for _, d := range descriptors {
		state := SourceState{}
		for _, m := range stored {
			if str(m, "material_id") == str(d, "materialId") && canonical(m["descriptor"]) == canonical(d) {
				state, e = s.StatusWithin(ctx, tx, m, true)
				if e != nil {
					return nil, e
				}
				break
			}
		}
		id := str(d, "materialId")
		resolved[id] = state
		item := Object{"locator": Object{"taskId": task["id"], "materialId": id}, "status": "unavailable", "checkedAt": s.now()}
		if state.Available {
			item["status"] = "available"
			item["text"] = state.Text
			item["availableUntil"] = state.AvailableUntil
		}
		materials = append(materials, item)
	}
	fields := s.ProjectText(request, resolved)
	if selectedFields != nil {
		projection := Object{}
		for _, name := range selectedFields {
			projection[name] = fields[name]
		}
		return Object{"textView": Object{"format": "task-text-view-v1", "checkedAt": s.now(), "fields": projection}}, nil
	}
	projected := Object{}
	for k, v := range request {
		projected[k] = v
	}
	work := Object{}
	for k, v := range obj(request, "workContext") {
		work[k] = v
	}
	projected["title"] = obj(fields, "title")["text"]
	projected["summary"] = obj(fields, "summary")["text"]
	work["goal"] = obj(fields, "goal")["text"]
	work["currentSituation"] = obj(fields, "currentSituation")["text"]
	projected["workContext"] = work
	if fields["expectedOutcome"] != nil {
		projected["expectedOutcome"] = obj(fields, "expectedOutcome")["text"]
	}
	delete(projected, "materials")
	original, e := row(ctx, tx, "SELECT jsonb_build_object('payload_hash',payload_hash,'payload_text',payload_text) FROM task_events WHERE id=$1", task["root_event_id"])
	if e != nil {
		return nil, e
	}
	if original == nil {
		return nil, fail("task_material_target_unavailable", 503)
	}
	result := Object{"request": projected, "textView": Object{"format": "task-text-view-v1", "checkedAt": s.now(), "fields": fields, "materials": materials}, "rootCommitment": Object{"eventId": task["root_event_id"], "payloadHash": original["payload_hash"], "representation": "task-text-v1"}}
	if viewer != "" && viewer == str(task, "requester_id") {
		var rootRequest Object
		if json.Unmarshal([]byte(str(original, "payload_text")), &rootRequest) != nil {
			return nil, fail("task_material_target_unavailable", 503)
		}
		result["rootRequest"] = rootRequest
	}
	return result, nil
}
