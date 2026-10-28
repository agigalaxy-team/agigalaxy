package operationsmodels

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"sort"
)

func pending(phase any) bool {
	return has([]string{"prepared", "submitting", "pending", "result-unknown"}, str(phase))
}
func nativeCode(e error) string {
	code := fault.Code(e)
	if nativeCodePattern.MatchString(code) {
		return code
	}
	return "model_settings_native_unavailable"
}
func (s *Service) advance(ctx context.Context, row Object, phase string, errorCode, credentialRef any) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := s.lock(ctx, tx); e != nil {
			return nil, e
		}
		current, e := s.operation(ctx, tx, row["operation_id"])
		if e != nil || current == nil || !pending(current["phase"]) {
			return current, e
		}
		next, e := one(ctx, tx, `UPDATE operations_model_settings_operations_v1 SET phase=$3,error_code=$4,credential_ref=coalesce($5,credential_ref),updated_at=$6 WHERE endpoint=$1 AND operation_id=$2 RETURNING to_jsonb(operations_model_settings_operations_v1)`, s.Endpoint, row["operation_id"], phase, errorCode, credentialRef, s.now())
		if e != nil {
			return nil, e
		}
		if row["kind"] == "apply" && has([]string{"applied", "failed"}, phase) {
			_, e = tx.Exec(ctx, `UPDATE operations_model_settings_state_v1 SET active_id=CASE WHEN $3 THEN $4 ELSE active_id END,pending_operation=NULL,revision=revision+1,updated_at=$5 WHERE endpoint=$1 AND pending_operation=$2`, s.Endpoint, row["operation_id"], phase == "applied", row["version_id"], s.now())
			if e != nil {
				return nil, e
			}
		}
		return next, nil
	})
}
func (s *Service) acceptNative(ctx context.Context, row, value Object) (Object, error) {
	raw := value
	if value["operation"] != nil {
		raw = obj(value["operation"])
	}
	operation, e := ProjectOperation(raw)
	if e != nil {
		return nil, e
	}
	expected := "models-credential-provision"
	if row["kind"] == "apply" {
		expected = "models-apply"
	}
	if operation["id"] != row["operation_id"] || operation["kind"] != expected {
		return nil, responseInvalid()
	}
	switch operation["state"] {
	case "failed":
		code := operation["code"]
		if code == nil {
			code = "model_settings_native_failed"
		}
		return s.advance(ctx, row, "failed", code, nil)
	case "unknown":
		code := operation["code"]
		if code == nil {
			code = "model_settings_native_result_unknown"
		}
		return s.advance(ctx, row, "result-unknown", code, nil)
	}
	if operation["state"] != "completed" {
		return s.advance(ctx, row, "pending", nil, nil)
	}
	status, e := s.nativeStatus(ctx)
	if e != nil {
		return nil, e
	}
	if obj(status["availability"])["state"] != "available" {
		return s.advance(ctx, row, "result-unknown", "model_settings_native_unavailable", nil)
	}
	if row["kind"] == "credential-provision" {
		ref := "model-key:" + str(row["operation_id"])
		found := false
		for _, v := range list(status["credentials"]) {
			c := obj(v)
			found = found || c["reference"] == ref && c["modelRecordId"] == obj(row["input"])["modelRecordId"] && c["configured"] == true
		}
		if operation["credentialRef"] != ref || !found {
			return s.advance(ctx, row, "result-unknown", "model_settings_native_readback_mismatch", nil)
		}
		return s.advance(ctx, row, "applied", nil, ref)
	}
	selected, e := s.version(ctx, s.Pool, row["version_id"])
	if e != nil {
		return nil, e
	}
	configuration := obj(selected["configuration"])
	scenarios := []string{}
	for _, d := range Domains {
		if obj(configuration["scenarios"])[d] != nil {
			scenarios = append(scenarios, d)
		}
	}
	sort.Strings(scenarios)
	engines := obj(status["engines"])
	gateway, agent := obj(engines["gateway"]), obj(engines["agentos"])
	actual := []string{}
	for _, v := range list(agent["configuredScenarios"]) {
		actual = append(actual, str(v))
	}
	sort.Strings(actual)
	count := 0
	for _, v := range list(configuration["models"]) {
		if obj(v)["enabled"] == true {
			count++
		}
	}
	if status["appliedVersionId"] != row["version_id"] || status["configurationVersion"] == nil || gateway["configurationVersion"] != status["configurationVersion"] || agent["configurationVersion"] != status["configurationVersion"] || has([]string{"unknown", "unavailable"}, str(gateway["state"])) || has([]string{"unknown", "unavailable"}, str(agent["state"])) || gateway["modelCount"] == nil || num(gateway["modelCount"]) != int64(count) || !same(actual, scenarios) {
		return s.advance(ctx, row, "result-unknown", "model_settings_native_readback_mismatch", nil)
	}
	return s.advance(ctx, row, "applied", nil, nil)
}
func (s *Service) submit(ctx context.Context, a Actor, row, input Object, authorize func() (Actor, error)) (Object, error) {
	action := "models.configure"
	if row["kind"] == "apply" {
		action = "models.apply"
	}
	if _, e := s.fresh(ctx, nil, a, action, authorize); e != nil {
		return nil, e
	}
	claimed, e := one(ctx, s.Pool, `UPDATE operations_model_settings_operations_v1 SET phase='submitting',updated_at=$3 WHERE endpoint=$1 AND operation_id=$2 AND phase='prepared' RETURNING to_jsonb(operations_model_settings_operations_v1)`, s.Endpoint, row["operation_id"], s.now())
	if e != nil {
		return nil, e
	}
	if claimed == nil {
		return s.reconcile(ctx, str(row["operation_id"]))
	}
	if _, e = s.fresh(ctx, nil, a, action, authorize); e != nil {
		_, _ = s.advance(ctx, claimed, "failed", "model_settings_permission_denied", nil)
		return nil, e
	}
	var command Object
	if row["kind"] == "apply" {
		version, e := s.version(ctx, s.Pool, row["version_id"])
		if e != nil {
			return nil, e
		}
		command = Object{"kind": "models-apply", "operationId": row["operation_id"], "operatorId": row["operator_id"], "versionId": version["id"], "revision": obj(row["input"])["expectedRevision"], "configuration": version["configuration"]}
	} else {
		command = Object{"kind": "models-credential-provision", "operationId": row["operation_id"], "operatorId": row["operator_id"], "modelRecordId": obj(row["input"])["modelRecordId"], "apiKey": input["apiKey"]}
	}
	value, e := s.Native.Call(ctx, command)
	if e == nil {
		value, e = s.acceptNative(ctx, claimed, value)
	}
	if e == nil {
		return value, nil
	}
	known := has([]string{"model_settings_native_busy", "model_settings_version_changed", "model_settings_configuration_invalid", "model_settings_credential_unavailable", "model_settings_permission_denied", "model_settings_authorization_unavailable"}, fault.Code(e))
	var ne *nativeError
	if errors.As(e, &ne) && has([]string{"400", "401", "403", "404", "405", "409", "413", "415", "422", "429"}, statusText(ne.NativeStatus)) {
		known = true
	}
	phase := "result-unknown"
	if known {
		phase = "failed"
	}
	return s.advance(ctx, claimed, phase, nativeCode(e), nil)
}
func statusText(v int) string {
	switch v {
	case 400:
		return "400"
	case 401:
		return "401"
	case 403:
		return "403"
	case 404:
		return "404"
	case 405:
		return "405"
	case 409:
		return "409"
	case 413:
		return "413"
	case 415:
		return "415"
	case 422:
		return "422"
	case 429:
		return "429"
	}
	return ""
}
func (s *Service) reconcile(ctx context.Context, id string) (Object, error) {
	s.mu.Lock()
	if prior := s.reconciling[id]; prior != nil {
		s.mu.Unlock()
		select {
		case <-prior.done:
			return prior.row, prior.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	job := &reconciliation{done: make(chan struct{})}
	if s.reconciling == nil {
		s.reconciling = map[string]*reconciliation{}
	}
	s.reconciling[id] = job
	s.mu.Unlock()
	job.row, job.err = s.reconcileOnce(ctx, id)
	s.mu.Lock()
	delete(s.reconciling, id)
	close(job.done)
	s.mu.Unlock()
	return job.row, job.err
}
func (s *Service) reconcileOnce(ctx context.Context, id string) (Object, error) {
	row, e := s.operation(ctx, s.Pool, id)
	if e != nil || row == nil || !pending(row["phase"]) || row["phase"] == "prepared" {
		return row, e
	}
	var value Object
	if s.Native == nil {
		e = fail("model_settings_native_not_configured", 503)
	} else {
		value, e = s.Native.Call(ctx, Object{"kind": "models-operation", "operationId": id})
		if e == nil {
			value, e = s.acceptNative(ctx, row, value)
		}
	}
	if e != nil {
		return s.advance(ctx, row, "result-unknown", nativeCode(e), nil)
	}
	return value, nil
}
func (s *Service) Command(ctx context.Context, a Actor, kind string, input Object, authorize func() (Actor, error)) (Object, error) {
	x, e := ParseCommand(kind, input)
	if e != nil {
		return nil, e
	}
	row, replayed, e := s.prepare(ctx, a, kind, x, authorize)
	if e != nil {
		return nil, e
	}
	if kind != "draft" && row["phase"] == "prepared" {
		row, e = s.submit(ctx, a, row, x, authorize)
		if e != nil {
			return nil, e
		}
	}
	if kind != "draft" && pending(row["phase"]) && row["phase"] != "prepared" {
		row, e = s.reconcile(ctx, str(row["operation_id"]))
		if e != nil {
			return nil, e
		}
	}
	action := "models.configure"
	if kind == "apply" {
		action = "models.apply"
	}
	if _, e = s.fresh(ctx, nil, a, action, authorize); e != nil {
		return nil, e
	}
	state, e := s.state(ctx, s.Pool)
	if e != nil {
		return nil, e
	}
	out := operationView(row, replayed)
	out["revision"] = state["revision"]
	return s.envelope(out), nil
}
func (s *Service) SaveDraft(ctx context.Context, a Actor, input Object, authorize func() (Actor, error)) (Object, error) {
	return s.Command(ctx, a, "draft", input, authorize)
}
func (s *Service) Apply(ctx context.Context, a Actor, input Object, authorize func() (Actor, error)) (Object, error) {
	return s.Command(ctx, a, "apply", input, authorize)
}
func (s *Service) ProvisionCredential(ctx context.Context, a Actor, input Object, authorize func() (Actor, error)) (Object, error) {
	return s.Command(ctx, a, "credential-provision", input, authorize)
}
