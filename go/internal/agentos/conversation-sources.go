package agentos

import (
	"context"
	"sort"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
)

// SourceValidator binds the original conversation contextValid consumer to the
// current operations query service. Saved evidence is only a read locator: the
// reader must repeat its actual fixed-AI and current source authorization.
func (s *Conversations) SourceValidator(revalidate func(context.Context, operationspermissions.Actor, string, []Object) (Object, error)) func(context.Context, Conversation, operationspermissions.Actor) (SourceQualification, error) {
	return func(ctx context.Context, row Conversation, actor operationspermissions.Actor) (SourceQualification, error) {
		if s == nil || s.Pool == nil {
			return SourceQualification{}, fail("operations_authorization_unavailable", 503)
		}
		rows, err := s.Pool.Query(ctx, "SELECT evidence_ref FROM operations_agentos_conversation_sources_v1 WHERE conversation_id=$1", row.ID)
		if err != nil {
			return SourceQualification{}, err
		}
		refs := []Object{}
		for rows.Next() {
			var reference Object
			if err = rows.Scan(&reference); err != nil {
				rows.Close()
				return SourceQualification{}, err
			}
			refs = append(refs, reference)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return SourceQualification{}, err
		}
		if len(refs) == 0 {
			return SourceQualification{Valid: true, ReadExpiresAt: s.now().Unix() + 30}, nil
		}
		if revalidate == nil {
			return SourceQualification{}, fail("operations_agentos_conversation_not_ready", 503)
		}
		originals := make([]Object, len(refs))
		for i, ref := range refs {
			originals[i] = copyObject(ref)
			delete(originals[i], "conversationTurnId")
		}
		affected := map[string]bool{}
		legacy := false
		deadline := s.now().Unix() + 30
		for start := 0; start < len(refs); start += 300 {
			end := min(start+300, len(refs))
			value, err := revalidate(ctx, actor, row.Domain, originals[start:end])
			if err != nil {
				return SourceQualification{}, err
			}
			indexes, ok := value["invalidIndexes"].([]any)
			if !ok {
				return SourceQualification{}, fail("operations_agentos_source_qualification_unavailable", 503)
			}
			invalid := map[int]bool{}
			for _, raw := range indexes {
				n, ok := index(raw)
				if !ok || n < 0 || n >= int64(end-start) || invalid[int(n)] {
					return SourceQualification{}, fail("operations_agentos_source_qualification_unavailable", 503)
				}
				invalid[int(n)] = true
				turn := text(refs[start+int(n)], "conversationTurnId")
				if validOperationID(turn) {
					affected[turn] = true
				} else {
					legacy = true
				}
			}
			current, ok := value["refs"].([]any)
			valid, validType := value["valid"].(bool)
			if !ok || !validType || len(current)+len(invalid) != end-start || valid != (len(invalid) == 0) {
				return SourceQualification{}, fail("operations_agentos_source_qualification_unavailable", 503)
			}
			for _, ref := range current {
				expires, ok := index(object(ref)["readExpiresAt"])
				if !ok || expires <= s.now().Unix() {
					return SourceQualification{}, fail("operations_agentos_source_qualification_unavailable", 503)
				}
				if expires < deadline {
					deadline = expires
				}
			}
		}
		safe := map[string]bool{}
		if legacy {
			rows, err := s.Pool.Query(ctx, `SELECT id::text FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3 AND result->>'sourceQualificationVersion'='1'`, s.Endpoint, row.ID, row.OperatorID)
			if err != nil {
				return SourceQualification{}, err
			}
			for rows.Next() {
				var turn string
				if err = rows.Scan(&turn); err != nil {
					rows.Close()
					return SourceQualification{}, err
				}
				safe[turn] = true
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return SourceQualification{}, err
			}
		}
		return SourceQualification{Valid: true, ReadExpiresAt: deadline, AffectedTurns: affected, LegacyUnknown: legacy, LegacySafeTurns: safe}, nil
	}
}

// rememberSources pins only the original controlled/public prose descriptors.
// Aggregate observations do not invalidate a conversation when counts change.
// A descriptor is bound to the server-owned turn and version; old versions
// stay available for later revalidation without preventing a fresh read.
func (t *ConversationTools) rememberSources(ctx context.Context, row Conversation, turnID string, value any) error {
	if !validOperationID(turnID) {
		return fail("operations_agentos_scope_denied", 403)
	}
	refs, _ := value.([]any)
	if objects, ok := value.([]Object); ok {
		for _, ref := range objects {
			refs = append(refs, ref)
		}
	}
	s := t.Conversations
	for _, value := range refs {
		ref := object(value)
		if ref["purpose"] != "public-content" && ref["controlledSource"] != true {
			continue
		}
		if ref["version"] == nil {
			return fail("operations_agentos_source_qualification_unavailable", 503)
		}
		canonical, err := identity.Canonical([]any{turnID, ref["kind"], ref["id"], ref["version"]})
		if err != nil {
			return err
		}
		key := identity.Digest(canonical)
		ref = copyObject(ref)
		ref["conversationTurnId"] = turnID
		_, err = s.Pool.Exec(ctx, `INSERT INTO operations_agentos_conversation_sources_v1(conversation_id,source_key,evidence_ref,created_at)
 VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, row.ID, key, ref, s.now())
		if err != nil {
			return err
		}

	}
	return nil
}

// View contains only server-owned turn coordinates, never source text.
func (q SourceQualification) View() Object {
	turns := make([]string, 0, len(q.AffectedTurns))
	for turn, restricted := range q.AffectedTurns {
		if restricted {
			turns = append(turns, turn)
		}
	}
	sort.Strings(turns)
	safe := make([]string, 0, len(q.LegacySafeTurns))
	for turn, allowed := range q.LegacySafeTurns {
		if allowed {
			safe = append(safe, turn)
		}
	}
	sort.Strings(safe)
	return Object{"affectedTurns": turns, "legacyUnknown": q.LegacyUnknown, "legacySafeTurns": safe}
}
func (q SourceQualification) restricts(turn string) bool {
	return q.AffectedTurns[turn] || q.LegacyUnknown && !q.LegacySafeTurns[turn]
}

// Saved task projections are not current source authority. Keep user objective
// and action states while removing derived prose for restricted source turns.
func restrictTaskContext(q SourceQualification, progress, task, feedback Object) (Object, Object, Object) {
	if task != nil {
		task = copyObject(task)
		if q.restricts(text(task, "rootOperationId")) {
			task["remaining"] = []any{}
			if progress != nil {
				progress = copyObject(progress)
				progress["remaining"] = []any{}
				progress["reason"] = nil
			}
		}
		if history, ok := task["actionHistory"].([]Object); ok {
			filtered := make([]Object, 0, len(history))
			for _, item := range history {
				if q.restricts(text(item, "parentTurnId")) {
					item = copyObject(item)
					item["presentation"] = nil
					receipt := copyObject(object(item["receipt"]))
					receipt["summary"] = nil
					item["receipt"] = receipt
				}
				filtered = append(filtered, item)
			}
			task["actionHistory"] = filtered
		}
	}
	if feedback != nil && q.restricts(text(feedback, "parentTurnId")) {
		feedback = copyObject(feedback)
		feedback["presentation"] = nil
		receipt := copyObject(object(feedback["receipt"]))
		receipt["summary"] = nil
		feedback["receipt"] = receipt
	}
	return progress, task, feedback
}
