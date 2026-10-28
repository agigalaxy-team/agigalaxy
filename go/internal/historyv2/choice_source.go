package historyv2

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

// Relevance retains the original pure current-history match projection. The
// caller must first obtain value through an owning authorized source read.
func Relevance(value *protocol.OrderedObject, query Object) (*protocol.OrderedObject, error) {
	return relevance(value, query)
}

// ReadChoiceHistoryWithin serves the original already-authorized Choice source
// dispatcher. It resolves only the selected exact Task/Case and current Task
// children, retaining the same subject filter and owning visibility projection.
func (s *Service) ReadChoiceHistoryWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id, kind, subject string) (json.RawMessage, error) {
	var item *ordered
	var err error
	if kind == "task-history" {
		item, err = s.taskWithin(ctx, tx, a, id, subject)
	} else if kind == "case-history" {
		children, e := ids(ctx, tx, `SELECT id::text FROM task_requests WHERE case_id=$1 ORDER BY id FOR SHARE`, id)
		if e != nil {
			return nil, e
		}
		tasks := []*ordered{}
		for _, child := range children {
			task, e := s.taskWithin(ctx, tx, a, child, subject)
			if e != nil {
				if unavailable(e) {
					continue
				}
				return nil, e
			}
			if task != nil {
				if subject == "" {
					task.Set("subjectId", nil)
				}
				tasks = append(tasks, task)
			}
		}
		item, err = s.caseWithin(ctx, tx, a, id, subject, tasks)
	} else {
		return nil, fault.New("choice_source_unavailable", 409)
	}
	if err != nil {
		return nil, err
	}
	if item == nil {
		return json.RawMessage("null"), nil
	}
	if subject == "" {
		item.Set("subjectId", nil)
	}
	raw, err := protocol.EncodeJS(item)
	return json.RawMessage(raw), err
}
