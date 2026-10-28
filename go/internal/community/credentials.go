package community

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/credentials"
	"github.com/jackc/pgx/v5"
)

type CredentialConditions struct{ Service *credentials.Service }

func (c CredentialConditions) Validate(_ context.Context, _ pgx.Tx, rule Object) error {
	if str(rule, "kind") != "external-credential" || c.Service == nil {
		return fail("forum_condition_unavailable", 409)
	}
	for _, condition := range c.Service.SupportedConditions() {
		if condition["issuerId"] == rule["issuerId"] && condition["conditionId"] == rule["conditionId"] {
			return nil
		}
	}
	return fail("forum_condition_unavailable", 409)
}
func (c CredentialConditions) Matches(ctx context.Context, tx pgx.Tx, account string, rule Object) (bool, error) {
	if str(rule, "kind") != "external-credential" || c.Service == nil {
		return false, nil
	}
	return c.Service.HasConditionWithin(ctx, tx, account, str(rule, "issuerId"), str(rule, "conditionId"))
}
func (c CredentialConditions) SupportedConditions() []Object {
	if c.Service == nil {
		return []Object{}
	}
	return c.Service.SupportedConditions()
}
