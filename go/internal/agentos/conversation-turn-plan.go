package agentos

import (
	"context"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// A turn plan describes preparation, never authority to execute a business action.
func defaultTurnPlan() Object {
	return Object{"intent": "answer", "proposalCount": 1, "alternatives": false, "summary": "", "preparedCardIds": []any{}}
}

func lockCardTurn(ctx context.Context, tx pgx.Tx, endpoint, turn string) error {
	_, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912421))", endpoint+":conversation-cards:"+turn)
	return err
}

func turnPlanWithin(ctx context.Context, tx pgx.Tx, endpoint, turn string) (Object, error) {
	var result Object
	if err := tx.QueryRow(ctx, `SELECT result FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND id=$2`, endpoint, turn).Scan(&result); err != nil {
		return nil, err
	}
	plan := object(result["turnPlan"])
	if plan == nil {
		plan = defaultTurnPlan()
	} else {
		plan = copyObject(plan)
	}
	rows, err := tx.Query(ctx, `SELECT id::text FROM operations_agentos_conversation_cards_v1 WHERE endpoint=$1 AND turn_id=$2 ORDER BY created_at,id`, endpoint, turn)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []any{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	plan["preparedCardIds"] = ids
	return plan, rows.Err()
}

func (t *ConversationTools) planConversationTurn(ctx context.Context, bound boundConversationTool, turn string) (Object, error) {
	a := bound.args
	n, ok := index(a["proposalCount"])
	intent, summary := text(a, "intent"), text(a, "summary")
	alternatives, typed := a["alternatives"].(bool)
	if len(a) != 4 || !ok || (n != 1 && n != 3) || !typed || (intent != "answer" && intent != "prepare") || utf8.RuneCountInString(summary) > 240 || (n == 3 && (!alternatives || intent != "prepare")) || (n == 1 && alternatives) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	s := t.Conversations
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if err := lockCardTurn(ctx, tx, s.Endpoint, turn); err != nil {
			return nil, err
		}
		plan, err := turnPlanWithin(ctx, tx, s.Endpoint, turn)
		if err != nil {
			return nil, err
		}
		ids, _ := plan["preparedCardIds"].([]any)
		oldCount, _ := index(plan["proposalCount"])
		if oldCount == 3 && n != 3 {
			return nil, fail("operations_agentos_turn_plan_conflict", 409)
		}

		if len(ids) > 0 && (plan["proposalCount"] != a["proposalCount"] || plan["alternatives"] != alternatives || plan["intent"] != intent) {
			// JSON numbers can arrive as either Go integers or decoded floats.
			old, _ := index(plan["proposalCount"])
			if old != n || plan["alternatives"] != alternatives || plan["intent"] != intent {
				return nil, fail("operations_agentos_turn_plan_conflict", 409)
			}
		}
		plan = Object{"intent": intent, "proposalCount": n, "alternatives": alternatives, "summary": summary, "preparedCardIds": ids}
		_, err = tx.Exec(ctx, `UPDATE operations_agentos_conversation_commands_v1 SET result=jsonb_set(result,'{turnPlan}',$3::jsonb) WHERE endpoint=$1 AND id=$2 AND conversation_id=$4`, s.Endpoint, turn, plan, bound.row.ID)
		return Object{"state": "planned", "turnPlan": plan}, err
	})
}

func turnChoice(turn string, plan Object, number int) any {
	n, _ := index(plan["proposalCount"])
	if n != 3 || plan["alternatives"] != true {
		return nil
	}
	parent, err := uuid.Parse(turn)
	if err != nil {
		return nil
	}
	return Object{"groupId": uuid.NewSHA1(parent, []byte("conversation-alternatives")).String(), "index": number, "count": 3, "exclusive": true}
}

// A safe retry retains the original requested preparation goal, not a reduced
// intermediate plan. These are preparation facts, never execution authority.
func (s *Conversations) inheritedTurnPlan(ctx context.Context, parent *conversationCommand) (Object, error) {
	var plan Object
	err := s.Pool.QueryRow(ctx, `WITH RECURSIVE lineage AS (
 SELECT id,result,ARRAY[id] AS path,0 AS depth FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND id=$2 AND conversation_id=$3 AND operator_id=$4
 UNION ALL SELECT c.id,c.result,l.path||c.id,l.depth+1 FROM operations_agentos_conversation_commands_v1 c JOIN lineage l ON c.id::text=l.result->>'retryOfOperationId'
 WHERE c.endpoint=$1 AND c.conversation_id=$3 AND c.operator_id=$4 AND NOT c.id=ANY(l.path) AND l.depth<64)
 SELECT result->'turnPlan' FROM lineage WHERE result->'turnPlan'->>'intent'='prepare' ORDER BY CASE WHEN result->'turnPlan'->>'proposalCount'='3' THEN 0 ELSE 1 END,depth LIMIT 1`, s.Endpoint, parent.ID, parent.ConversationID, parent.OperatorID).Scan(&plan)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	count, ok := index(plan["proposalCount"])
	if !ok || count != 1 && count != 3 || count == 3 && plan["alternatives"] != true {
		return nil, nil
	}
	return Object{"intent": "prepare", "proposalCount": count, "alternatives": count == 3, "summary": text(plan, "summary"), "preparedCardIds": []any{}}, nil
}
