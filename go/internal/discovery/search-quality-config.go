package discovery

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func parseQualityInput(kind string, input Object) (Object, error) {
	fields := []string{"operationId", "expectedRevision", "reason", "versionId"}
	if kind == "draft" || kind == "prepared-draft" {
		fields[3] = "settings"
		if kind == "prepared-draft" {
			fields = append(fields, "expectedDraftId")
		}
	} else if kind != "apply" && kind != "restore" {
		return nil, settingsInvalid()
	}
	if !onlyKeys(input, fields...) || !validID(str(input, "operationId")) {
		return nil, settingsInvalid()
	}
	revision, ok := integer(input["expectedRevision"])
	reason, reasonOK := input["reason"].(string)
	reason = strings.TrimFunc(reason, jsSpace)
	if !ok || revision < 0 || revision > 2147483646 || !reasonOK || codePointLength(reason) < 1 || codePointLength(reason) > 500 {
		return nil, settingsInvalid()
	}
	out := Object{"operationId": strings.ToLower(str(input, "operationId")), "expectedRevision": revision, "reason": reason}
	if kind == "prepared-draft" {
		id, exists := input["expectedDraftId"]
		if !exists || id != nil && !validID(str(input, "expectedDraftId")) {
			return nil, settingsInvalid()
		}
		if id != nil {
			id = strings.ToLower(str(input, "expectedDraftId"))
		}
		out["expectedDraftId"] = id
	}
	if kind != "draft" && kind != "prepared-draft" {
		if !validID(str(input, "versionId")) {
			return nil, settingsInvalid()
		}
		out["versionId"] = strings.ToLower(str(input, "versionId"))
		return out, nil
	}
	settings := object(input["settings"])
	if _, e := canonicalSettings(settings); e != nil {
		return nil, e
	}
	rows := []any{}
	for _, value := range settings["synonyms"].([]any) {
		row := object(value)
		alternatives, _ := stringArray(row["alternatives"])
		for i, word := range alternatives {
			alternatives[i] = normalizeTerm(strings.TrimFunc(word, jsSpace))
		}
		rows = append(rows, Object{"term": normalizeTerm(strings.TrimFunc(str(row, "term"), jsSpace)), "alternatives": alternatives})
	}
	out["settings"] = Object{"synonyms": rows, "rankingMode": settings["rankingMode"], "fixedConstraints": fixedConstraints}
	return out, nil
}
func qualityAction(kind string) string {
	switch kind {
	case "draft":
		return "search-quality.configure"
	case "apply":
		return "search-quality.publish"
	default:
		return "search-quality.restore"
	}
}
func (q *SearchQuality) insertVersion(ctx context.Context, tx pgx.Tx, row Object) error {
	var settings any
	if row["settings"] != nil {
		settings = jsonString(row["settings"])
	}
	_, e := tx.Exec(ctx, `INSERT INTO operations_search_quality_versions_v1(id,endpoint,version,settings,native_settings,kind,restored_from,operator_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, row["id"], q.Endpoint, row["version"], settings, jsonString(row["native_settings"]), row["kind"], row["restored_from"], row["operator_id"], row["created_at"])
	return e
}
func qualityChanges(before, after Object) Object {
	out := Object{}
	for _, key := range []string{"synonyms", "rankingMode"} {
		a, b := before[key], after[key]
		if !sameValue(a, b) {
			out[key] = Object{"before": a, "after": b}
		}
	}
	return out
}
func (q *SearchQuality) prepare(ctx context.Context, actor Actor, kind string, input Object) (Object, bool, error) {
	action := qualityAction(kind)
	if _, e := q.authorize(ctx, actor, action); e != nil {
		return nil, false, e
	}
	existing, e := q.operation(ctx, q.Pool, str(input, "operationId"))
	if e != nil {
		return nil, false, e
	}
	canonical, e := identity.Canonical(Object{"kind": kind, "input": input})
	if e != nil {
		return nil, false, e
	}
	digest := sha256.Sum256(canonical)
	hash := hex.EncodeToString(digest[:])
	checkPrior := func(prior Object) (Object, bool, error) {
		if str(prior, "operator_id") != actor.ID || str(prior, "request_hash") != hash {
			return nil, false, qualityFailure("search_quality_operation_conflict")
		}
		return prior, true, nil
	}
	if existing != nil {
		return checkPrior(existing)
	}
	previous, e := q.state(ctx, q.Pool)
	if e != nil {
		return nil, false, e
	}
	activeVersion, e := q.version(ctx, q.Pool, str(previous, "active_id"))
	if e != nil {
		return nil, false, e
	}
	var native Object
	if kind == "draft" && activeVersion != nil {
		native = object(activeVersion["native_settings"])
	} else {
		native, e = q.observedSettings(ctx)
		if e != nil {
			return nil, false, e
		}
	}
	watermark := int64(-1)
	if kind != "draft" {
		tasks, e := q.Meili.SettingsTasks(ctx, -1, 1, false)
		if e != nil {
			return nil, false, e
		}
		if len(tasks.Items) > 0 {
			watermark = tasks.Items[0].ID
		}
		pending, e := q.Meili.SettingsTasks(ctx, -1, 1, true)
		if e != nil {
			return nil, false, e
		}
		if len(pending.Items) > 0 {
			return nil, false, qualityFailure("search_quality_native_busy")
		}
	}
	tx, e := q.Pool.Begin(ctx)
	if e != nil {
		return nil, false, e
	}
	defer tx.Rollback(context.Background())
	if e = q.lock(ctx, tx); e != nil {
		return nil, false, e
	}
	fresh, e := q.require(ctx, tx, actor, action)
	if e != nil {
		return nil, false, e
	}
	if q.Authority.Duty != nil && q.Authority.Duty.AcceptsDuty(fresh) {
		selection := Object{"operationId": input["operationId"], "command": input}
		if kind == "draft" {
			selection["id"] = input["expectedDraftId"]
			if selection["id"] == nil {
				selection["id"] = input["operationId"]
			}
		}
		if input["versionId"] != nil {
			selection["id"] = input["versionId"]
		}
		if fresh, e = q.Authority.RequireOperationWithin(ctx, tx, fresh, []string{action}, selection, action); e != nil {
			return nil, false, e
		}
	}
	prior, e := q.operation(ctx, tx, str(input, "operationId"))
	if e != nil {
		return nil, false, e
	}
	if prior != nil {
		return checkPrior(prior)
	}
	state, e := q.state(ctx, tx)
	if e != nil {
		return nil, false, e
	}
	if number(state, "revision") != number(input, "expectedRevision") {
		return nil, false, qualityFailure("search_quality_revision_changed")
	}
	if state["pending_operation"] != nil {
		return nil, false, qualityFailure("search_quality_operation_pending")
	}
	if kind == "draft" {
		if expected, bound := input["expectedDraftId"]; bound {
			if state["draft_id"] != expected {
				return nil, false, qualityFailure("search_quality_draft_changed")
			}
			if expected != nil {
				draft, e := q.version(ctx, tx, str(state, "draft_id"))
				if e != nil {
					return nil, false, e
				}
				if draft == nil || draft["operator_id"] != fresh.ID {
					return nil, false, qualityFailure("search_quality_draft_changed")
				}
			}
		}
	}
	at := q.now()
	if _, e = tx.Exec(ctx, "INSERT INTO operations_search_quality_state_v1(endpoint,updated_at) VALUES($1,$2) ON CONFLICT DO NOTHING", q.Endpoint, at); e != nil {
		return nil, false, e
	}
	active, e := q.version(ctx, tx, str(state, "active_id"))
	if e != nil {
		return nil, false, e
	}
	if active == nil {
		active = Object{"id": uuid.NewString(), "version": int64(0), "settings": editableSettings(native), "native_settings": native, "kind": "baseline", "restored_from": nil, "operator_id": fresh.ID, "created_at": at}
		if e = q.insertVersion(ctx, tx, active); e != nil {
			return nil, false, e
		}
		state["active_id"] = active["id"]
	}
	var target Object
	if kind == "draft" {
		var highest int64
		if e = tx.QueryRow(ctx, "SELECT max(version)::integer FROM operations_search_quality_versions_v1 WHERE endpoint=$1", q.Endpoint).Scan(&highest); e != nil {
			return nil, false, e
		}
		settings, e := canonicalSettings(object(input["settings"]))
		if e != nil {
			return nil, false, e
		}
		target = Object{"id": uuid.NewString(), "version": highest + 1, "settings": settings, "native_settings": nativeSettings(settings), "kind": "draft", "restored_from": nil, "operator_id": fresh.ID, "created_at": at}
		if e = q.insertVersion(ctx, tx, target); e != nil {
			return nil, false, e
		}
	} else {
		selected, e := q.version(ctx, tx, str(input, "versionId"))
		if e != nil {
			return nil, false, e
		}
		if selected == nil {
			return nil, false, qualityFailure("search_quality_version_unavailable", 404)
		}
		if kind == "apply" && state["draft_id"] != selected["id"] {
			return nil, false, qualityFailure("search_quality_draft_changed")
		}
		if kind == "restore" && str(selected, "kind") != "baseline" && selected["was_applied"] != true {
			return nil, false, qualityFailure("search_quality_version_not_applied")
		}
		if !sameNative(native, object(active["native_settings"])) {
			return nil, false, qualityFailure("search_quality_native_drift")
		}
		target = selected
		if kind == "restore" {
			var highest int64
			if e = tx.QueryRow(ctx, "SELECT max(version)::integer FROM operations_search_quality_versions_v1 WHERE endpoint=$1", q.Endpoint).Scan(&highest); e != nil {
				return nil, false, e
			}
			target = merge(Object{}, selected)
			target["id"] = uuid.NewString()
			target["version"] = highest + 1
			target["kind"] = "restore"
			target["restored_from"] = selected["id"]
			target["operator_id"] = fresh.ID
			target["created_at"] = at
			if e = q.insertVersion(ctx, tx, target); e != nil {
				return nil, false, e
			}
		}
	}
	before := active
	if kind == "draft" {
		draft, e := q.version(ctx, tx, str(state, "draft_id"))
		if e != nil {
			return nil, false, e
		}
		if draft != nil {
			before = draft
		}
	}
	delta := qualityChanges(object(before["settings"]), object(target["settings"]))
	phase := "prepared"
	draftID, pendingID := state["draft_id"], input["operationId"]
	if kind == "draft" {
		phase = "applied"
		draftID = target["id"]
		pendingID = nil
	}
	row, e := rowObject(ctx, tx, `INSERT INTO operations_search_quality_operations_v1(endpoint,operation_id,operator_id,kind,request_hash,input,version_id,phase,native_watermark,changes,reason,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING to_jsonb(operations_search_quality_operations_v1)`, q.Endpoint, input["operationId"], fresh.ID, kind, hash, jsonString(input), target["id"], phase, watermark, jsonString(delta), input["reason"], at)
	if e != nil {
		return nil, false, e
	}
	if _, e = tx.Exec(ctx, `UPDATE operations_search_quality_state_v1 SET revision=revision+1,active_id=$2,draft_id=$3,pending_operation=$4,updated_at=$5 WHERE endpoint=$1`, q.Endpoint, state["active_id"], draftID, pendingID, at); e != nil {
		return nil, false, e
	}
	if _, e = q.require(ctx, tx, fresh, action); e != nil {
		return nil, false, e
	}
	if e = q.record(ctx, tx, fresh, action, str(input, "operationId"), number(target, "version")); e != nil {
		return nil, false, e
	}
	return row, false, tx.Commit(ctx)
}
