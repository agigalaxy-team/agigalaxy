package native

import (
	"context"
	"encoding/json"
	"math"
	"path/filepath"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/google/uuid"
)

func integrationID(prefix string) string {
	return prefix + "_" + strings.ReplaceAll(uuid.NewString(), "-", "")
}
func integrationSnapshotWithin(dir string) (map[string]any, error) {
	snapshot, e := localSnapshotWithin(dir)
	if e != nil || snapshot["recoveryRequired"] == true {
		return snapshot, e
	}
	var raw json.RawMessage
	if e = readFallback(dir, "galaxy-local-state.json", "local-state.json", &raw); e != nil {
		return nil, e
	}
	if len(raw) > 0 && string(raw) != "null" {
		value, e := jstext.DecodeJSON(raw)
		if e != nil {
			return nil, e
		}
		state, ok := value.(map[string]any)
		if !ok {
			return nil, connectionFailure("native_local_state_invalid")
		}
		snapshot["state"] = initializationNormalize(state)
	}
	return snapshot, nil
}
func integrationUnits(value any) (jstext.String, bool) {
	switch v := value.(type) {
	case string:
		return jstext.From(v), true
	case jstext.String:
		return v, true
	}
	return nil, false
}
func integrationText(value any, max int) (any, error) {
	units, ok := integrationUnits(value)
	units = units.Trim()
	if !ok || len(units) == 0 || len(units) > max {
		return nil, connectionFailure("local_integration_input_invalid")
	}
	if units.HasUnpaired() {
		return units, nil
	}
	return units.Decoded(), nil
}
func integrationRequired(state map[string]any, collection, id string) (map[string]any, error) {
	for _, v := range uploadRows(state[collection]) {
		row := uploadObject(v)
		if row["id"] == id {
			return row, nil
		}
	}
	return nil, connectionFailure("local_integration_record_not_found")
}
func integrationModules(snapshot map[string]any, required ...string) error {
	if snapshot["recoveryRequired"] == true {
		return connectionFailure("local_recovery_required")
	}
	integration := uploadObject(uploadObject(snapshot["state"])["integration"])
	if integration == nil {
		return connectionFailure("local_integration_not_initialized")
	}
	enabled := map[string]bool{}
	for _, v := range uploadRows(integration["modules"]) {
		enabled[text(uploadObject(v)["id"])] = true
	}
	for _, id := range required {
		if !enabled[id] {
			return connectionFailure("local_integration_module_not_enabled")
		}
	}
	return nil
}
func (s *Store) IntegrationDrafts(ctx context.Context, limit int) (map[string]any, error) {
	if limit == 0 {
		limit = 20
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}
	var snapshot map[string]any
	e := s.With(ctx, false, func(dir string) error { var e error; snapshot, e = integrationSnapshotWithin(dir); return e })
	if e != nil {
		return nil, e
	}
	if e = integrationModules(snapshot, "case-workspace"); e != nil {
		return nil, e
	}
	state := uploadObject(snapshot["state"])
	out := map[string]any{"galaxyId": snapshot["identity"], "recoveryRequired": snapshot["recoveryRequired"] == true}
	for _, key := range []string{"cases", "disclosurePlans", "consentGrants", "localProofDrafts", "auditEvents"} {
		values := uploadRows(state[key])
		items := []any{}
		for i := len(values) - 1; i >= 0 && len(items) < limit; i-- {
			items = append(items, values[i])
		}
		out[key] = items
	}
	return out, nil
}
func (s *Store) integrationMutation(ctx context.Context, expected *ChoiceScope, module string, mutate func(map[string]any, map[string]any) (any, error)) (any, error) {
	var out any
	e := s.With(ctx, true, func(dir string) error {
		if e := s.verifyChoiceWithin(dir, expected); e != nil {
			return e
		}
		snapshot, e := integrationSnapshotWithin(dir)
		if e != nil {
			return e
		}
		if e = integrationModules(snapshot, module); e != nil {
			return e
		}
		identity := uploadObject(snapshot["identity"])
		if identity == nil {
			return connectionFailure("local_identity_required")
		}
		if e = initializationMigrate(dir); e != nil {
			return e
		}
		state := uploadObject(snapshot["state"])
		out, e = mutate(state, identity)
		if e != nil {
			return e
		}
		return writeJSON(filepath.Join(dir, "galaxy-local-state.json"), state)
	})
	return out, e
}

var integrationForbidden = []string{"secrets", "env", "tokens", "credentials", "unselected_source"}

func (s *Store) IntegrationCase(ctx context.Context, input map[string]any, expected *ChoiceScope) (any, error) {
	title, e := integrationText(input["title"], 120)
	if e != nil {
		return nil, e
	}
	summary, e := integrationText(input["failureSummary"], 1200)
	if e != nil {
		return nil, e
	}
	approaches := []any{}
	for _, v := range uploadRows(input["attemptedApproaches"]) {
		units, ok := integrationUnits(v)
		units = units.Trim()
		if !ok || len(units) == 0 {
			continue
		}
		if len(units) > 240 {
			units = units[:240]
		}
		var item any = units.Decoded()
		if units.HasUnpaired() {
			item = units
		}
		approaches = append(approaches, item)
		if len(approaches) == 8 {
			break
		}
	}
	return s.integrationMutation(ctx, expected, "case-workspace", func(state, identity map[string]any) (any, error) {
		at := localNow()
		row := map[string]any{"id": integrationID("case"), "galaxyId": identity["id"], "title": title, "failureSummary": summary, "attemptedApproaches": approaches, "status": "draft", "createdAt": at, "updatedAt": at, "localOnly": true}
		state["cases"] = append(uploadRows(state["cases"]), row)
		initializationAudit(state, "case.draft_created", text(row["id"]), at, map[string]any{"galaxyId": identity["id"]})
		return row, nil
	})
}
func (s *Store) IntegrationDisclosure(ctx context.Context, input map[string]any, expected *ChoiceScope) (any, error) {
	recipient := input["recipient"]
	if recipient == nil || recipient == "" {
		recipient = "selected-future-resolver"
	}
	purpose := input["purpose"]
	if purpose == nil || purpose == "" {
		purpose = "private AI Coding review"
	}
	recipient, e := integrationText(recipient, 100)
	if e != nil {
		return nil, e
	}
	purpose, e = integrationText(purpose, 160)
	if e != nil {
		return nil, e
	}
	hours := integrationDisclosureHours(input["expiresInHours"])
	include := []any{}
	seen := map[string]bool{}
	requested := uploadRows(input["include"])
	if len(requested) == 0 {
		requested = []any{"failure_summary", "attempt_metadata"}
	}
	for _, v := range requested {
		id := text(v)
		if isOne(id, "failure_summary", "attempt_metadata", "verification_note") && !seen[id] {
			include = append(include, id)
			seen[id] = true
		}
	}
	if len(include) == 0 {
		return nil, connectionFailure("local_integration_input_invalid")
	}
	return s.integrationMutation(ctx, expected, "consent-controls", func(state, _ map[string]any) (any, error) {
		draft, e := integrationRequired(state, "cases", text(input["caseId"]))
		if e != nil {
			return nil, e
		}
		at := localNow()
		row := map[string]any{"id": integrationID("disclosure"), "caseId": draft["id"], "recipient": recipient, "purpose": purpose, "include": include, "exclude": integrationForbidden, "createdAt": at, "expiresAt": time.Now().Add(time.Duration(hours) * time.Hour).UTC().Format("2006-01-02T15:04:05.000Z"), "transport": "not-configured", "status": "preview", "localOnly": true, "summary": "This preview does not send any Case content or create a public record."}
		state["disclosurePlans"] = append(uploadRows(state["disclosurePlans"]), row)
		initializationAudit(state, "disclosure.preview_created", text(row["id"]), at, map[string]any{"caseId": draft["id"], "recipient": recipient})
		return row, nil
	})
}

// The local application accepts only finite numeric hours, truncates them,
// and bounds them to the original one-hour through thirty-day interval.
func integrationDisclosureHours(value any) int64 {
	var number float64
	switch v := value.(type) {
	case json.Number:
		var e error
		number, e = v.Float64()
		if e != nil {
			return 24
		}
	case float64:
		number = v
	case int:
		number = float64(v)
	case int64:
		number = float64(v)
	default:
		return 24
	}
	if math.IsNaN(number) || math.IsInf(number, 0) {
		return 24
	}
	return int64(math.Min(math.Max(math.Trunc(number), 1), 720))
}
func integrationExpired(value any) bool {
	at, e := time.Parse(time.RFC3339Nano, text(value))
	return e == nil && !at.After(time.Now())
}
func (s *Store) IntegrationConfirmProof(ctx context.Context, input map[string]any, expected *ChoiceScope) (any, error) {
	// Preserve the original two separate commits: granting succeeds before the
	// later proof validation. A proof failure must not silently roll back its
	// already issued local Consent receipt.
	grant, e := s.integrationMutation(ctx, expected, "consent-controls", func(state, _ map[string]any) (any, error) {
		plan, e := integrationRequired(state, "disclosurePlans", text(input["disclosurePlanId"]))
		if e != nil {
			return nil, e
		}
		if integrationExpired(plan["expiresAt"]) {
			return nil, connectionFailure("local_disclosure_expired")
		}
		at := localNow()
		row := map[string]any{"id": integrationID("grant"), "disclosurePlanId": plan["id"], "caseId": plan["caseId"], "recipient": plan["recipient"], "purpose": plan["purpose"], "include": plan["include"], "exclude": plan["exclude"], "issuedAt": at, "expiresAt": plan["expiresAt"], "status": "active", "localOnly": true, "note": "This is a local Consent Grant receipt. No data transfer has occurred."}
		state["consentGrants"] = append(uploadRows(state["consentGrants"]), row)
		plan["status"] = "confirmed"
		initializationAudit(state, "consent.granted", text(row["id"]), at, map[string]any{"disclosurePlanId": plan["id"], "caseId": plan["caseId"]})
		return row, nil
	})
	if e != nil {
		return nil, e
	}
	consent := uploadObject(grant)
	note, e := integrationText(input["verificationNote"], 800)
	if e != nil {
		return nil, e
	}
	proof, e := s.integrationMutation(ctx, expected, "consent-controls", func(state, identity map[string]any) (any, error) {
		draft, e := integrationRequired(state, "cases", text(input["caseId"]))
		if e != nil {
			return nil, e
		}
		current, e := integrationRequired(state, "consentGrants", text(consent["id"]))
		if e != nil {
			return nil, e
		}
		if current["caseId"] != draft["id"] {
			return nil, connectionFailure("local_consent_case_mismatch")
		}
		if current["status"] != "active" {
			return nil, connectionFailure("local_consent_inactive")
		}
		if integrationExpired(current["expiresAt"]) {
			return nil, connectionFailure("local_consent_expired")
		}
		at := localNow()
		row := map[string]any{"id": integrationID("proof"), "caseId": draft["id"], "galaxyId": identity["id"], "consentGrantId": current["id"], "verificationNote": note, "visibility": "local-only", "status": "draft", "createdAt": at, "limitations": []string{"No remote recipient received data.", "No third-party verification occurred.", "This draft is not public Evidence or a Track Record entry."}}
		state["localProofDrafts"] = append(uploadRows(state["localProofDrafts"]), row)
		draft["status"] = "local-proof-draft"
		draft["updatedAt"] = at
		initializationAudit(state, "proof.local_draft_created", text(row["id"]), at, map[string]any{"caseId": draft["id"], "consentGrantId": current["id"]})
		return row, nil
	})
	if e != nil {
		return nil, e
	}
	return map[string]any{"consentGrant": grant, "localProofDraft": proof}, nil
}
func (s *Store) IntegrationRevoke(ctx context.Context, id string, expected *ChoiceScope) (any, error) {
	return s.integrationMutation(ctx, expected, "consent-controls", func(state, _ map[string]any) (any, error) {
		grant, e := integrationRequired(state, "consentGrants", id)
		if e != nil {
			return nil, e
		}
		if grant["status"] == "revoked" {
			return grant, nil
		}
		at := localNow()
		grant["status"] = "revoked"
		grant["revokedAt"] = at
		initializationAudit(state, "consent.revoked", id, at, map[string]any{"caseId": grant["caseId"]})
		return grant, nil
	})
}
