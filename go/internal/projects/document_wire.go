package projects

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

// DocumentWireWithin restores the original loose document's member order for
// consumers whose existing source-version hashes use JSON.stringify. Ordinary
// current project/field authority is rechecked before reading source bytes.
func (s *Service) DocumentWireWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) (*protocol.OrderedObject, error) {
	view, e := s.ReadWithin(ctx, tx, a, id)
	if e != nil {
		return nil, e
	}
	document := obj(view, "document")
	out := protocol.NewOrderedObject()
	known := []string{"kind", "title", "summary", "functions", "technologies", "sourceUrl", "discoverable", "participantKind"}
	for _, k := range known {
		if v, ok := document[k]; ok {
			out.Set(k, v)
		}
	}
	sources, _ := obj(view, "source")["fieldSources"].([]Object)
	loaded := map[string]*protocol.OrderedObject{}
	for _, source := range sources {
		key := str(source, "field")
		if contains(known, key) {
			continue
		}
		if _, ok := document[key]; !ok {
			continue
		}
		id := str(source, "operationId")
		payload := loaded[id]
		if payload == nil {
			r, e := row(ctx, tx, "SELECT to_jsonb(e) FROM (SELECT payload_text FROM project_events_v2 WHERE operation_id=$1)e", id)
			if e != nil {
				return nil, e
			}
			parsed, e := protocol.DecodeOrdered([]byte(str(r, "payload_text")))
			if e != nil {
				return nil, e
			}
			event, ok := parsed.(*protocol.OrderedObject)
			if !ok {
				return nil, fmt.Errorf("project source wire unavailable")
			}
			field := "patch"
			if event.Values()["kind"] == "create" {
				field = "document"
			}
			payload, ok = event.Values()[field].(*protocol.OrderedObject)
			if !ok {
				return nil, fmt.Errorf("project source wire unavailable")
			}
			loaded[id] = payload
		}
		value, ok := payload.Values()[key]
		if !ok {
			return nil, fmt.Errorf("project source field wire unavailable")
		}
		out.Set(key, value)
	}
	return out, nil
}
