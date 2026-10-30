package agentos

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

// Lineage is read exclusively from the same owner's server-side command ledger.
func conversationTaskRootWithin(ctx context.Context, tx pgx.Tx, endpoint string, row Conversation, turn string) (string, Object, error) {
	seen := map[string]bool{}
	for depth := 0; depth < 128; depth++ {
		if !validOperationID(turn) || seen[turn] {
			return "", nil, fail("operations_agentos_scope_denied", 403)
		}
		seen[turn] = true
		var result Object
		err := tx.QueryRow(ctx, `SELECT result FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3 AND id=$4 AND result->>'cancelledOperationId' IS NULL`, endpoint, row.ID, row.OperatorID, turn).Scan(&result)
		if err == pgx.ErrNoRows {
			return "", nil, fail("operations_agentos_scope_denied", 403)
		}
		if err != nil {
			return "", nil, err
		}
		parent, retry := text(result, "parentOperationId"), text(result, "retryOfOperationId")
		if result["parentOperationId"] != nil && parent == "" || result["retryOfOperationId"] != nil && retry == "" || parent != "" && retry != "" {
			return "", nil, fail("operations_agentos_scope_denied", 403)
		}
		if parent == "" && retry == "" {
			return turn, result, nil
		}
		if parent != "" {
			turn = parent
		} else {
			turn = retry
		}
	}
	return "", nil, fail("operations_agentos_scope_denied", 403)
}
func publicConversationTask(p Object) Object {
	if p == nil {
		return nil
	}
	out := copyObject(p)
	delete(out, "checkpointCallId")
	delete(out, "checkpointState")
	delete(out, "activeOperationId")
	return out
}
func defaultConversationTask(root, active string) Object {
	return Object{"rootOperationId": root, "activeOperationId": active, "phase": "continue", "remaining": []any{}, "reason": "", "revision": int64(0)}
}
func taskProjectionPhase(progress Object, waiting, unresolved, cancelled bool) Object {
	out := publicConversationTask(progress)
	phase := text(out, "phase")
	if phase == "continue" || phase == "completed" || phase == "waiting-confirmation" || phase == "waiting-result" {
		if unresolved {
			out["phase"] = "waiting-result"
		} else if waiting {
			out["phase"] = "waiting-confirmation"
		} else if phase == "waiting-confirmation" && cancelled {
			out["phase"] = "needs-information"
		}
	}
	return out
}
func (s *Conversations) conversationTaskProgress(ctx context.Context, row Conversation, turn string) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		root, result, err := conversationTaskRootWithin(ctx, tx, s.Endpoint, row, turn)
		if err != nil {
			return nil, err
		}
		p := object(result["taskProgress"])
		if p == nil {
			p = defaultConversationTask(root, root)
		}
		var waiting, unresolved, cancelled bool
		err = tx.QueryRow(ctx, conversationHistoryTree+`SELECT COALESCE(bool_or(c.state='prepared'),false),COALESCE(bool_or(c.state IN ('processing','unknown')),false),COALESCE(bool_or(c.turn_id::text=$5 AND c.state='not-available' AND c.result->>'state'='cancelled'),false) FROM operations_agentos_conversation_cards_v1 c JOIN tree t ON t.id=c.turn_id WHERE t.root_id=$4 AND c.endpoint=$1 AND c.conversation_id=$2 AND c.operator_id=$3`, s.Endpoint, row.ID, row.OperatorID, root, text(p, "activeOperationId")).Scan(&waiting, &unresolved, &cancelled)
		if err != nil {
			return nil, err
		}
		return taskProjectionPhase(p, waiting, unresolved, cancelled), nil
	})
}

// Legacy commands remain unmodified and do not acquire a synthetic task
// status merely because a history or card is read.
func (s *Conversations) recordedConversationTaskProgress(ctx context.Context, row Conversation, turn string) (Object, error) {
	recorded, err := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
		_, result, e := conversationTaskRootWithin(ctx, tx, s.Endpoint, row, turn)
		if e != nil {
			return false, e
		}
		return object(result["taskProgress"]) != nil, nil
	})
	if err != nil || !recorded {
		return nil, err
	}
	return s.conversationTaskProgress(ctx, row, turn)
}

func (s *Conversations) conversationTaskContext(ctx context.Context, row Conversation, turn string) (Object, Object, error) {
	progress, err := s.conversationTaskProgress(ctx, row, turn)
	if err != nil {
		return nil, nil, err
	}
	root := text(progress, "rootOperationId")
	out := Object{"rootOperationId": root, "remaining": progress["remaining"], "phase": progress["phase"], "objective": nil, "objectiveAvailable": false}
	if turn != root {
		command, e := s.command(ctx, root)
		if e != nil {
			return nil, nil, e
		}
		if command == nil || command.ConversationID != row.ID || command.OperatorID != row.OperatorID || command.Domain != row.Domain {
			return nil, nil, fail("operations_agentos_scope_denied", 403)
		}
		if s.Client != nil {
			native, e := s.nativeOperation(ctx, row, command)
			if e != nil {
				return nil, nil, e
			}
			if native != nil {
				objective := text(native, "userInput")
				if strings.TrimSpace(objective) != "" && utf8.RuneCountInString(objective) <= 12000 {
					out["objective"], out["objectiveAvailable"] = objective, true
				}
			}
		}
	}
	return progress, out, nil
}

// Lock the actual same-root cards before deciding to assess or prepare. This
// never executes or retries a business action; it only observes original rows.
func lockConversationTaskCards(ctx context.Context, tx pgx.Tx, endpoint string, row Conversation, root string) (bool, bool, error) {
	rows, err := tx.Query(ctx, conversationHistoryTree+`SELECT c.state FROM operations_agentos_conversation_cards_v1 c JOIN tree t ON t.id=c.turn_id WHERE t.root_id=$4 AND c.endpoint=$1 AND c.conversation_id=$2 AND c.operator_id=$3 ORDER BY c.id FOR UPDATE OF c`, endpoint, row.ID, row.OperatorID, root)
	if err != nil {
		return false, false, err
	}
	defer rows.Close()
	waiting, unresolved := false, false
	for rows.Next() {
		var state string
		if err = rows.Scan(&state); err != nil {
			return false, false, err
		}
		waiting = waiting || state == "prepared"
		unresolved = unresolved || state == "processing" || state == "unknown"
	}
	return waiting, unresolved, rows.Err()
}

// An observed original native ERROR/CANCELLED is only an interruption of
// the current task step. It never establishes the business effect of a card.
func (s *Conversations) markConversationTaskInterrupted(ctx context.Context, row Conversation, root, turn string) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, err := s.CurrentReadWithin(ctx, tx, row.ID, nil); err != nil {
			return nil, err
		}
		if err := lockCardTurn(ctx, tx, s.Endpoint, turn); err != nil {
			return nil, err
		}
		var stored Object
		if err := tx.QueryRow(ctx, `SELECT result FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3 AND id=$4 FOR UPDATE`, s.Endpoint, row.ID, row.OperatorID, root).Scan(&stored); err != nil {
			return nil, err
		}
		progress := object(stored["taskProgress"])
		if progress == nil || text(progress, "rootOperationId") != root {
			return nil, nil
		}
		waiting, unresolved, err := lockConversationTaskCards(ctx, tx, s.Endpoint, row, root)
		if err != nil {
			return nil, err
		}
		if text(progress, "activeOperationId") != turn || text(progress, "phase") != "continue" || unresolved {
			return taskProjectionPhase(progress, waiting, unresolved, false), nil
		}
		progress = copyObject(progress)
		revision, _ := index(progress["revision"])
		progress["phase"], progress["reason"], progress["revision"] = "interrupted", "本次回复已中断，任务尚未完成。", revision+1
		delete(progress, "checkpointCallId")
		delete(progress, "checkpointState")
		_, err = tx.Exec(ctx, `UPDATE operations_agentos_conversation_commands_v1 SET result=jsonb_set(result,'{taskProgress}',$5::jsonb) WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3 AND id=$4`, s.Endpoint, row.ID, row.OperatorID, root, progress)
		if err != nil {
			return nil, err
		}
		return publicConversationTask(progress), nil
	})
}

func (t *ConversationTools) assessConversationTask(ctx context.Context, bound boundConversationTool, turn string) (Object, error) {
	args := bound.args
	disposition, reason := text(args, "disposition"), text(args, "reason")
	_, reasonOK := args["reason"].(string)
	switch disposition {
	case "continue", "completed", "awaiting-confirmation", "needs-information", "waiting-result", "blocked", "interrupted":
	default:
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	remaining, ok := args["remaining"].([]any)
	if len(args) != 3 || !ok || !reasonOK || len(remaining) > 40 || utf8.RuneCountInString(reason) > 2000 {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	for _, v := range remaining {
		line, ok := v.(string)
		if !ok || strings.TrimSpace(line) == "" || utf8.RuneCountInString(line) > 1000 {
			return nil, fail("invalid_operations_agentos_request", 400)
		}
	}
	s := t.Conversations
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, err := s.CurrentReadWithin(ctx, tx, bound.row.ID, &bound.actor); err != nil {
			return nil, err
		}
		if err := lockCardTurn(ctx, tx, s.Endpoint, turn); err != nil {
			return nil, err
		}
		root, _, err := conversationTaskRootWithin(ctx, tx, s.Endpoint, bound.row, turn)
		if err != nil {
			return nil, err
		}
		var stored Object
		if err = tx.QueryRow(ctx, `SELECT result FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3 AND id=$4 FOR UPDATE`, s.Endpoint, bound.row.ID, bound.row.OperatorID, root).Scan(&stored); err != nil {
			return nil, err
		}
		progress := object(stored["taskProgress"])
		if progress == nil {
			progress = defaultConversationTask(root, root)
		} else {
			progress = copyObject(progress)
		}
		if text(progress, "rootOperationId") != root {
			return nil, fail("operations_agentos_scope_denied", 403)
		}
		active := text(progress, "activeOperationId")
		if active != "" && active != turn {
			return nil, fail("operations_agentos_task_checkpoint_stale", 409)
		}
		if text(progress, "checkpointCallId") == bound.callID {
			return Object{"state": progress["checkpointState"], "taskProgress": publicConversationTask(progress)}, nil
		}
		waiting, unresolved, err := lockConversationTaskCards(ctx, tx, s.Endpoint, bound.row, root)
		if err != nil {
			return nil, err
		}
		phase := disposition
		if phase == "awaiting-confirmation" {
			phase = "waiting-confirmation"
		}
		state := "recorded"
		if disposition == "awaiting-confirmation" {
			if unresolved {
				phase, state = "waiting-result", "needs-continuation"
			} else if !waiting {
				phase, state = "continue", "needs-continuation"
			}
		} else if disposition == "completed" {
			if unresolved {
				phase = "waiting-result"
				state = "needs-continuation"
			} else if waiting {
				phase = "waiting-confirmation"
				state = "needs-continuation"
			} else if len(remaining) > 0 {
				phase = "continue"
				state = "needs-continuation"
			}
		} else if disposition == "continue" && unresolved {
			phase = "waiting-result"
		} else if disposition == "continue" && waiting {
			phase = "waiting-confirmation"
		}
		revision, _ := index(progress["revision"])
		progress = Object{"rootOperationId": root, "activeOperationId": turn, "phase": phase, "remaining": remaining, "reason": reason, "revision": revision + 1, "checkpointCallId": bound.callID, "checkpointState": state}
		_, err = tx.Exec(ctx, `UPDATE operations_agentos_conversation_commands_v1 SET result=jsonb_set(result,'{taskProgress}',$5::jsonb) WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3 AND id=$4`, s.Endpoint, bound.row.ID, bound.row.OperatorID, root, progress)
		if err != nil {
			return nil, err
		}
		return Object{"state": state, "taskProgress": publicConversationTask(progress)}, nil
	})
}
