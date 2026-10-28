package messaging

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
)

func (s *Service) businessDomain() *businessadmin.Domain {
	return &businessadmin.Domain{Pool: s.Pool, Endpoint: s.Endpoint, Authority: s.Authority, Now: s.Now}
}
func (s *Service) duty(a Actor) operationspermissions.DutyAuthority {
	d := s.businessDomain().DutyAuthority()
	if d != nil && d.AcceptsDuty(a) {
		return d
	}
	return nil
}

// ValidateConfigurationWithin retains the original source validation for
// trusted prepared consumers; ParseConfiguration is the shared existing parser.
func ParseDraftConfiguration(value any) (Object, error) {
	config := obj(value)
	if config == nil {
		return nil, invalidInput()
	}
	if _, has := config["automation"]; has {
		return nil, invalidInput()
	}
	copy := Object{}
	for k, v := range config {
		copy[k] = v
	}
	copy["automation"] = Object{"kind": "human-required", "factsConfirmed": false}
	return normalizeConfig(copy)
}
func (s *Service) ValidateConfigurationWithin(ctx context.Context, tx pgx.Tx, value Object) error {
	return s.validateConfig(ctx, tx, value, false)
}
func (s *Service) CreatePrepared(ctx context.Context, a Actor, input Object, planID string) (Object, error) {
	if !uuidOK(planID) || input["operationId"] != planID {
		return nil, invalidInput()
	}
	return s.create(ctx, a, input, planID)
}
func (s *Service) assertDutyDraft(ctx context.Context, tx pgx.Tx, a Actor, input Object, kind string) error {
	duty := s.duty(a)
	if duty == nil {
		return failure("business_admin_denied", 403)
	}
	automation := obj(obj(input["config"])["automation"])
	if !uuidOK(input["planId"]) || !contains([]string{"create", "save"}, kind) || automation["kind"] != "human-required" || automation["factsConfirmed"] != false {
		return failure("operations_agentos_human_review_required")
	}
	if _, e := duty.RequireDutyAction(ctx, tx, a, "notices.read", "prepare"); e != nil {
		return e
	}
	if kind == "create" {
		var exists bool
		if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_messaging_plans_v1 WHERE id=$1)`, input["planId"]).Scan(&exists); e != nil {
			return e
		}
		if exists {
			return failure("operations_messaging_state_changed")
		}
	} else {
		row, e := s.planWithin(ctx, tx, str(input["planId"]), false)
		if e != nil {
			return e
		}
		if row["state"] != "draft" {
			return failure("operations_agentos_human_review_required")
		}
	}
	return nil
}
func (s *Service) assertDutyPlan(ctx context.Context, tx pgx.Tx, a Actor, row Object, kind string) error {
	if s.duty(a) == nil {
		return failure("business_admin_denied", 403)
	}
	automation := obj(obj(row["config"])["automation"])
	if contains([]string{"activate", "resume"}, kind) && (automation["kind"] != "ordinary" || automation["factsConfirmed"] != true) {
		return failure("operations_agentos_human_review_required")
	}
	prior, e := one(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT actor_kind,operator_id,kind FROM operations_messaging_events_v1 WHERE plan_id=$1 ORDER BY sequence DESC LIMIT 1)r`, row["id"])
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return e
	}
	if prior != nil && !contains([]string{"create", "save"}, str(prior["kind"])) && (prior["actor_kind"] != "operations-ai-service" || prior["operator_id"] != a.ID) {
		return failure("operations_agentos_human_review_required")
	}
	return nil
}
func (s *Service) approvalMetadata(a Actor, row Object) (Object, error) {
	duty := s.duty(a)
	if duty == nil {
		return nil, nil
	}
	m, e := duty.DutyMetadata(a)
	if e != nil {
		return nil, e
	}
	op := obj(m["operation"])
	if op["targetId"] != row["id"] || op["permission"] != "notices.publish" {
		return nil, failure("operations_ai_duty_operation_denied", 403)
	}
	out := Object{}
	for k, v := range m {
		out[k] = v
	}
	out["messagePlanId"], out["messageVersion"] = row["id"], row["version"]
	return out, nil
}

// QualifyDutyPreparedWithin is the existing action qualification source. It
// cannot create an actor; the caller supplies the current opaque duty proof.
func (s *Service) QualifyDutyPreparedWithin(ctx context.Context, tx pgx.Tx, a Actor, id, kind string, command Object) error {
	if kind == "message-draft-create" || kind == "message-draft-save" {
		mode := "save"
		if kind == "message-draft-create" {
			mode = "create"
		}
		return s.assertDutyDraft(ctx, tx, a, Object{"planId": id, "config": command["config"]}, mode)
	}
	row, e := s.planWithin(ctx, tx, id, false)
	if e != nil {
		return e
	}
	return s.assertDutyPlan(ctx, tx, a, row, kind)
}
