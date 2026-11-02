package agentos

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"
)

// A declared read target is a task requirement, not a model/tool round limit.
// Count only this attempt's original successful view receipts. History text,
// local validation failures, duplicates and other owners cannot satisfy it.
func conversationReadCoverage(ctx context.Context, tx pgx.Tx, endpoint string, row Conversation, turn string) (Object, error) {
	var plan Object
	if e := tx.QueryRow(ctx, `SELECT result->'turnPlan' FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3 AND id=$4`, endpoint, row.ID, row.OperatorID, turn).Scan(&plan); e != nil {
		return nil, e
	}
	expected, ok := index(plan["readCount"])
	if !ok || expected < 1 {
		return nil, nil
	}
	rows, e := tx.Query(ctx, `SELECT DISTINCT metadata->>'module',metadata->>'view' FROM operations_agentos_conversation_tool_calls_v1 WHERE endpoint=$1 AND conversation_id=$2 AND turn_id=$3 AND tool='query-operations' AND state='completed' AND metadata->>'state'='available' AND metadata->>'module' IS NOT NULL AND metadata->>'view' IS NOT NULL ORDER BY 1,2`, endpoint, row.ID, turn)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	views := []any{}
	for rows.Next() {
		var module, view string
		if e = rows.Scan(&module, &view); e != nil {
			return nil, e
		}
		views = append(views, Object{"module": module, "view": view})
	}
	if e = rows.Err(); e != nil {
		return nil, e
	}
	missing := max(0, expected-int64(len(views)))
	return Object{"basis": "current-turn-successful-distinct-view-receipts", "expected": expected, "completed": len(views), "missing": missing, "views": views, "remaining": fmt.Sprintf("还需完成%d个不同视图的实际读取，不能用历史内容代替。", missing)}, nil
}
