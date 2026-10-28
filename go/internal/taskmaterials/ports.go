package taskmaterials

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"

	"github.com/jackc/pgx/v5"
)

// ForumSourceAdapter consumes Community's exact TaskMaterialSourceWithin state.
// Public projection DTOs are intentionally not a substitute for this port.
func ForumSourceAdapter(read func(context.Context, pgx.Tx, Object, string, bool) (Object, error)) ForumSource {
	return func(ctx context.Context, tx pgx.Tx, source Object, owner string, lock bool) (SourceState, error) {
		if read == nil {
			return SourceState{}, fail("task_material_source_reader_unavailable", 503)
		}
		value, e := read(ctx, tx, source, owner, lock)
		if e != nil {
			return SourceState{}, e
		}
		if value == nil {
			return SourceState{}, fail("task_material_source_reader_unavailable", 503)
		}
		return SourceState{Available: truth(value["available"]), Permanent: truth(value["permanent"]), Reasons: stringsOf(value["reasons"]), Row: obj(value, "row"), Payload: obj(value, "payload"), AvailableUntil: num(value["availableUntil"])}, nil
	}
}

// ExportMaterialWithin is the original lifecycle taskMaterialExport consumer.
// The outer takeout transaction has already verified data-export; this reads
// current Task/source permission without requiring an unrelated extra scope.
func (s *Service) ExportMaterialWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, item Object) (Object, error) {
	allowed := false
	if _, e := s.RequireTaskWithin(ctx, tx, &a, str(item, "task_id"), false); e != nil {
		if fault.Status(e) != 403 && fault.Status(e) != 404 {
			return nil, e
		}
	} else {
		state, e := s.StatusWithin(ctx, tx, item, true)
		if e != nil {
			return nil, e
		}
		allowed = state.Available
	}
	out := Object{}
	for k, v := range item {
		out[k] = v
	}
	if !allowed {
		out["body_text"] = ""
	}
	out["contentAvailable"] = allowed
	out["authority"] = "current-task-and-source-permission; original descriptor/hash are historical"
	return out, nil
}
