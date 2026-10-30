package agentos

import (
	"context"
	"encoding/base64"
	"encoding/json"
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

// ReadHistoryPage displays already stored dialogue text. It does not read
// original operations, adjudicate business sources, or recover receipts.
func (s *Conversations) ReadHistoryPage(ctx context.Context, human operationspermissions.Actor, domain, rawCursor string) (Object, error) {
	if !validConversationDomain(domain) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	current, err := s.readSession(ctx, human, domain)
	if err != nil {
		return nil, err
	}
	runs := []Object{}
	var next any
	hasMore := false
	if current.Row == nil {
		if rawCursor != "" {
			return nil, fail("operations_agentos_context_changed", 409)
		}
	} else {
		if s.Client == nil {
			return nil, fail("operations_agentos_not_configured", 503)
		}
		row := *current.Row
		cursor, e := parseHistoryCursor(rawCursor, row.ID)
		if e != nil {
			return nil, e
		}
		rows, e := s.Pool.Query(ctx, conversationHistoryTree+`SELECT root_id::text,root_at FROM tree WHERE id=root_id AND ($4::timestamptz IS NULL OR (root_at,root_id)<($4::timestamptz,$5::uuid)) ORDER BY root_at DESC,root_id DESC LIMIT 6`, s.Endpoint, row.ID, human.ID, nullableCursorTime(cursor), nullableCursorID(cursor))
		if e != nil {
			return nil, e
		}
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
		ids := []string{}
		for _, root := range roots {
			ids = append(ids, root.ID)
		}
		if hasMore {
			bytes, _ := json.Marshal(roots[len(roots)-1])
			next = base64.RawURLEncoding.EncodeToString(bytes)
		}
		type textRow struct {
			operation, runID, root string
			origin, parent         *string
			sentAt                 time.Time
		}
		selected := []textRow{}
		runIDs := []string{}
		seen := map[string]bool{}
		if len(ids) > 0 {
			rows, e = s.Pool.Query(ctx, conversationHistoryTree+`SELECT t.id::text,t.root_id::text,t.result->>'origin',COALESCE(t.result->>'parentOperationId',t.result->>'retryOfOperationId'),t.created_at,COALESCE(c.native_run_id,c.result->>'runId') FROM tree t JOIN operations_agentos_conversation_commands_v1 c ON c.endpoint=$1 AND c.conversation_id=$2 AND c.operator_id=$3 AND c.id=t.id WHERE t.root_id=ANY($4::uuid[]) ORDER BY t.root_at,t.root_id,t.created_at,t.id`, s.Endpoint, row.ID, human.ID, ids)
			if e != nil {
				return nil, e
			}
			for rows.Next() {
				var item textRow
				var native *string
				if e = rows.Scan(&item.operation, &item.root, &item.origin, &item.parent, &item.sentAt, &native); e != nil {
					rows.Close()
					return nil, e
				}
				if native == nil || !nativeRunID.MatchString(*native) {
					continue
				}
				item.runID = *native
				selected = append(selected, item)
				if !seen[item.runID] {
					seen[item.runID] = true
					runIDs = append(runIDs, item.runID)
				}
			}
			e = rows.Err()
			rows.Close()
			if e != nil {
				return nil, e
			}
		}
		texts := map[string]Object{}
		for start := 0; start < len(runIDs); start += 50 {
			end := min(start+50, len(runIDs))
			response, e := s.Client.ReadConversationText(ctx, row.Execution(), runIDs[start:end])
			if e != nil {
				return nil, e
			}
			body := object(response)
			items, ok := body["items"].([]any)
			if body["conversationId"] != row.ID || body["sessionId"] != row.SessionID || !ok {
				return nil, streamInvalid()
			}
			allowed := map[string]bool{}
			for _, id := range runIDs[start:end] {
				allowed[id] = true
			}
			for _, v := range items {
				textItem := object(v)
				id := text(textItem, "runId")
				if textItem == nil || !allowed[id] || texts[id] != nil {
					return nil, streamInvalid()
				}
				for _, key := range []string{"userInput", "content"} {
					if value := textItem[key]; value != nil {
						if _, valid := value.(string); !valid {
							return nil, streamInvalid()
						}
					}
				}
				for _, key := range []string{"createdAt", "completedAt"} {
					if value := textItem[key]; value != nil {
						if _, valid := index(value); !valid {
							return nil, streamInvalid()
						}
					}
				}
				texts[id] = textItem
			}
		}
		for _, item := range selected {
			value := texts[item.runID]
			if value == nil {
				continue
			}
			input := value["userInput"]
			if item.origin != nil && *item.origin == "operation-feedback" {
				input = nil
			}
			var origin, parent any
			if item.origin != nil {
				origin = *item.origin
			}
			if item.parent != nil {
				parent = *item.parent
			}
			runs = append(runs, Object{"runId": item.runID, "operationId": item.operation, "origin": origin, "parentOperationId": parent, "logicalTurnId": item.root, "userInput": input, "content": value["content"], "createdAt": value["createdAt"], "sentAt": item.sentAt.Unix(), "completedAt": value["completedAt"], "displayOnly": true})
		}
	}
	at := s.now().Unix()
	return Object{"domain": domain, "conversationId": readConversationID(current), "runs": runs, "hasMore": hasMore, "nextCursor": next, "contextChanged": false, "checkedAt": at}, nil
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
