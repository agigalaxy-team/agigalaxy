package personalmcp

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
)

func (s Services) taskConsumers(out map[string]Consumer) {
	p := s.Tasks
	call := func(name string, fn func(context.Context, taskmaterials.Actor, Object) (any, error)) {
		out[name] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return fn(ctx, taskmaterials.Actor{Actor: a, HTTPRequestID: id}, q)
		}
	}
	call("galaxy_tasks_v2_query", func(ctx context.Context, a taskmaterials.Actor, q Object) (any, error) {
		return p.QueryTasks(ctx, &a, str(q, "view"), str(q, "query"), str(q, "after"), integer(q, "limit", 12))
	})
	call("galaxy_task_v2_get", func(ctx context.Context, a taskmaterials.Actor, q Object) (any, error) {
		return p.GetTask(ctx, &a, str(q, "taskId"))
	})
	call("galaxy_task_material_prepare", func(ctx context.Context, a taskmaterials.Actor, q Object) (any, error) {
		raw, e := protocol.EncodeJS(q)
		if e != nil {
			return nil, e
		}
		input, e := taskmaterials.ParsePrepare(raw)
		if e != nil {
			return nil, e
		}
		return p.Prepare(ctx, a, input)
	})
	call("galaxy_task_material_status", func(ctx context.Context, a taskmaterials.Actor, q Object) (any, error) {
		return p.Status(ctx, a, str(q, "taskId"))
	})
	call("galaxy_task_v2_create", func(ctx context.Context, a taskmaterials.Actor, q Object) (any, error) {
		var input taskmaterials.TaskSubmission
		if e := decode(q, &input); e != nil {
			return nil, e
		}
		return p.CreateTask(ctx, a, input)
	})
	call("galaxy_task_v2_receipt", func(ctx context.Context, a taskmaterials.Actor, q Object) (any, error) {
		return p.TaskReceipt(ctx, a, str(q, "taskId"), str(q, "eventId"), str(q, "payloadHash"))
	})
	call("galaxy_task_v2_owner_read_prepare", p.OwnerReadPrepare)
	call("galaxy_task_v2_owner_control_prepare", p.OwnerControlPrepare)
	for name, fn := range map[string]func(context.Context, taskmaterials.Actor, string, taskmaterials.Envelope) (any, error){"galaxy_task_v2_event": p.SubmitTaskEvent, "galaxy_participation_v2_propose": p.ProposeParticipation, "galaxy_participation_v2_event": p.SubmitParticipationEvent, "galaxy_task_v2_owner_read": p.OwnerRead, "galaxy_task_v2_owner_control": p.OwnerControl} {
		call(name, func(ctx context.Context, a taskmaterials.Actor, q Object) (any, error) {
			var input taskmaterials.Envelope
			if e := decode(q, &input); e != nil {
				return nil, e
			}
			id := str(q, "taskId")
			if name == "galaxy_participation_v2_event" {
				id = str(q, "participationId")
			}
			return fn(ctx, a, id, input)
		})
	}
	call("galaxy_assistance_query", p.LegacyQuery)
	call("galaxy_assistance_get", func(ctx context.Context, a taskmaterials.Actor, q Object) (any, error) {
		return p.LegacyGet(ctx, a, str(q, "id"))
	})
	call("galaxy_assistance_submit", func(ctx context.Context, a taskmaterials.Actor, q Object) (any, error) {
		var input taskmaterials.Envelope
		if e := decode(q, &input); e != nil {
			return nil, e
		}
		return p.CreateLegacy(ctx, a, input)
	})
}

func (s Services) outcomeConsumers(out map[string]Consumer) {
	p := s.Outcome
	call := func(name string, fn func(context.Context, taskmaterials.Actor, Object) (any, error)) {
		out[name] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return fn(ctx, taskmaterials.Actor{Actor: a, HTTPRequestID: id}, q)
		}
	}
	for name, fn := range map[string]func(context.Context, taskmaterials.Actor, taskmaterials.Envelope) (any, error){"galaxy_outcome_material_request": p.Request, "galaxy_outcome_material_approve": p.Approve, "galaxy_outcome_material_control": p.Control} {
		call(name, func(ctx context.Context, a taskmaterials.Actor, q Object) (any, error) {
			var input taskmaterials.Envelope
			if e := decode(q, &input); e != nil {
				return nil, e
			}
			return fn(ctx, a, input)
		})
	}
	call("galaxy_outcome_material_source", func(ctx context.Context, a taskmaterials.Actor, q Object) (any, error) {
		return p.Source(ctx, a, str(q, "kind"), str(q, "id"), int64(integer(q, "version", 1)))
	})
	call("galaxy_outcome_material_inspect", func(ctx context.Context, a taskmaterials.Actor, q Object) (any, error) {
		return p.Inspect(ctx, a, str(q, "id"))
	})
	call("galaxy_outcome_material_query", func(ctx context.Context, a taskmaterials.Actor, q Object) (any, error) {
		return p.Query(ctx, a, str(q, "view"), str(q, "after"), integer(q, "limit", 20))
	})
	call("galaxy_outcome_material_receipt", func(ctx context.Context, a taskmaterials.Actor, q Object) (any, error) {
		return p.Receipt(ctx, a, str(q, "operationId"), str(q, "payloadHash"))
	})
	call("galaxy_outcome_material_read", func(ctx context.Context, a taskmaterials.Actor, q Object) (any, error) {
		value, e := p.Read(ctx, a, str(q, "id"))
		if e != nil {
			return nil, e
		}
		v, _ := value.(map[string]any)
		_, binary := v["bytesBase64"].(string)
		delete(v, "bytesBase64")
		if binary && v["contentAvailable"] == true && v["authorization"] == "current" {
			v["fileRetrieval"] = Object{"via": "existing-authorized-web-or-http", "method": "POST", "path": "/v2/outcome-materials/read", "input": Object{"id": v["materialId"], "version": v["version"]}, "currentAuthorizationRequired": true}
		}
		return v, nil
	})
}
