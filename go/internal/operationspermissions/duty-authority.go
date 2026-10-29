package operationspermissions

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/jackc/pgx/v5"
	"net/http"
)

// DutyAuthority is the server-attested durable task half of business authority.
// Its implementations must reject reconstructed public Actor fields/metadata.
type DutyAuthority interface {
	AcceptsDuty(Actor) bool
	RequireDutyAction(context.Context, pgx.Tx, Actor, string, string) (Actor, error)
	RequireDutyOperation(context.Context, pgx.Tx, Actor, []string, Object, *string) (Actor, error)
	DutyMetadata(Actor) (Object, error)
}

// BusinessAuthority keeps HTTP/cookie and stored-person authentication in the
// existing human authority. Internal duties only enter with its opaque proof.
type BusinessAuthority struct {
	Human     Authority
	Duty      DutyAuthority
	Execution ExecutionAuthority
}

func (a *BusinessAuthority) AuthorizeOperations(r *http.Request, write bool, action string) (Actor, error) {
	if a == nil || a.Human == nil {
		return Actor{}, fail("operations_authorization_unavailable", 503)
	}
	return a.Human.AuthorizeOperations(r, write, action)
}
func (a *BusinessAuthority) RequireWithin(ctx context.Context, tx pgx.Tx, actor Actor, action string) (Actor, error) {
	if a != nil && a.Execution != nil && a.Execution.AcceptsExecution(actor) {
		return a.Execution.RequireExecutionAction(ctx, tx, actor, action)
	}
	if a != nil && a.Duty != nil && a.Duty.AcceptsDuty(actor) {
		return a.Duty.RequireDutyAction(ctx, tx, actor, action, "")
	}
	if a == nil || a.Human == nil {
		return Actor{}, fail("operations_authorization_unavailable", 503)
	}
	return a.Human.RequireWithin(ctx, tx, actor, action)
}
func (a *BusinessAuthority) EffectiveWithin(ctx context.Context, tx pgx.Tx, actor Actor) (Actor, error) {
	if a != nil && a.Execution != nil && a.Execution.AcceptsExecution(actor) {
		return a.Execution.RequireExecutionAction(ctx, tx, actor, "")
	}
	if a != nil && a.Duty != nil && a.Duty.AcceptsDuty(actor) {
		return a.Duty.RequireDutyAction(ctx, tx, actor, "workbench.read", "")
	}
	if a == nil || a.Human == nil {
		return Actor{}, fail("operations_authorization_unavailable", 503)
	}
	return a.Human.EffectiveWithin(ctx, tx, actor)
}
func (a *BusinessAuthority) PersonWithin(ctx context.Context, tx pgx.Tx, id string, eligibility bool) (Actor, error) {
	if a == nil || a.Human == nil {
		return Actor{}, fail("operations_authorization_unavailable", 503)
	}
	return a.Human.PersonWithin(ctx, tx, id, eligibility)
}
func (a *BusinessAuthority) RequireOperationWithin(ctx context.Context, tx pgx.Tx, actor Actor, required []string, selection Object, action string) (Actor, error) {
	if a != nil && a.Execution != nil && a.Execution.AcceptsExecution(actor) {
		fresh, err := a.Execution.RequireExecutionOperation(ctx, tx, actor, required, selection)
		if err != nil {
			return Actor{}, err
		}
		if err = a.Execution.GuardOperationWithin(ctx, tx, fresh, action, selection); err != nil {
			return Actor{}, err
		}
		return fresh, nil
	}
	if a != nil && a.Duty != nil && a.Duty.AcceptsDuty(actor) {
		query := action == "community-content-batch-preview"
		if !query {
			query = true
			for _, code := range required {
				if operationsai.Definition(code)["query"] != true {
					query = false
					break
				}
			}
		}
		if query {
			fresh := actor
			for _, code := range required {
				var e error
				fresh, e = a.Duty.RequireDutyAction(ctx, tx, fresh, code, "")
				if e != nil {
					return Actor{}, e
				}
			}
			return fresh, nil
		}
		return a.Duty.RequireDutyOperation(ctx, tx, actor, required, selection, &action)
	}
	fresh := actor
	for _, code := range required {
		var e error
		fresh, e = a.RequireWithin(ctx, tx, fresh, code)
		if e != nil {
			return Actor{}, e
		}
	}
	return fresh, nil
}

// AcceptsQueryPrincipal forwards only a human-bound query proof, never a duty or
// execution proof, to the wrapped read authority.
func (a *BusinessAuthority) AcceptsQueryPrincipal(actor Actor) bool {
	if a == nil || a.Human == nil || a.Execution != nil && a.Execution.AcceptsExecution(actor) || a.Duty != nil && a.Duty.AcceptsDuty(actor) {
		return false
	}
	reader, ok := a.Human.(QueryPrincipalAuthority)
	return ok && reader.AcceptsQueryPrincipal(actor)
}
func (a *BusinessAuthority) ReadQueryPrincipalWithin(ctx context.Context, tx pgx.Tx, actor Actor) (map[string]string, error) {
	if !a.AcceptsQueryPrincipal(actor) {
		return nil, fail("operations_agentos_scope_denied", 403)
	}
	return a.Human.(QueryPrincipalAuthority).ReadQueryPrincipalWithin(ctx, tx, actor)
}

// AcceptsScopedPrincipal forwards only an attested human query or preparation
// proof; duty and execution retain their separate authority paths.
func (a *BusinessAuthority) AcceptsScopedPrincipal(actor Actor) bool {
	if a == nil || a.Human == nil || a.Execution != nil && a.Execution.AcceptsExecution(actor) || a.Duty != nil && a.Duty.AcceptsDuty(actor) {
		return false
	}
	reader, ok := a.Human.(ScopedPrincipalAuthority)
	return ok && reader.AcceptsScopedPrincipal(actor)
}
func (a *BusinessAuthority) ReadScopedPrincipalWithin(ctx context.Context, tx pgx.Tx, actor Actor) (map[string]string, error) {
	if !a.AcceptsScopedPrincipal(actor) {
		return nil, fail("operations_agentos_scope_denied", 403)
	}
	return a.Human.(ScopedPrincipalAuthority).ReadScopedPrincipalWithin(ctx, tx, actor)
}

func (a *BusinessAuthority) AcceptsStoredPreparation(actor Actor) bool {
	if a == nil || a.Human == nil || a.Execution != nil && a.Execution.AcceptsExecution(actor) || a.Duty != nil && a.Duty.AcceptsDuty(actor) {
		return false
	}
	reader, ok := a.Human.(StoredPreparationAuthority)
	return ok && reader.AcceptsStoredPreparation(actor)
}
