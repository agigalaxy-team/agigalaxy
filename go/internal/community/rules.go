package community

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/jackc/pgx/v5"
)

type ruleEvaluation = businessrules.Evaluation

func evaluateRules(policy Object, target, account string, facts Object, text string, links []any) (ruleEvaluation, error) {
	return businessrules.Evaluate(policy, target, account, facts, &text, links)
}
func (s *Service) enforceRules(ctx context.Context, tx pgx.Tx, account, target, operation string, p Object) error {
	if s.Rules != nil {
		return s.Rules.Enforce(ctx, tx, account, target, operation, p)
	}
	service := businessrules.Service{Endpoint: s.Endpoint, PromotionDays: s.PromotionDays, Now: s.Now}
	text := str(p, "body")
	if target == "forum-post" {
		text = str(p, "title") + "\n" + text
	}
	links, _ := p["links"].([]any)
	attachments, _ := p["attachments"].([]any)
	count := int64(len(attachments))
	_, e := service.EnforceWithin(ctx, tx, businessrules.Input{AccountID: account, Target: target, OperationRef: operation, Stage: "write", Text: &text, Links: links, AttachmentCount: &count})
	return e
}
