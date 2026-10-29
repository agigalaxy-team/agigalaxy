package agentos

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Conversation struct {
	ID, OperatorID, Domain, PermissionKey, SessionID string
	AIAccountID                                      *string
	RetiredAt                                        *time.Time
}

func (row Conversation) Execution() Execution {
	return Execution{ID: row.ID, Mode: "conversation", Domain: row.Domain, SessionID: row.SessionID}
}
func (row Conversation) View() Object {
	return Object{"id": row.ID, "domain": row.Domain, "sessionId": row.SessionID, "mode": "conversation", "operatorId": row.OperatorID, "actions": []any{}, "resourceIds": []any{}, "hasPreparedCommand": false}
}

type CurrentConversation struct {
	Row            *Conversation
	Actor          operationspermissions.Actor
	ContextChanged bool
	ReadExpiresAt  int64
}

// SourceQualification is a current read result, not a retained descriptor's
// old freshness timestamp. Its deadline must include every controlled source.
type SourceQualification struct {
	Valid         bool
	ReadExpiresAt int64
}
type Conversations struct {
	Pool                  *pgxpool.Pool
	Endpoint              string
	Permissions           *operationspermissions.Service
	Client                *Client
	Now                   func() time.Time
	ValidateSources       func(context.Context, Conversation, operationspermissions.Actor) (SourceQualification, error)
	LinkWorkbenchWithin   func(context.Context, pgx.Tx, Conversation, string, string) error
	UpdateWorkbenchWithin func(context.Context, pgx.Tx, string, Object) error
	SyncWorkbenchRuns     func(context.Context, Conversation, []Object) error
	ToolCards             func(context.Context, operationspermissions.Actor, string) ([]Object, error)
	Diagnostic            func(string, string)
	Tools                 *ConversationTools
}

func (s *Conversations) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}
func permissionKey(actor operationspermissions.Actor) string {
	permissions := append([]string{}, actor.Permissions...)
	sort.Strings(permissions)
	raw, _ := protocol.Encode([]any{actor.Version, permissions})
	return identity.Digest(raw)
}
func conversationRow(row pgx.Row) (*Conversation, error) {
	var result Conversation
	err := row.Scan(&result.ID, &result.OperatorID, &result.Domain, &result.PermissionKey, &result.SessionID, &result.AIAccountID, &result.RetiredAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &result, nil
}

const conversationColumns = "id::text,operator_id,domain,permission_key,session_id::text,ai_account_id::text,retired_at"

func (s *Conversations) Session(ctx context.Context, actor operationspermissions.Actor, domain string, create bool) (CurrentConversation, error) {
	return s.session(ctx, actor, domain, create, false)
}

func (s *Conversations) readSession(ctx context.Context, actor operationspermissions.Actor, domain string) (CurrentConversation, error) {
	return s.session(ctx, actor, domain, false, true)
}

func (s *Conversations) session(ctx context.Context, actor operationspermissions.Actor, domain string, create, readSnapshot bool) (CurrentConversation, error) {
	if s == nil || s.Pool == nil || s.Permissions == nil {
		return CurrentConversation{}, fail("operations_authorization_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (CurrentConversation, error) {
		require := s.Permissions.HumanAIWithin
		if readSnapshot {
			require = s.Permissions.HumanAIReadWithin
		}
		current, err := require(ctx, tx, actor, domain, "conversation", "workbench.read")
		if err != nil {
			return CurrentConversation{}, err
		}
		work, err := s.Permissions.AIWorkContext(current)
		if err != nil {
			return CurrentConversation{}, err
		}
		account, _ := work["accountId"].(string)
		key := permissionKey(current)
		read := func() (*Conversation, error) {
			return conversationRow(tx.QueryRow(ctx, "SELECT "+conversationColumns+" FROM operations_agentos_conversations_v1 WHERE endpoint=$1 AND operator_id=$2 AND domain=$3 AND permission_key=$4 AND ai_account_id=$5 AND retired_at IS NULL", s.Endpoint, current.ID, domain, key, account))
		}
		row, err := read()
		if err != nil {
			return CurrentConversation{}, err
		}
		if row == nil && create {
			_, err = tx.Exec(ctx, `INSERT INTO operations_agentos_conversations_v1(id,endpoint,operator_id,domain,permission_key,session_id,created_at,ai_account_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(endpoint,operator_id,domain,permission_key) WHERE retired_at IS NULL DO NOTHING`, uuid.NewString(), s.Endpoint, current.ID, domain, key, uuid.NewString(), s.now(), account)
			if err != nil {
				return CurrentConversation{}, err
			}
			row, err = read()
			if err != nil {
				return CurrentConversation{}, err
			}
			if row == nil {
				return CurrentConversation{}, fail("operations_agentos_conversation_not_ready", 503)
			}
		}
		return CurrentConversation{Row: row, Actor: current}, nil
	})
}
func (s *Conversations) CurrentWithin(ctx context.Context, tx pgx.Tx, id string, operator *operationspermissions.Actor) (CurrentConversation, error) {
	return s.currentWithin(ctx, tx, id, operator, false)
}

// CurrentReadWithin revalidates the durable owner and fixed AI once in this
// transaction for a pure read. It does not authorize preparation or execution,
// or replace the independent current/source check before returning a result.
func (s *Conversations) CurrentReadWithin(ctx context.Context, tx pgx.Tx, id string, operator *operationspermissions.Actor) (CurrentConversation, error) {
	return s.currentWithin(ctx, tx, id, operator, true)
}

func (s *Conversations) currentWithin(ctx context.Context, tx pgx.Tx, id string, operator *operationspermissions.Actor, readSnapshot bool) (CurrentConversation, error) {
	if s == nil || s.Permissions == nil {
		return CurrentConversation{}, fail("operations_authorization_unavailable", 503)
	}
	row, err := conversationRow(tx.QueryRow(ctx, "SELECT "+conversationColumns+" FROM operations_agentos_conversations_v1 WHERE endpoint=$1 AND id=$2", s.Endpoint, id))
	if err != nil {
		return CurrentConversation{}, err
	}
	if row == nil || operator != nil && row.OperatorID != operator.ID {
		return CurrentConversation{}, fail("operations_agentos_conversation_not_found", 404)
	}
	if row.RetiredAt != nil {
		return CurrentConversation{}, fail("operations_agentos_source_changed", 409)
	}
	if row.AIAccountID == nil || *row.AIAccountID == "" {
		return CurrentConversation{}, fail("operations_ai_work_unassigned", 403)
	}
	var current operationspermissions.Actor
	if operator == nil {
		require := s.Permissions.StoredHumanAIWithin
		if readSnapshot {
			require = s.Permissions.StoredHumanAIReadWithin
		}
		current, err = require(ctx, tx, row.OperatorID, row.Domain, *row.AIAccountID, "conversation", "workbench.read")
	} else {
		require := s.Permissions.HumanAIAccountWithin
		if readSnapshot {
			require = s.Permissions.HumanAIAccountReadWithin
		}
		current, err = require(ctx, tx, *operator, row.Domain, *row.AIAccountID, "conversation", "workbench.read")
	}
	if err != nil {
		return CurrentConversation{}, err
	}
	if permissionKey(current) != row.PermissionKey {
		return CurrentConversation{}, fail("operations_agentos_authority_changed", 403)
	}
	return CurrentConversation{Row: row, Actor: current}, nil
}
func (s *Conversations) Current(ctx context.Context, id string, operator *operationspermissions.Actor) (CurrentConversation, error) {
	return s.current(ctx, id, operator, false)
}

// CurrentRead includes the same live source validation and expiry as Current.
// Each invocation reads fresh authority; no snapshot survives this request.
func (s *Conversations) CurrentRead(ctx context.Context, id string, operator *operationspermissions.Actor) (CurrentConversation, error) {
	return s.current(ctx, id, operator, true)
}

func (s *Conversations) current(ctx context.Context, id string, operator *operationspermissions.Actor, readSnapshot bool) (CurrentConversation, error) {
	if s == nil || s.Pool == nil {
		return CurrentConversation{}, fail("operations_authorization_unavailable", 503)
	}
	current, err := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (CurrentConversation, error) {
		return s.currentWithin(ctx, tx, id, operator, readSnapshot)
	})
	if err != nil {
		return current, err
	}
	if s.ValidateSources != nil {
		qualification, err := s.ValidateSources(ctx, *current.Row, current.Actor)
		if err != nil {
			return current, err
		}
		if !qualification.Valid {
			_, err = s.Pool.Exec(ctx, "UPDATE operations_agentos_conversations_v1 SET retired_at=$3,retirement_reason='source-changed' WHERE endpoint=$1 AND id=$2 AND retired_at IS NULL", s.Endpoint, id, s.now())
			if err != nil {
				return current, err
			}
			return current, fail("operations_agentos_source_changed", 409)
		}
		current.ReadExpiresAt = qualification.ReadExpiresAt
	} else {
		var refs bool
		if err = s.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM operations_agentos_conversation_sources_v1 WHERE conversation_id=$1)", id).Scan(&refs); err != nil {
			return current, err
		}
		if refs {
			return current, fail("operations_agentos_conversation_not_ready", 503)
		}
		current.ReadExpiresAt = s.now().Unix() + 30
	}
	if current.ReadExpiresAt <= s.now().Unix() {
		return current, fail("operations_agentos_source_qualification_unavailable", 503)
	}
	return current, nil
}
func (s *Conversations) AuthorizeNative(ctx context.Context, input Object) (Object, error) {
	id, ok := input["conversationId"].(string)
	if !ok || len(id) != 36 || uuid.Validate(id) != nil || input["operation"] != "read" && input["operation"] != "run" {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	for key, value := range input {
		switch key {
		case "conversationId", "operation":
		case "resourceType":
			if value != nil && value != "agents" && value != "workflows" {
				return nil, fail("invalid_operations_agentos_request", 400)
			}
		case "resourceId":
			if value != nil {
				v, ok := value.(string)
				if !ok || len([]rune(v)) < 1 || len([]rune(v)) > 100 {
					return nil, fail("invalid_operations_agentos_request", 400)
				}
			}
		default:
			return nil, fail("invalid_operations_agentos_request", 400)
		}
	}
	current, err := s.Current(ctx, id, nil)
	if err != nil {
		return nil, err
	}
	row := current.Row
	component := "galaxy-conversation-" + row.Domain
	if value := input["resourceType"]; value != nil && value != "agents" {
		return nil, fail("operations_agentos_domain_mismatch", 403)
	}
	if value := input["resourceId"]; value != nil && value != component {
		return nil, fail("operations_agentos_domain_mismatch", 403)
	}
	var configuration []byte
	var version int64
	err = s.Pool.QueryRow(ctx, "SELECT configuration,prompt_version FROM operations_autonomy_configs_v1 WHERE endpoint=$1 AND domain=$2", s.Endpoint, row.Domain).Scan(&configuration, &version)
	var prompt any
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if err == nil {
		var data Object
		if protocol.Decode(configuration, &data) != nil {
			return nil, fail("operations_agentos_role_prompt_unavailable", 503)
		}
		text, ok := data["prompt"].(string)
		if !ok || len([]rune(text)) > 16000 || version < 1 || version > 9007199254740991 {
			return nil, fail("operations_agentos_role_prompt_unavailable", 503)
		}
		prompt = Object{"version": version, "text": text}
	}
	if current, err = s.Current(ctx, id, nil); err != nil {
		return nil, err
	}
	view := row.View()
	view["rolePrompt"] = prompt
	return Object{"allowed": true, "resourceIds": []any{component}, "execution": view, "readExpiresAt": current.ReadExpiresAt}, nil
}
