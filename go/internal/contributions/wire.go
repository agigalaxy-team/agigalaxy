package contributions

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ProjectOrderedWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, current Object, fields []string, permission Permission) (*protocol.OrderedObject, error) {
	projection, e := s.ProjectWithin(ctx, tx, a, current, fields, permission)
	if e != nil {
		return nil, e
	}
	out := protocol.NewOrderedObject()
	selected := []string{}
	for _, field := range fields {
		out.Set(field, projection[field])
		if field == "title" || field == "summary" {
			selected = append(selected, field)
		}
	}
	if view := object(projection["textView"]); view != nil {
		out.Set("textView", taskmaterials.SelectedTextViewWire(view, selected))
	}
	return out, nil
}
func (s *Service) ReferenceOrdered(current Object, kind string, permission Permission) *protocol.OrderedObject {
	ref := s.Reference(current, kind, permission)
	out := protocol.NewOrderedObject()
	if len(permission.PublicationIDs) > 0 {
		out.Set("publicationId", ref["publicationId"])
		out.Set("sourceKey", ref["sourceKey"])
	} else {
		for _, key := range []string{"kind", "id", "eventVersion", "payloadHash"} {
			out.Set(key, ref[key])
		}
	}
	return out
}
