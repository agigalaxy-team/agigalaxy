package agentos

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
)

type conversationHistoryCursor struct {
	Conversation string    `json:"c"`
	Before       time.Time `json:"at"`
	ID           string    `json:"id"`
}

func parseHistoryCursor(raw, conversation string) (conversationHistoryCursor, error) {
	var cursor conversationHistoryCursor
	if raw == "" {
		return cursor, nil
	}
	if len(raw) > 512 {
		return cursor, fail("invalid_operations_agentos_request", 400)
	}
	bytes, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || json.Unmarshal(bytes, &cursor) != nil || !validOperationID(cursor.ID) || cursor.Before.IsZero() {
		return cursor, fail("invalid_operations_agentos_request", 400)
	}
	if cursor.Conversation != conversation {
		return cursor, fail("operations_agentos_context_changed", 409)
	}
	return cursor, nil
}

// Page durable logical requests, not an arbitrary tail of model messages.
// Retries and execution feedback belong to their original request's page.
const conversationHistoryTree = `WITH RECURSIVE owned AS (
 SELECT id,created_at,result FROM operations_agentos_conversation_commands_v1
 WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3 AND result->>'cancelledOperationId' IS NULL
), tree AS (
 SELECT id,created_at,result,id AS root_id,created_at AS root_at,ARRAY[id] AS path FROM owned
 WHERE COALESCE(result->>'parentOperationId',result->>'retryOfOperationId') IS NULL
 UNION ALL
 SELECT c.id,c.created_at,c.result,t.root_id,t.root_at,t.path||c.id FROM owned c JOIN tree t
 ON COALESCE(c.result->>'parentOperationId',c.result->>'retryOfOperationId')=t.id::text
 WHERE NOT c.id=ANY(t.path)
) `

func (s *Conversations) ReadHistoryPage(ctx context.Context, human operationspermissions.Actor, domain, rawCursor string) (Object, error) {
	if !validConversationDomain(domain) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	before, err := s.readSession(ctx, human, domain)
	if err != nil {
		return nil, err
	}
	runs := []Object{}
	var next any
	hasMore := false
	deadline := before.ReadExpiresAt
	if before.Row != nil {
		if s.Client == nil {
			return nil, fail("operations_agentos_not_configured", 503)
		}
		row := *before.Row
		cursor, e := parseHistoryCursor(rawCursor, row.ID)
		if e != nil {
			return nil, e
		}
		rows, e := s.Pool.Query(ctx, conversationHistoryTree+`SELECT root_id::text,root_at FROM tree WHERE id=root_id AND ($4::timestamptz IS NULL OR (root_at,root_id)<($4::timestamptz,$5::uuid)) ORDER BY root_at DESC,root_id DESC LIMIT 6`, s.Endpoint, row.ID, human.ID, nullableCursorTime(cursor), nullableCursorID(cursor))
		if e != nil {
			return nil, e
		}
		ids := []string{}
		roots := []conversationHistoryCursor{}
		for rows.Next() {
			var root conversationHistoryCursor
			root.Conversation = row.ID
			if e = rows.Scan(&root.ID, &root.Before); e != nil {
				rows.Close()
				return nil, e
			}
			roots = append(roots, root)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
		hasMore = len(roots) > 5
		if hasMore {
			roots = roots[:5]
		}
		for _, root := range roots {
			ids = append(ids, root.ID)
		}
		if hasMore {
			bytes, _ := json.Marshal(roots[len(roots)-1])
			next = base64.RawURLEncoding.EncodeToString(bytes)
		}
		type historyItem struct {
			id, root       string
			origin, parent *string
		}
		items := []historyItem{}
		if len(ids) > 0 {
			rows, e = s.Pool.Query(ctx, conversationHistoryTree+`SELECT id::text,root_id::text,result->>'origin',result->>'parentOperationId' FROM tree WHERE root_id=ANY($4::uuid[]) ORDER BY root_at,root_id,created_at,id`, s.Endpoint, row.ID, human.ID, ids)
			if e != nil {
				return nil, e
			}
			for rows.Next() {
				var item historyItem
				if e = rows.Scan(&item.id, &item.root, &item.origin, &item.parent); e != nil {
					rows.Close()
					return nil, e
				}
				items = append(items, item)
			}
			e = rows.Err()
			rows.Close()
			if e != nil {
				return nil, e
			}
		}
		values, failures := make([]Object, len(items)), make([]error, len(items))
		jobs := make(chan int)
		var workers sync.WaitGroup
		for range min(4, len(items)) {
			workers.Add(1)
			go func() {
				defer workers.Done()
				for i := range jobs {
					item := items[i]
					command, e := s.command(ctx, item.id)
					if e != nil {
						failures[i] = e
						continue
					}
					value, e := s.nativeOperation(ctx, row, command)
					if e != nil {
						failures[i] = e
						continue
					}
					if value == nil {
						value = Object{"operationId": item.id, "runId": item.id, "status": "unknown", "content": nil, "userInput": nil, "events": []any{}}
					}
					value = copyObject(value)
					value["operationId"], value["logicalTurnId"], value["origin"], value["parentOperationId"] = item.id, item.root, "user", nil
					if item.origin != nil && *item.origin == "operation-feedback" {
						value["origin"] = "operation-feedback"
						value["parentOperationId"] = item.parent
					}
					values[i] = value
				}
			}()
		}
		for i := range items {
			jobs <- i
		}
		close(jobs)
		workers.Wait()
		for _, e := range failures {
			if e != nil {
				return nil, e
			}
		}
		runs, err = s.decorateRuns(ctx, row, values)
		if err != nil {
			return nil, err
		}
		if s.SyncWorkbenchRuns != nil {
			if err = s.SyncWorkbenchRuns(ctx, row, runs); err != nil {
				return nil, err
			}
		}
	} else if rawCursor != "" {
		return nil, fail("operations_agentos_context_changed", 409)
	}
	current, err := s.finishConversationRead(ctx, human, domain, before)
	if err != nil {
		return nil, err
	}
	if deadline == 0 || current.ReadExpiresAt < deadline {
		deadline = current.ReadExpiresAt
	}
	return Object{"domain": domain, "conversationId": readConversationID(current), "runs": runs, "hasMore": hasMore, "nextCursor": next, "contextChanged": current.ContextChanged, "checkedAt": s.now().Unix(), "readExpiresAt": deadline}, nil
}

func nullableCursorTime(c conversationHistoryCursor) any {
	if c.ID == "" {
		return nil
	}
	return c.Before
}
func nullableCursorID(c conversationHistoryCursor) any {
	if c.ID == "" {
		return nil
	}
	return c.ID
}
