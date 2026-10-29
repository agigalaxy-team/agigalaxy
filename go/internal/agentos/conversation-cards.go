package agentos

import (
	"bytes"
	"context"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type conversationCard struct {
	ID, ConversationID, TurnID, OperatorID, Domain, OperationID, State string
	Proposal, Result                                                   Object
	CreatedAt, UpdatedAt                                               time.Time
}

const conversationCardColumns = "id::text,conversation_id::text,turn_id::text,operator_id,domain,operation_id::text,state,proposal,result,created_at,updated_at"

func cardScanFields(value *conversationCard) []any {
	return []any{&value.ID, &value.ConversationID, &value.TurnID, &value.OperatorID, &value.Domain, &value.OperationID, &value.State, &value.Proposal, &value.Result, &value.CreatedAt, &value.UpdatedAt}
}

func readConversationCard(row pgx.Row) (*conversationCard, error) {
	var value conversationCard
	err := row.Scan(cardScanFields(&value)...)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return &value, err
}

func managementCardRead(kind string) (string, error) {
	switch kind {
	case "ai-role-command":
		return "ai.roles.read", nil
	case "ai-work-prompt-save":
		return "ai.prompts.read", nil
	}
	return "", fail("operations_agentos_conversation_not_ready", 503)
}

func (t *ConversationTools) cardReadPermission(kind string) (string, error) {
	if permission, e := managementCardRead(kind); e == nil {
		return permission, nil
	}
	if t.CardReadPermission != nil {
		return t.CardReadPermission(kind)
	}
	return "", fail("operations_agentos_conversation_not_ready", 503)
}
func (t *ConversationTools) recoverPrepared(ctx context.Context, a operationspermissions.Actor, proposal Object, operation string) (Object, error) {
	if _, e := managementCardRead(text(proposal, "kind")); e == nil {
		return t.Conversations.Permissions.RecoverManagementAction(ctx, a, proposal, operation)
	}
	if t.RecoverPrepared != nil {
		return t.RecoverPrepared(ctx, a, proposal, operation)
	}
	return nil, fail("operations_agentos_conversation_not_ready", 503)
}

func cardAttempted(row *conversationCard) bool {
	_, a := row.Proposal["confirmationAttemptedAt"]
	_, b := row.Result["confirmationAttemptedAt"]
	return a || b
}

func sameConversationJSON(a, b any) bool {
	left, e := identity.Canonical(a)
	if e != nil {
		return false
	}
	right, e := identity.Canonical(b)
	return e == nil && bytes.Equal(left, right)
}

func (t *ConversationTools) cardActorWithin(ctx context.Context, tx pgx.Tx, human operationspermissions.Actor, row *conversationCard) (operationspermissions.Actor, error) {
	s := t.Conversations
	permission, err := t.cardReadPermission(text(row.Proposal, "kind"))
	if err != nil {
		return operationspermissions.Actor{}, err
	}
	var operator, domain string
	var account *string
	err = tx.QueryRow(ctx, `SELECT operator_id,domain,ai_account_id::text FROM operations_agentos_conversations_v1 WHERE endpoint=$1 AND id=$2`, s.Endpoint, row.ConversationID).Scan(&operator, &domain, &account)
	if err != nil {
		return operationspermissions.Actor{}, err
	}
	if human.ID != row.OperatorID || operator != human.ID || domain != row.Domain {
		return operationspermissions.Actor{}, fail("operations_agentos_scope_denied", 403)
	}
	if account == nil {
		return operationspermissions.Actor{}, fail("operations_ai_work_unassigned", 403)
	}
	// A completed action can retire its own source. The original card is still
	// readable through current human/fixed-AI read authority, not that prose lease.
	purpose := "query"
	if text(row.Proposal, "kind") == "private-case-message" {
		purpose = "prepare"
	}
	return s.Permissions.HumanAIAccountWithin(ctx, tx, human, row.Domain, *account, purpose, permission)
}

func (t *ConversationTools) cardActor(ctx context.Context, human operationspermissions.Actor, row *conversationCard) (operationspermissions.Actor, error) {
	return postgres.InTx(ctx, t.Conversations.Pool, func(tx pgx.Tx) (operationspermissions.Actor, error) { return t.cardActorWithin(ctx, tx, human, row) })
}

func (t *ConversationTools) ownedCard(ctx context.Context, human operationspermissions.Actor, domain, id string) (*conversationCard, error) {
	if !validConversationDomain(domain) || !validOperationID(id) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	s := t.Conversations
	row, err := readConversationCard(s.Pool.QueryRow(ctx, `SELECT `+conversationCardColumns+` FROM operations_agentos_conversation_cards_v1 WHERE endpoint=$1 AND id=$2 AND operator_id=$3 AND domain=$4`, s.Endpoint, id, human.ID, domain))
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, fail("operations_agentos_operation_not_found", 404)
	}
	_, err = t.cardActor(ctx, human, row)
	return row, err
}

func (t *ConversationTools) assertCardBound(ctx context.Context, row *conversationCard) error {
	s := t.Conversations
	returnErr := func(tx pgx.Tx) (bool, error) {
		var result Object
		err := tx.QueryRow(ctx, `SELECT result FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND id=$2 AND conversation_id=$3 AND operator_id=$4`, s.Endpoint, row.TurnID, row.ConversationID, row.OperatorID).Scan(&result)
		if err != nil {
			return false, err
		}
		if result["taskId"] == nil {
			return true, nil
		}
		if t.BoundedProposalWithin == nil {
			return false, fail("operations_agentos_conversation_not_ready", 503)
		}
		current, err := s.CurrentWithin(ctx, tx, row.ConversationID, nil)
		if err != nil {
			return false, err
		}
		return true, t.BoundedProposalWithin(ctx, tx, *current.Row, Object{"id": row.TurnID, "result": result}, row.Proposal)
	}
	_, err := postgres.InTx(ctx, s.Pool, returnErr)
	return err
}

func (t *ConversationTools) prepareCard(ctx context.Context, bound boundConversationTool, input Object) (Object, error) {
	s := t.Conversations
	if bound.publicReference == nil && t.Prepare == nil || bound.publicReference != nil && t.PrepareWithReference == nil {
		return nil, fail("operations_agentos_conversation_not_ready", 503)
	}
	digest, err := conversationArgumentsDigest(bound.args, bound.publicReference)
	if err != nil {
		return nil, err
	}
	query := `SELECT ` + conversationCardColumns + ` FROM operations_agentos_conversation_cards_v1 WHERE endpoint=$1 AND turn_id=$2 AND request_digest=$3`
	row, err := readConversationCard(s.Pool.QueryRow(ctx, query, s.Endpoint, input["turnId"], digest))
	if err != nil {
		return nil, err
	}
	if row == nil {
		operationID := uuid.NewString()
		var proposal Object
		if bound.publicReference != nil {
			proposal, err = t.PrepareWithReference(ctx, bound.actor, bound.row, bound.args, operationID, bound.publicReference)
		} else {
			proposal, err = t.Prepare(ctx, bound.actor, bound.row, bound.args, operationID)
		}
		if err != nil {
			return nil, err
		}
		candidate := &conversationCard{ConversationID: bound.row.ID, OperatorID: bound.actor.ID, TurnID: text(input, "turnId"), Proposal: proposal}
		if err = t.assertCardBound(ctx, candidate); err != nil {
			return nil, err
		}
		proposal = copyObject(proposal)
		proposal["dismissalAllowed"] = true
		_, err = s.Pool.Exec(ctx, `INSERT INTO operations_agentos_conversation_cards_v1(id,endpoint,conversation_id,turn_id,tool_call_id,operator_id,domain,operation_id,request_digest,proposal,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'prepared',$11,$11) ON CONFLICT(endpoint,turn_id,request_digest) DO NOTHING`, uuid.NewString(), s.Endpoint, bound.row.ID, input["turnId"], bound.callID, bound.actor.ID, bound.row.Domain, operationID, digest, proposal, s.now())
		if err != nil {
			return nil, err
		}
		row, err = readConversationCard(s.Pool.QueryRow(ctx, query, s.Endpoint, input["turnId"], digest))
		if err != nil {
			return nil, err
		}
		if row == nil {
			return nil, fail("operations_agentos_conversation_not_ready", 503)
		}
	}
	card, err := t.cardView(ctx, bound.actor, row)
	if err != nil {
		return nil, err
	}
	return Object{"state": card["state"], "card": card, "decision": "human-confirmation-required", "effectExecuted": card["state"] == "completed"}, nil
}

func cardPublicResult(value Object) any {
	if value == nil {
		return nil
	}
	copy := copyObject(value)
	delete(copy, "confirmationAttemptedAt")
	return copy
}

type cardActorReader func(context.Context, *conversationCard) (operationspermissions.Actor, error)

func (t *ConversationTools) cardView(ctx context.Context, human operationspermissions.Actor, row *conversationCard) (Object, error) {
	return t.cardReadView(ctx, row, func(ctx context.Context, row *conversationCard) (operationspermissions.Actor, error) {
		return t.cardActor(ctx, human, row)
	}, true)
}

func (t *ConversationTools) cardReadView(ctx context.Context, row *conversationCard, reader cardActorReader, syncProjection bool) (Object, error) {
	actor, err := reader(ctx, row)
	if err != nil {
		return nil, err
	}
	s := t.Conversations
	p := row.Proposal
	capability := Object{"canConfirm": false, "canDismiss": false, "reason": nil}
	out := Object{"cardId": row.ID, "operationId": row.OperationID, "turnId": row.TurnID, "kind": p["kind"], "domain": row.Domain, "target": p["target"], "title": p["title"], "impact": p["impact"], "basis": p["basis"], "requiredAction": p["requiredAction"], "state": row.State, "result": cardPublicResult(row.Result), "checkedAt": nil, "readExpiresAt": nil, "capability": capability}
	deadline := s.now().Unix() + 30
	prompt := p["kind"] == "ai-work-prompt-save"
	if row.State == "prepared" {
		var current Object
		if t.PrepareStored != nil {
			current, err = t.PrepareStored(ctx, actor, Conversation{ID: row.ConversationID, Domain: row.Domain}, p, row.OperationID)
		} else if t.Prepare == nil || p["publicReference"] != nil {
			err = fail("operations_agentos_conversation_not_ready", 503)
		} else {
			current, err = t.Prepare(ctx, actor, Conversation{ID: row.ConversationID, Domain: row.Domain}, object(p["request"]), row.OperationID)
		}
		if err == nil {
			if sameConversationJSON(current["command"], p["command"]) && !cardAttempted(row) {
				capability["canConfirm"] = true
			} else {
				out["state"], capability["reason"] = "not-available", "operations_agentos_proposal_changed"
			}
			for _, key := range []string{"target", "title", "impact", "basis"} {
				out[key] = current[key]
			}
			if v, ok := index(current["readExpiresAt"]); ok && v < deadline {
				deadline = v
			}
			if prompt {
				if current["review"] == nil {
					capability["canConfirm"], out["state"], capability["reason"] = false, "not-available", "operations_agentos_prompt_review_unavailable"
				} else {
					out["review"] = current["review"]
				}
			}
		} else {
			if fault.Status(err) == 403 {
				return nil, err
			}
			out["state"], capability["reason"] = "not-available", fault.Code(err)
			target := object(p["target"])
			out["target"] = Object{"kind": target["kind"], "id": target["id"], "label": "原处理对象当前不可用", "href": nil}
			out["impact"], out["basis"] = []any{}, []any{}
		}
	} else if prompt {
		review := object(p["review"])
		if review != nil {
			current, e := s.Permissions.ReadManagementTool(ctx, actor, row.Domain, Object{"aiAccountId": review["aiAccountId"]})
			if e == nil && current["availability"] == "available" {
				out["review"] = review
				if v, ok := index(current["readExpiresAt"]); ok && v < deadline {
					deadline = v
				}
			} else {
				if fault.Status(e) == 403 {
					return nil, e
				}
				out["impact"], out["basis"] = []any{}, []any{}
			}
		} else {
			out["impact"], out["basis"] = []any{}, []any{}
		}
	}
	if row.State == "prepared" && capability["canConfirm"] == true {
		if err = t.assertCardBound(ctx, row); err != nil {
			capability["canConfirm"], capability["reason"] = false, fault.Code(err)
			delete(out, "review")
		}
	}
	capability["canDismiss"] = row.State == "prepared" && p["dismissalAllowed"] == true && !cardAttempted(row)
	if _, err = reader(ctx, row); err != nil {
		return nil, err
	}
	out["checkedAt"], out["readExpiresAt"] = s.now().Unix(), deadline
	if syncProjection && t.SyncCardWithin != nil {
		_, err = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) { return true, t.SyncCardWithin(ctx, tx, row.ID) })
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (t *ConversationTools) Card(ctx context.Context, human operationspermissions.Actor, domain, id string) (Object, error) {
	row, err := t.ownedCard(ctx, human, domain, id)
	if err != nil {
		return nil, err
	}
	return t.readCard(ctx, human, row, func(ctx context.Context, row *conversationCard) (operationspermissions.Actor, error) {
		return t.cardActor(ctx, human, row)
	}, true)
}

func (t *ConversationTools) readCard(ctx context.Context, human operationspermissions.Actor, row *conversationCard, reader cardActorReader, syncProjection bool) (Object, error) {
	if row.State == "processing" || row.State == "unknown" {
		actor, err := reader(ctx, row)
		if err != nil {
			return nil, err
		}
		recovered, err := t.recoverPrepared(ctx, actor, row.Proposal, row.OperationID)
		if err != nil {
			if fault.Status(err) == 403 {
				return nil, err
			}
			recovered = Object{"operationId": row.OperationID, "state": "unknown", "summary": "正在读取这次处理的原结果。", "code": fault.Code(err)}
		}
		state := text(recovered, "state")
		if state == "failed" {
			state = "not-available"
		}
		if state == "not-recorded" || state == "prepared" {
			state = "unknown"
		}
		switch state {
		case "completed", "processing", "unknown", "not-available":
			recovered = copyObject(recovered)
			recovered["state"] = state
			if attempt, ok := row.Result["confirmationAttemptedAt"]; ok {
				recovered["confirmationAttemptedAt"] = attempt
			}
			// An unchanged observed receipt needs neither a CAS write nor a second
			// per-card row/IAM read. A concurrent later receipt remains authoritative.
			if state == row.State && sameConversationJSON(row.Result, recovered) {
				break
			}
			s := t.Conversations
			// A receipt read may observe the same unknown/processing result.
			// Preserve CAS, but do not turn that observation into a new agentos
			// event just by advancing updated_at.
			changed, err := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (*conversationCard, error) {
				changed, e := readConversationCard(tx.QueryRow(ctx, `UPDATE operations_agentos_conversation_cards_v1 SET state=$3,result=$4,updated_at=$5 WHERE endpoint=$1 AND id=$2 AND state=$6 AND updated_at=$7 AND (state IS DISTINCT FROM $3 OR result IS DISTINCT FROM $4::jsonb) RETURNING `+conversationCardColumns, s.Endpoint, row.ID, state, recovered, s.now(), row.State, row.UpdatedAt))
				if e == nil && changed != nil && t.SyncCardWithin != nil {
					e = t.SyncCardWithin(ctx, tx, row.ID)
				}
				return changed, e
			})
			if err != nil {
				return nil, err
			}
			if changed != nil {
				row = changed
				syncProjection = false
			} else {
				row, err = t.ownedCard(ctx, human, row.Domain, row.ID)
				if err != nil {
					return nil, err
				}
			}
		}
	}
	return t.cardReadView(ctx, row, reader, syncProjection)
}

func (t *ConversationTools) Cards(ctx context.Context, human operationspermissions.Actor, domain string) ([]Object, error) {
	return t.readCardBatch(ctx, human, domain)
}
