package maintenance

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/runtimelog"
	"math"
	"regexp"
	"strings"
	"time"
)

var tokenPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,99}$`)
var refPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,119}$`)
var componentCodes = []string{"maintenance_component_not_bound", "maintenance_component_process_unavailable", "maintenance_component_binding_invalid", "maintenance_component_response_invalid", "maintenance_component_unit_unavailable", "maintenance_health_not_connected", "maintenance_health_process_not_running", "maintenance_health_read_failed", "maintenance_health_response_invalid", "maintenance_health_source_ambiguous", "maintenance_health_sample_missing", "maintenance_health_sample_stale", "maintenance_health_scrape_failed"}

func nullableToken(v any) any {
	if tokenPattern.MatchString(str(v)) {
		return v
	}
	return nil
}
func nullableRef(v any) any {
	if refPattern.MatchString(str(v)) {
		return v
	}
	return nil
}
func number(v any) any {
	if whole(v, 0, 9007199254740991) {
		return num(v)
	}
	return nil
}
func Iso(v any) any {
	if v == nil {
		return nil
	}
	if t, ok := v.(time.Time); ok {
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	var ms float64
	numeric := true
	switch n := v.(type) {
	case float64:
		ms = n
	case int:
		ms = float64(n)
	case int64:
		ms = float64(n)
	case json.Number:
		var e error
		ms, e = n.Float64()
		if e != nil {
			return nil
		}
	case bool:
		if n {
			ms = 1
		}
	default:
		numeric = false
	}
	if numeric {
		if math.IsNaN(ms) || math.IsInf(ms, 0) || math.Abs(ms) > 8640000000000000 {
			return nil
		}
		return time.UnixMilli(int64(ms)).UTC().Format("2006-01-02T15:04:05.000Z")
	}
	s, ok := v.(string)
	if !ok {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02", "2006-01-02T15:04:05.999999999"} {
		if t, e := time.Parse(layout, s); e == nil {
			return t.UTC().Format("2006-01-02T15:04:05.000Z")
		}
	}
	return nil
}
func Availability(state string, code any) Object {
	if !includes([]string{"available", "unavailable", "not-configured", "partial"}, state) {
		state = "unavailable"
	}
	return Object{"state": state, "code": nullableToken(code)}
}
func componentUnavailable() Object {
	return Object{"state": "unavailable", "code": "maintenance_component_response_invalid"}
}
func componentAvailability(value any, present bool, fallback Object) Object {
	if !present {
		return fallback
	}
	v := obj(value)
	_, hasCode := v["code"]
	if v == nil || !hasCode || !includes([]string{"available", "unavailable", "not-configured"}, str(v["state"])) || v["state"] == "available" && v["code"] != nil || v["state"] != "available" && !includes(componentCodes, str(v["code"])) {
		return componentUnavailable()
	}
	return Object{"state": v["state"], "code": v["code"]}
}
func componentView(entry Object, input any) Object {
	raw, ok := list(input), array(input)
	matches := []Object{}
	if ok && len(raw) <= 64 {
		for _, v := range raw {
			r := obj(v)
			if r["id"] == entry["id"] {
				matches = append(matches, r)
			}
		}
	}
	var row Object
	if len(matches) == 1 {
		row = matches[0]
	}
	invalid := len(matches) > 1 || ok && len(raw) > 64
	processBasis := str(row["processBasis"])
	if !includes([]string{"systemd-process", "container-process", "static-site", "not-connected"}, processBasis) {
		processBasis = str(row["healthBasis"])
		if !includes([]string{"systemd-process", "container-process"}, processBasis) {
			processBasis = "not-connected"
		}
	}
	staticSite := entry["id"] == "website" && processBasis == "static-site"
	processState := str(row["processState"])
	if !includes([]string{"running", "stopped", "failed", "unknown"}, processState) && !(processState == "not-applicable" && staticSite) {
		processState = "unknown"
	}
	fallback := Object{"state": "not-configured", "code": "maintenance_component_not_bound"}
	if includes([]string{"running", "stopped", "failed"}, processState) {
		fallback = Object{"state": "available", "code": nil}
	}
	v, present := row["processAvailability"]
	processAvailability := componentAvailability(v, present, fallback)
	if invalid || row["processState"] == "not-applicable" && !staticSite || processBasis == "static-site" && (!staticSite || row["processState"] != "not-applicable") {
		processAvailability = componentUnavailable()
	}
	if processAvailability["state"] != "available" {
		processState = "unknown"
	}
	healthBasis := str(row["healthBasis"])
	if !includes([]string{"prometheus-target", "prometheus-probe", "container-healthcheck", "native-health-endpoint", "systemd-process", "container-process", "not-connected"}, healthBasis) {
		healthBasis = "not-connected"
	}
	fallback = Object{"state": "not-configured", "code": "maintenance_health_not_connected"}
	if includes([]string{"healthy", "unhealthy"}, str(row["health"])) {
		fallback = Object{"state": "available", "code": nil}
	}
	v, present = row["healthAvailability"]
	healthAvailability := componentAvailability(v, present, fallback)
	if invalid {
		healthAvailability = componentUnavailable()
	}
	health := str(row["health"])
	if !includes([]string{"healthy", "unhealthy", "unknown", "not-configured"}, health) {
		health = "unknown"
	}
	processAt := row["checkedAt"]
	if v, ok := row["processCheckedAt"]; ok {
		processAt = v
	}
	var healthAt any
	if v, ok := row["healthCheckedAt"]; ok {
		healthAt = v
	} else if includes([]string{"healthy", "unhealthy"}, health) {
		healthAt = row["checkedAt"]
	}
	processCheckedAt, healthCheckedAt := Iso(processAt), Iso(healthAt)
	if healthAvailability["state"] == "available" && (includes([]string{"not-connected", "systemd-process", "container-process"}, healthBasis) || includes([]string{"healthy", "unhealthy"}, health) && healthCheckedAt == nil || healthBasis == "prometheus-probe" && entry["id"] != "website" || healthBasis == "prometheus-target" && !includes([]string{"api", "worker"}, str(entry["id"]))) {
		healthAvailability = componentUnavailable()
	}
	if healthAvailability["state"] != "available" {
		health = "unknown"
	}
	out := clone(entry)
	for k, v := range (Object{"processState": processState, "processBasis": processBasis, "processAvailability": processAvailability, "health": health, "healthBasis": healthBasis, "healthAvailability": healthAvailability, "processCheckedAt": processCheckedAt, "healthCheckedAt": healthCheckedAt, "checkedAt": Iso(row["checkedAt"]), "code": nullableToken(row["code"])}) {
		out[k] = v
	}
	return out
}
func filtered(values any, pattern *regexp.Regexp) []any {
	out := []any{}
	for _, v := range list(values) {
		if pattern.MatchString(str(v)) {
			out = append(out, v)
		}
	}
	return out
}
func Coverage(input any) []any {
	rows := []any{}
	for _, v := range list(catalog()["maintenanceModules"]) {
		module := obj(v)
		var item Object
		for _, v := range list(input) {
			r := obj(v)
			if r["id"] == module["id"] {
				item = r
				break
			}
		}
		out := clone(module)
		state := str(item["state"])
		if !includes([]string{"covered", "uncovered", "unknown", "not-applicable"}, state) {
			state = "unknown"
		}
		var method any
		if includes([]string{"pgbackrest-cluster", "bounded-quiesced-volume", "selected-files", "rebuild-from-authoritative-source"}, str(item["method"])) {
			method = item["method"]
		}
		reason := filtered(item["reasonCodes"], tokenPattern)
		if !array(item["reasonCodes"]) {
			reason = []any{"maintenance_coverage_not_recorded"}
		}
		out["state"], out["method"], out["sourceIds"], out["postgresStanzas"], out["reasonCodes"], out["existenceAtOlderPoint"] = state, method, filtered(item["sourceIds"], refPattern), filtered(item["postgresStanzas"], refPattern), reason, "not-inferred"
		rows = append(rows, out)
	}
	return rows
}
func Point(input Object) Object {
	if !pointPattern.MatchString(str(input["id"])) {
		return nil
	}
	created := input["createdAt"]
	if created == nil {
		created = input["time"]
	}
	var captureID any
	if idPattern.MatchString(str(input["captureId"])) {
		captureID = input["captureId"]
	}
	integrity := obj(input["integrity"])
	integrityState := str(integrity["state"])
	if !includes([]string{"verified", "not-verified", "failed", "unknown"}, integrityState) {
		integrityState = "not-verified"
	}
	capture := obj(input["capture"])
	captureState := str(capture["state"])
	if !includes([]string{"available", "unavailable", "unknown"}, captureState) {
		captureState = "unknown"
	}
	var consistency any
	if capture["consistency"] == "named-pg-points-and-bounded-quiesced-files" {
		consistency = capture["consistency"]
	}
	production := obj(input["productionRestore"])
	blockers := filtered(production["blockers"], tokenPattern)
	if !array(production["blockers"]) {
		blockers = []any{"maintenance_production_restore_not_verified"}
	}
	return Object{"id": input["id"], "createdAt": Iso(created), "captureId": captureID, "logicalBytes": number(input["logicalBytes"]), "logicalFileCount": number(input["logicalFileCount"]), "sizeBasis": "native-snapshot-processed-data", "integrity": Object{"state": integrityState, "checkedAt": Iso(integrity["checkedAt"])}, "coverage": Coverage(input["coverage"]), "capture": Object{"state": captureState, "startedAt": Iso(capture["startedAt"]), "finishedAt": Iso(capture["finishedAt"]), "consistency": consistency}, "productionRestore": Object{"available": production["available"] == true, "blockers": blockers}}
}
func Overview(input Object) Object {
	components := []any{}
	for _, v := range list(catalog()["maintenanceComponents"]) {
		components = append(components, componentView(obj(v), input["components"]))
	}
	storage := []any{}
	objectRepository := false
	for _, v := range list(input["storage"]) {
		r := obj(v)
		id := str(r["id"])
		if !includes([]string{"host-filesystem", "backup-staging-filesystem", "object-repository"}, id) {
			continue
		}
		kind := "filesystem"
		if id == "object-repository" {
			kind = "object-repository"
			objectRepository = true
		}
		availability := obj(r["availability"])
		storage = append(storage, Object{"id": id, "kind": kind, "availability": Availability(str(availability["state"]), availability["code"]), "capacityBytes": number(r["capacityBytes"]), "availableBytes": number(r["availableBytes"]), "usedBytes": number(r["usedBytes"]), "physicalReclaimedBytes": nil, "observedAt": Iso(r["observedAt"])})
	}
	if !objectRepository {
		storage = append(storage, Object{"id": "object-repository", "kind": "object-repository", "availability": Availability("unavailable", "maintenance_object_usage_not_connected"), "capacityBytes": nil, "availableBytes": nil, "usedBytes": nil, "physicalReclaimedBytes": nil, "observedAt": nil})
	}
	errors := obj(input["errors"])
	errorAvailability := obj(errors["availability"])
	nativeAvailability := obj(input["availability"])
	return Object{"components": components, "storage": storage, "coverage": Coverage(input["coverage"]), "errors": Object{"availability": Availability(str(errorAvailability["state"]), errorAvailability["code"]), "window": "1h", "scope": "collected-runtime-records", "includesAllComponents": false, "count": number(errors["count"])}, "ai": Object{"state": "not-connected", "modelState": nil, "requiredForCodeExecution": false}, "nativeAvailability": Availability(str(nativeAvailability["state"]), nativeAvailability["code"])}
}
func BackupStatus(row Object) Object {
	if !includes([]string{"running", "succeeded", "failed", "unknown"}, str(row["outcome"])) {
		return nil
	}
	scope := "capture-only"
	if row["scope"] == "repository-integrity" {
		scope = "repository-integrity"
	}
	return Object{"outcome": row["outcome"], "startedAt": Iso(row["startedAt"]), "finishedAt": Iso(row["finishedAt"]), "lastSuccessAt": Iso(row["lastSuccessAt"]), "scope": scope}
}
func Policy(input Object) Object {
	retention, timer, repository := obj(input["retention"]), obj(input["timer"]), obj(input["repository"])
	var calendar any
	if s, ok := input["calendar"].(string); ok && protocol.TextLength(s) <= 100 && !strings.ContainsFunc(s, func(r rune) bool { return r <= 31 || r >= 127 && r <= 159 }) {
		calendar = s
	}
	timerState := str(timer["state"])
	if !includes([]string{"active", "inactive", "failed", "unknown"}, timerState) {
		timerState = "unknown"
	}
	var enabled, encrypted any
	if v, ok := timer["enabled"].(bool); ok {
		enabled = v
	}
	if v, ok := repository["encrypted"].(bool); ok {
		encrypted = v
	}
	location := str(repository["location"])
	if !includes([]string{"same-host", "off-host", "unknown"}, location) {
		location = "unknown"
	}
	return Object{"source": "existing-host-configuration", "calendar": calendar, "timer": Object{"state": timerState, "enabled": enabled, "nextAt": Iso(timer["nextAt"]), "lastAt": Iso(timer["lastAt"])}, "retention": Object{"daily": number(retention["daily"]), "weekly": number(retention["weekly"]), "monthly": number(retention["monthly"]), "source": "existing-configuration"}, "repository": Object{"location": location, "encrypted": encrypted}, "offHostPolicy": "undecided", "newPolicyValues": "not-selected", "writerPause": Object{"mode": "online-first-bounded-related-writers", "existingLimitSeconds": number(input["pauseLimitSeconds"])}, "lastCreate": BackupStatus(obj(input["lastCreate"])), "lastVerification": BackupStatus(obj(input["lastVerification"]))}
}
func Log(row Object) Object {
	if !includes([]string{"info", "warn", "error", "debug"}, str(row["level"])) {
		return nil
	}
	safe := runtimelog.Project(row)
	at := row["at"]
	if at == nil {
		at = row["time"]
	}
	var diagnostic, status, requestID, jobID, sqlState any
	if includes(texts(catalog()["maintenanceDiagnostics"]), str(row["diagnostic"])) {
		diagnostic = row["diagnostic"]
	}
	if whole(row["status"], 100, 599) {
		status = num(row["status"])
	}
	if idPattern.MatchString(str(row["requestId"])) {
		requestID = row["requestId"]
	}
	if idPattern.MatchString(str(row["jobId"])) {
		jobID = row["jobId"]
	}
	if regexp.MustCompile(`^[A-Z0-9]{5}$`).MatchString(str(row["sqlState"])) {
		sqlState = row["sqlState"]
	}
	return Object{"at": Iso(at), "component": nullableRef(row["component"]), "level": row["level"], "event": safe["event"], "diagnostic": diagnostic, "code": safe["code"], "status": status, "requestId": requestID, "jobId": jobID, "sqlState": sqlState, "detailsOmitted": true}
}

func SafeNativeOperation(row Object) Object {
	var id, kind, code, planState, activation any
	if uuidPattern.MatchString(str(row["id"])) {
		id = row["id"]
	}
	state := str(row["state"])
	if !includes([]string{"pending", "running", "succeeded", "failed", "unknown"}, state) {
		state = "unknown"
	}
	if includes([]string{"backup-create", "backup-verify", "restore-execute"}, str(row["kind"])) {
		kind = row["kind"]
	}
	if regexp.MustCompile(`^maintenance_[a-z_]{1,80}$`).MatchString(str(row["code"])) {
		code = row["code"]
	}
	if includes([]string{"preparing", "restoring", "validating", "ready-to-open", "opening", "completed", "failed"}, str(row["planState"])) {
		planState = row["planState"]
	}
	if v, ok := row["publicActivation"].(bool); ok {
		activation = v
	}
	steps := []any{}
	raw := list(row["steps"])
	if len(raw) > 100 {
		raw = raw[:100]
	}
	for _, v := range raw {
		r := obj(v)
		var id any
		if regexp.MustCompile(`^[a-z][a-z0-9-]{0,99}$`).MatchString(str(r["id"])) {
			id = r["id"]
		}
		state := str(r["state"])
		if !includes([]string{"running", "succeeded", "failed", "unknown", "blocked"}, state) {
			state = "unknown"
		}
		steps = append(steps, Object{"id": id, "state": state, "startedAt": Iso(r["startedAt"]), "finishedAt": Iso(r["finishedAt"])})
	}
	return Object{"id": id, "state": state, "kind": kind, "startedAt": Iso(row["startedAt"]), "finishedAt": Iso(row["finishedAt"]), "code": code, "planState": planState, "publicActivation": activation, "steps": steps}
}
func PlanProjection(row Object) Object {
	plan := obj(row["plan"])
	modules := []any{}
	for _, v := range Coverage(plan["modules"]) {
		r := obj(v)
		if !includes(texts(plan["moduleIds"]), str(r["id"])) {
			continue
		}
		basis := "selected-recovery-point"
		switch r["id"] {
		case "accounts":
			basis = "current-security-authority"
		case "business":
			basis = "point-with-current-permissions"
		case "configuration":
			basis = "point-with-current-keys"
		}
		r["restoreBasis"] = basis
		modules = append(modules, r)
	}
	ids := []any{}
	for _, v := range modules {
		ids = append(ids, obj(v)["id"])
	}
	var scope any
	if includes([]string{"whole-site", "selected-modules"}, str(plan["scope"])) {
		scope = plan["scope"]
	}
	preserved := Object{"state": "not-recorded", "items": []any{}, "basis": nil}
	if obj(plan["preservedCurrent"])["state"] == "declared" && sameValues(obj(plan["preservedCurrent"])["items"], []any{"accounts", "passwords", "current-permissions", "keys"}) {
		preserved = Object{"state": "declared", "items": []any{"accounts", "passwords", "current-permissions", "keys"}, "basis": "current-security-authority"}
	}
	loss := obj(plan["possibleLoss"])
	basis := "unknown"
	if loss["basis"] == "point-to-plan-time" {
		basis = "point-to-plan-time"
	}
	conditions := []any{}
	for _, id := range OpeningConditions() {
		state := "required"
		for _, v := range list(plan["openingConditions"]) {
			r := obj(v)
			if r["id"] == id {
				if r["state"] == "ready" {
					state = "ready"
				}
				break
			}
		}
		conditions = append(conditions, Object{"id": id, "state": state})
	}
	var approval any
	if row["approved_by"] != nil && row["approved_by"] != "" {
		approval = Object{"operatorId": row["approved_by"], "at": Iso(row["approved_at"]), "revision": row["approved_revision"]}
	}
	activation := "not-opened"
	if row["state"] == "completed" {
		activation = "recorded-by-approved-executor"
	} else if row["execution_id"] != nil && row["execution_id"] != "" {
		activation = "unknown"
	}
	return Object{"id": row["id"], "revision": row["revision"], "state": row["state"], "point": Point(obj(plan["point"])), "scope": scope, "moduleIds": ids, "modules": modules, "planDigest": row["plan_digest"], "preservedCurrent": preserved, "possibleLoss": Object{"from": Iso(loss["from"]), "observedAt": Iso(loss["to"]), "observedWindowSeconds": number(loss["observedWindowSeconds"]), "maximumSeconds": nil, "through": "related-writer-pause", "basis": basis, "externalDeliveries": "cannot-be-retracted", "unconfirmedSubmissions": "must-not-be-blindly-retried"}, "openingConditions": conditions, "blockers": filtered(plan["blockers"], tokenPattern), "approval": approval, "executionId": row["execution_id"], "createdAt": Iso(row["created_at"]), "updatedAt": Iso(row["updated_at"]), "productionActivation": activation}
}
