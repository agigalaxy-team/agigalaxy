package personalmcp

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/experiencereviews"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/qualification"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
)

func (s Services) qualificationConsumers(out map[string]Consumer) {
	if p := s.Qualification; p != nil {
		for name, fn := range map[string]func(context.Context, qualification.Actor, Object) (any, error){"galaxy_qualification_permission_plan": p.PlanRequest, "galaxy_qualification_permission_requests": p.QueryRequests, "galaxy_qualification_permission_request_read": p.ReadRequest, "galaxy_qualification_permission_request_receipt": p.RequestReceipt, "galaxy_qualification_calculation_receipt": p.CalculationReceipt, "galaxy_qualification_calculation_owned": p.OwnedCalculations, "galaxy_qualification_v2_candidates": p.Candidates} {
			out[name] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
				return fn(ctx, qualification.Actor{Actor: a, HTTPRequestID: id}, q)
			}
		}
		out["galaxy_qualification_v2_evaluate"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			raw, e := protocol.EncodeJS(q)
			if e != nil {
				return nil, e
			}
			return p.EvaluateV2(ctx, qualification.Actor{Actor: a, HTTPRequestID: id}, raw)
		}
		for name, fn := range map[string]func(context.Context, qualification.Actor, qualification.Envelope) (any, error){"galaxy_qualification_permission_request": p.SubmitRequest, "galaxy_qualification_calculation_permission": p.SubmitCalculation} {
			out[name] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
				var input qualification.Envelope
				if e := decode(q, &input); e != nil {
					return nil, e
				}
				return fn(ctx, qualification.Actor{Actor: a, HTTPRequestID: id}, input)
			}
		}
	}
	if p := s.Experience; p != nil {
		out["galaxy_experience_read"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.Read(ctx, experiencereviews.Actor{Actor: a, HTTPRequestID: id}, q)
		}
		out["galaxy_experience_submit"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			var input experiencereviews.Envelope
			if e := decode(q, &input); e != nil {
				return nil, e
			}
			return p.Submit(ctx, experiencereviews.Actor{Actor: a, HTTPRequestID: id}, input)
		}
	}
}

func (s Services) commentConsumers(out map[string]Consumer) {
	if p := s.Comments; p != nil {
		out["galaxy_comments_query"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			actor := taskmaterials.Actor{Actor: a, HTTPRequestID: id}
			return p.Query(ctx, &actor, q)
		}
		out["galaxy_comment_get"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			actor := taskmaterials.Actor{Actor: a, HTTPRequestID: id}
			return p.Get(ctx, &actor, str(q, "commentId"))
		}
		out["galaxy_comment_receipt"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.Receipt(ctx, taskmaterials.Actor{Actor: a, HTTPRequestID: id}, str(q, "operationId"), str(q, "payloadHash"))
		}
		out["galaxy_comment_submit"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			var input taskmaterials.Envelope
			if e := decode(q, &input); e != nil {
				return nil, e
			}
			return p.Submit(ctx, taskmaterials.Actor{Actor: a, HTTPRequestID: id}, input)
		}
	}
	if p := s.CommentGovernance; p != nil {
		out["galaxy_comment_governance_config"] = func(ctx context.Context, a deviceauth.Actor, _ Object, id *string) (any, error) {
			return p.Config(ctx, taskmaterials.Actor{Actor: a, HTTPRequestID: id})
		}
		out["galaxy_comment_governance_query"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.Query(ctx, taskmaterials.Actor{Actor: a, HTTPRequestID: id}, q)
		}
		out["galaxy_comment_governance_receipt"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.Receipt(ctx, taskmaterials.Actor{Actor: a, HTTPRequestID: id}, str(q, "operationId"), str(q, "payloadHash"))
		}
		out["galaxy_comment_report"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			var input taskmaterials.Envelope
			if e := decode(q, &input); e != nil {
				return nil, e
			}
			return p.Report(ctx, taskmaterials.Actor{Actor: a, HTTPRequestID: id}, input)
		}
		out["galaxy_comment_governance_event"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			var input taskmaterials.Envelope
			if e := decode(q, &input); e != nil {
				return nil, e
			}
			return p.Event(ctx, taskmaterials.Actor{Actor: a, HTTPRequestID: id}, str(q, "reportId"), input)
		}
	}
}
