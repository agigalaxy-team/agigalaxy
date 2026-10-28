package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
)

var eventTargetTypes = []string{"content-post", "content-reply", "content-section", "account", "business-account", "community-report", "chat-report", "feedback", "project", "method", "file-chat", "file-forum", "file-cleanup-plan", "messaging-plan", "recommendation-policy", "search-quality", "rule-key", "maintenance", "ai-role", "ai-role-assignment", "ai-work-account", "strategy", "strategy-configuration", "strategy-run"}

type Event struct {
	ID, Domain, Key, Type               string
	TargetType, TargetID, SourceVersion *string
}

// EmitWithin records only the original closed event locator, in the same
// transaction as its business commit. It copies no body, reason or prompt.
func (s *Service) EmitWithin(ctx context.Context, tx pgx.Tx, in Event) (*string, error) {
	targetType, targetID := "", ""
	if in.TargetType != nil {
		targetType = *in.TargetType
	}
	if in.TargetID != nil {
		targetID = *in.TargetID
	}
	if !has(domains, in.Domain) || !safeCode.MatchString(in.Type) || in.Key == "" || protocol.TextLength(in.Key) > 300 || targetType != "" && !has(eventTargetTypes, targetType) || (targetType != "") != (targetID != "") {
		return nil, fault.New("operations_autonomy_event_invalid", 400)
	}
	if in.ID == "" {
		in.ID = uuid.NewString()
	}
	row, e := optional(ctx, tx, `INSERT INTO operations_autonomy_events_v1(id,endpoint,domain,event_key,event_type,target_type,target_id,source_version,created_at,available_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(endpoint,event_key) DO NOTHING RETURNING jsonb_build_object('id',id)`, in.ID, s.Endpoint, in.Domain, in.Key, in.Type, in.TargetType, in.TargetID, in.SourceVersion, s.now(), s.now().Add(time.Duration(s.defaultNumber("eventCoalesceSeconds"))*time.Second))
	if e != nil || row == nil {
		return nil, e
	}
	id := str(row["id"])
	return &id, nil
}
