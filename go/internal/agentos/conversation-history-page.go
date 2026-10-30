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
			command        conversationCommand
			locator        ConversationOperationLocator
			known          string
		}
		items := []historyItem{}
		if len(ids) > 0 {
			rows, e = s.Pool.Query(ctx, conversationHistoryTree+`SELECT t.id::text,t.root_id::text,t.result->>'origin',t.result->>'parentOperationId',c.message_digest,c.state,c.native_run_id,c.result,c.created_at FROM tree t JOIN operations_agentos_conversation_commands_v1 c ON c.endpoint=$1 AND c.conversation_id=$2 AND c.operator_id=$3 AND c.id=t.id WHERE t.root_id=ANY($4::uuid[]) ORDER BY t.root_at,t.root_id,t.created_at,t.id`, s.Endpoint, row.ID, human.ID, ids)
			if e != nil {
				return nil, e
			}
			for rows.Next() {
				var item historyItem
				if e = rows.Scan(&item.id, &item.root, &item.origin, &item.parent, &item.command.Digest, &item.command.State, &item.command.NativeRunID, &item.command.Result, &item.command.CreatedAt); e != nil {
					rows.Close()
					return nil, e
				}
				item.command.ID, item.command.ConversationID, item.command.OperatorID, item.command.Domain = item.id, row.ID, human.ID, row.Domain
				item.locator, item.known, e = conversationOriginalLocator(row, &item.command)
				if e != nil {
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
		values := make([]Object, len(items))
		batchCount := (len(items) + 9) / 10
		failures, expiries := make([]error, batchCount), make([]int64, batchCount)
		jobs := make(chan int)
		var workers sync.WaitGroup
		for range min(4, batchCount) {
			workers.Add(1)
			go func() {
				defer workers.Done()
				for batch := range jobs {
					start, end := batch*10, min((batch+1)*10, len(items))
					requests := make([]ConversationOperationRequest, 0, end-start)
					for _, item := range items[start:end] {
						requests = append(requests, ConversationOperationRequest{OperationID: item.id, RunID: item.locator.RunID, RetryOfOperationID: item.locator.RetryOfOperationID, RetryOfRunID: item.locator.RetryOfRunID})
					}
					response, e := s.Client.ReadConversationOperations(ctx, row.Execution(), requests)
					if e != nil {
						failures[batch] = e
						continue
					}
					body := object(response)
					entries, ok := body["items"].([]any)
					expiry, expiryOK := index(body["readExpiresAt"])
					if body["conversationId"] != row.ID || body["sessionId"] != row.SessionID || !ok || len(entries) != len(requests) || !expiryOK || expiry <= s.now().Unix() {
						failures[batch] = streamInvalid()
						continue
					}
					byID := map[string]Object{}
					for _, entry := range entries {
						original := object(entry)
						id := text(original, "operationId")
						if original == nil || !validOperationID(id) || byID[id] != nil || (original["conversationId"] != nil && original["conversationId"] != row.ID) || (original["sessionId"] != nil && original["sessionId"] != row.SessionID) {
							failures[batch] = streamInvalid()
							break
						}
						byID[id] = original
					}
					if failures[batch] != nil {
						continue
					}
					expiries[batch] = expiry
					for i := start; i < end; i++ {
						item := items[i]
						original := byID[item.id]
						if original == nil {
							failures[batch] = streamInvalid()
							break
						}
						original = copyObject(original)
						original["conversationId"], original["sessionId"] = row.ID, row.SessionID
						value, e := validateConversationOriginal(row, &item.command, item.locator, item.known, original)
						if e != nil {
							failures[batch] = e
							break
						}
						if value == nil {
							value = Object{"operationId": item.id, "runId": item.id, "status": "unknown", "content": nil, "userInput": nil, "events": []any{}}
						}
						value = copyObject(value)
						value["operationId"], value["logicalTurnId"], value["origin"], value["parentOperationId"] = item.id, item.root, "user", nil
						if item.origin != nil && *item.origin == "operation-feedback" {
							value["origin"], value["parentOperationId"] = "operation-feedback", item.parent
						}
						values[i] = value
					}
				}
			}()
		}
		for i := 0; i < batchCount; i++ {
			jobs <- i
		}
		close(jobs)
		workers.Wait()
		for i, e := range failures {
			if e != nil {
				return nil, e
			}
			if expiries[i] < deadline || deadline == 0 {
				deadline = expiries[i]
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
