package agentos

import (
	"context"

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
		value, err := revalidate(ctx, actor, row.Domain, refs)
		if err != nil {
			return SourceQualification{}, err
		}
		if value["valid"] != true {
			return SourceQualification{}, nil
		}
		current, ok := value["refs"].([]any)
		if !ok || len(current) != len(refs) {
			return SourceQualification{}, fail("operations_agentos_source_qualification_unavailable", 503)
		}
		deadline := s.now().Unix() + 30
		for _, ref := range current {
			expires, ok := index(object(ref)["readExpiresAt"])
			if !ok || expires <= s.now().Unix() {
				return SourceQualification{}, fail("operations_agentos_source_qualification_unavailable", 503)
			}
			if expires < deadline {
				deadline = expires
			}
		}
		return SourceQualification{Valid: true, ReadExpiresAt: deadline}, nil
	}
}

// rememberSources pins only the original controlled/public prose descriptors.
// Aggregate observations do not invalidate a conversation when counts change.
// Inserts are deliberately per-reference commits, matching the existing Node
// consumer; replay keeps the first descriptor and rejects a changed version.
func (t *ConversationTools) rememberSources(ctx context.Context, row Conversation, value any) error {
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
		canonical, err := identity.Canonical([]any{ref["kind"], ref["id"]})
		if err != nil {
			return err
		}
		key := identity.Digest(canonical)
		_, err = s.Pool.Exec(ctx, `INSERT INTO operations_agentos_conversation_sources_v1(conversation_id,source_key,evidence_ref,created_at)
 VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, row.ID, key, ref, s.now())
		if err != nil {
			return err
		}
		var original Object
		if err = s.Pool.QueryRow(ctx, "SELECT evidence_ref FROM operations_agentos_conversation_sources_v1 WHERE conversation_id=$1 AND source_key=$2", row.ID, key).Scan(&original); err != nil {
			return err
		}
		if !sameConversationJSON(original["version"], ref["version"]) {
			return fail("operations_agentos_source_changed", 409)
		}
	}
	return nil
}
