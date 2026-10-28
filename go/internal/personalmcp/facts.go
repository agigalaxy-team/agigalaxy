package personalmcp

import (
	"context"
	"encoding/json"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/subjectlifecycle"
)

func requestID(id *string) string {
	if id != nil {
		return *id
	}
	return ""
}
func rawInput(q Object) ([]byte, error) { return protocol.EncodeJS(q) }
func rawRead(out map[string]Consumer, name string, fn func(context.Context, deviceauth.Actor, []byte) (Object, error)) {
	out[name] = func(ctx context.Context, a deviceauth.Actor, q Object, _ *string) (any, error) {
		raw, e := rawInput(q)
		if e != nil {
			return nil, e
		}
		return fn(ctx, a, raw)
	}
}
func rawWrite(out map[string]Consumer, name string, fn func(context.Context, deviceauth.Actor, []byte, string) (Object, error)) {
	out[name] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
		raw, e := rawInput(q)
		if e != nil {
			return nil, e
		}
		return fn(ctx, a, raw, requestID(id))
	}
}
func pointerRead(out map[string]Consumer, name string, fn func(context.Context, *deviceauth.Actor, []byte) (Object, error)) {
	out[name] = func(ctx context.Context, a deviceauth.Actor, q Object, _ *string) (any, error) {
		raw, e := rawInput(q)
		if e != nil {
			return nil, e
		}
		return fn(ctx, &a, raw)
	}
}
func (s Services) factConsumers(out map[string]Consumer) {
	if p := s.Cases; p != nil {
		rawWrite(out, "galaxy_case_submit", p.Submit)
		rawWrite(out, "galaxy_case_v2_submit", p.SubmitV2)
		rawWrite(out, "galaxy_intervention_responses_submit", p.RespondBatch)
		rawWrite(out, "galaxy_task_create_link_case", p.CreateAndLinkTask)
		rawRead(out, "galaxy_case_v2_receipt", p.Receipt)
		rawRead(out, "galaxy_task_case_link_receipt", p.TaskLinkReceipt)
		out["galaxy_case_get"] = func(ctx context.Context, a deviceauth.Actor, q Object, _ *string) (any, error) {
			return p.Get(ctx, a, str(q, "id"))
		}
		out["galaxy_case_v2_read"] = func(ctx context.Context, a deviceauth.Actor, q Object, _ *string) (any, error) {
			args := Object{}
			if id, ok := q["taskId"]; ok {
				args["taskId"] = id
			}
			raw, e := rawInput(args)
			if e != nil {
				return nil, e
			}
			return p.GetV2(ctx, a, str(q, "caseId"), raw)
		}
	}
	if p := s.Records; p != nil {
		out["galaxy_evidence_v2_submit"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			var payload Object
			if json.Unmarshal([]byte(str(q, "payloadJson")), &payload) != nil || payload["kind"] != "evidence" {
				return nil, fault.New("invalid_evidence", 409)
			}
			raw, e := rawInput(q)
			if e != nil {
				return nil, e
			}
			return p.Submit(ctx, a, raw, requestID(id))
		}
		rawWrite(out, "galaxy_verification_record_submit", p.Submit)
		rawRead(out, "galaxy_verification_record_read", p.Get)
		rawRead(out, "galaxy_verification_record_receipt", p.Receipt)
		rawRead(out, "galaxy_evidence_status", p.Status)
	}
	if p := s.Configurations; p != nil {
		rawWrite(out, "galaxy_configuration_v2_submit", p.Submit)
		pointerRead(out, "galaxy_configuration_v2_read", p.Get)
		pointerRead(out, "galaxy_configuration_v2_query", p.Query)
		pointerRead(out, "galaxy_configuration_v2_versions", p.Versions)
		rawRead(out, "galaxy_configuration_v2_receipt", p.Receipt)
	}
	if p := s.History; p != nil {
		pointerRead(out, "galaxy_history_query", p.Query)
	}
	if p := s.HistoryV2; p != nil {
		pointerRead(out, "galaxy_history_v2_query", p.Query)
	}
	if p := s.Search; p != nil {
		pointerRead(out, "galaxy_search_v2_query", p.Query)
		pointerRead(out, "galaxy_search_v2_reference", p.Reference)
	}
	if p := s.CI; p != nil {
		rawRead(out, "galaxy_ci_v2_receipt", p.Receipt)
		rawWrite(out, "galaxy_ci_v2_observe", p.Submit)
		rawRead(out, "galaxy_ci_v2_read", p.Get)
		rawWrite(out, "galaxy_ci_v2_stop", p.RevokeRequest)
		pointerRead(out, "galaxy_ci_v2_proof_read", p.GetProof)
		rawWrite(out, "galaxy_ci_v2_proof_revoke", p.RevokeProof)
		rawWrite(out, "galaxy_ci_v2_proof_publish", p.Publish)
		rawRead(out, "galaxy_ci_v2_proof_preview", p.Preview)
	}
	if p := s.Context; p != nil {
		rawWrite(out, "galaxy_context_v2_query", p.QueryV2)
		rawWrite(out, "galaxy_context_query", p.QueryV1)
		rawWrite(out, "galaxy_context_v2_grant", p.CreateV2)
		rawRead(out, "galaxy_context_v2_receipt", p.ReceiptV2)
		out["galaxy_context_read"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.GetV1(ctx, a, str(q, "id"), requestID(id))
		}
		out["galaxy_context_v2_get"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			metadata, _ := q["metadataOnly"].(bool)
			return p.GetV2(ctx, a, str(q, "grantId"), metadata, requestID(id))
		}
		out["galaxy_context_v2_event"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			input := Object{"consentId": q["consentId"], "payloadJson": q["payloadJson"]}
			raw, e := rawInput(input)
			if e != nil {
				return nil, e
			}
			return p.SubmitEventV2(ctx, a, str(q, "grantId"), raw, requestID(id))
		}
	}
	if p := s.Profiles; p != nil {
		rawWrite(out, "galaxy_profile_submit", p.Publish)
	}
	if p := s.Exports; p != nil {
		out["galaxy_export_create"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			var input subjectlifecycle.CreateInput
			if e := decode(q, &input); e != nil {
				return nil, e
			}
			return p.Create(ctx, subjectlifecycle.Actor{Actor: a, HTTPRequestID: id}, input)
		}
		out["galaxy_export_page"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			var input subjectlifecycle.PageInput
			if e := decode(q, &input); e != nil {
				return nil, e
			}
			return p.Page(ctx, subjectlifecycle.Actor{Actor: a, HTTPRequestID: id}, input)
		}
		out["galaxy_export_binary"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			var input subjectlifecycle.BinaryInput
			if e := decode(q, &input); e != nil {
				return nil, e
			}
			return p.Binary(ctx, subjectlifecycle.Actor{Actor: a, HTTPRequestID: id}, input)
		}
		out["galaxy_export_revoke"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.Revoke(ctx, subjectlifecycle.Actor{Actor: a, HTTPRequestID: id}, str(q, "id"))
		}
	}
}
