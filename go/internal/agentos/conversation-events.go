package agentos

import (
	"context"
	"errors"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
)

var conversationLeaseEnded = errors.New("conversation read lease ended")

func (s *Conversations) Events(ctx context.Context, operator operationspermissions.Actor, domain, id string, after int64, authorize AuthorizeConversation, yield func(Object) error) error {
	if !validConversationDomain(domain) || !validOperationID(id) || after < -1 || after > 9999999999 {
		return fail("invalid_operations_agentos_request", 400)
	}
	fresh, err := s.fresh(ctx, operator, authorize)
	if err != nil {
		return err
	}
	if _, err = s.Session(ctx, fresh, domain, false); err != nil {
		return err
	}
	saved, err := s.command(ctx, id)
	if err != nil {
		return err
	}
	if saved == nil || saved.OperatorID != operator.ID || saved.Domain != domain || saved.Result["cancelledOperationId"] != nil {
		return fail("operations_agentos_operation_not_found", 404)
	}
	current, err := s.Current(ctx, saved.ConversationID, &fresh)
	if err != nil {
		return err
	}
	row := *current.Row
	status := s.Client.Status(ctx)
	transport := object(status["conversationTransport"])
	if status["state"] != "connected" || transport["events"] != true || transport["originalRunLookup"] != true {
		return fail("operations_agentos_conversation_transport_unavailable", 503)
	}
	run, err := s.nativeOperation(ctx, row, saved)
	if err != nil {
		return err
	}
	expires := s.now().Unix() + 30
	admitted, err := s.fresh(ctx, fresh, authorize)
	if err != nil {
		return err
	}
	if _, err = s.Current(ctx, row.ID, &admitted); err != nil {
		return err
	}
	runID := text(run, "runId")
	if err = yield(Object{"kind": "lease", "operationId": id, "readExpiresAt": expires, "stopAvailable": runID != "" && (run["status"] == "PENDING" || run["status"] == "RUNNING")}); err != nil {
		return err
	}
	if runID == "" {
		return yield(Object{"kind": "resync", "operationId": id, "eventIndex": nil})
	}
	if terminalConversation(run["status"]) {
		return yield(Object{"kind": "terminal", "operationId": id, "eventIndex": nil, "status": run["status"]})
	}
	observe, cancel := context.WithCancel(ctx)
	defer cancel()
	err = coalesceConversationEvents(observe, func(observe context.Context, emit func(Object) error) error {
		return s.Client.ConversationEvents(observe, row.Execution(), runID, after, emit)
	}, func(event Object) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if s.now().Unix() >= expires {
			if err := yield(Object{"kind": "resync", "operationId": id, "eventIndex": event["eventIndex"]}); err != nil {
				return err
			}
			return conversationLeaseEnded
		}
		actor, err := s.fresh(ctx, fresh, authorize)
		if err != nil {
			return err
		}
		if _, err = s.Current(ctx, row.ID, &actor); err != nil {
			return err
		}
		if s.now().Unix() >= expires {
			if err := yield(Object{"kind": "resync", "operationId": id, "eventIndex": event["eventIndex"]}); err != nil {
				return err
			}
			return conversationLeaseEnded
		}
		value := copyObject(event)
		value["operationId"], value["readExpiresAt"] = id, expires
		return yield(value)
	})
	if errors.Is(err, conversationLeaseEnded) {
		return nil
	}
	return err
}

type conversationEventResult struct {
	value Object
	err   error
}

// Only transport text is batched, never reset/tool/terminal boundaries. Closing
// observation cancels this reader, never the already submitted model run.
func coalesceConversationEvents(ctx context.Context, source func(context.Context, func(Object) error) error, yield func(Object) error) error {
	observe, cancel := context.WithCancel(ctx)
	results := make(chan conversationEventResult, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer close(results)
		err := source(observe, func(value Object) error {
			select {
			case results <- conversationEventResult{value: value}:
				return nil
			case <-observe.Done():
				return observe.Err()
			}
		})
		if err != nil {
			select {
			case results <- conversationEventResult{err: err}:
			case <-observe.Done():
			}
		}
	}()
	defer func() { cancel(); <-done }()
	var buffer Object
	var timer *time.Timer
	var timerC <-chan time.Time
	stopTimer := func() {
		if timer != nil {
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		}
		timerC = nil
	}
	defer stopTimer()
	flush := func() error {
		if buffer == nil {
			return nil
		}
		value := buffer
		buffer = nil
		stopTimer()
		return yield(value)
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timerC:
			if err := flush(); err != nil {
				return err
			}
		case next, ok := <-results:
			if !ok {
				return flush()
			}
			if next.err != nil {
				return next.err
			}
			value := next.value
			if value["kind"] == "text" {
				if buffer == nil {
					buffer = copyObject(value)
					timer = time.NewTimer(80 * time.Millisecond)
					timerC = timer.C
				} else {
					buffer["text"], buffer["eventIndex"] = text(buffer, "text")+text(value, "text"), value["eventIndex"]
				}
				if len([]byte(text(buffer, "text"))) >= 16384 {
					if err := flush(); err != nil {
						return err
					}
				}
			} else {
				if err := flush(); err != nil {
					return err
				}
				if err := yield(value); err != nil {
					return err
				}
			}
		}
	}
}

func BrowserConversationEvent(value Object, operationID string) Object {
	if value == nil || value["operationId"] != operationID {
		return nil
	}
	var position, lease any
	if index, ok := index(value["eventIndex"]); ok {
		position = index
	}
	if expiry, ok := index(value["readExpiresAt"]); ok {
		lease = expiry
	}
	kind := text(value, "kind")
	if kind == "lease" {
		if lease == nil {
			return nil
		}
		return Object{"kind": kind, "operationId": operationID, "readExpiresAt": lease, "stopAvailable": value["stopAvailable"] == true}
	}
	out := Object{"kind": kind, "operationId": operationID, "eventIndex": position}
	switch kind {
	case "text":
		if position == nil {
			return nil
		}
		if _, ok := value["text"].(string); !ok {
			return nil
		}
		out["text"] = value["text"]
	case "reset":
		out["phase"] = "working"
	case "phase":
		if phase := value["phase"]; phase != "working" && phase != "generating" && phase != "waiting" {
			return nil
		}
		out["phase"] = value["phase"]
	case "terminal":
		if !terminalConversation(value["status"]) {
			return nil
		}
		out["status"] = value["status"]
		return out
	case "resync":
		return out
	case "blocked", "context-changed":
		out["eventIndex"] = nil
		return out
	default:
		return nil
	}
	if lease != nil {
		out["readExpiresAt"] = lease
	}
	return out
}
