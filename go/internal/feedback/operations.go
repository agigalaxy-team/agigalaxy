package feedback

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
	"slices"
)

// Operations is the original BusinessAdmin-backed feedback consumer. Portal
// Authorization remains separate; an AI is never turned into a human principal.
type Operations struct {
	Service *Service
	Domain  *businessadmin.Domain
}
type operationsOperator struct {
	owner *operationsAuthorization
	actor operationspermissions.Actor
}
type operationsAuthorization struct {
	domain *businessadmin.Domain
	actor  operationspermissions.Actor
}

func (a *operationsAuthorization) Account(context.Context, pgx.Tx, string, string) error {
	return fault.New("business_admin_denied", 403)
}
func (a *operationsAuthorization) Operator(ctx context.Context, tx pgx.Tx, endpoint, id, permission string) (Operator, error) {
	if endpoint != a.domain.Endpoint || id != a.actor.ID {
		return Operator{}, fault.New("business_admin_denied", 403)
	}
	fresh, e := a.domain.Fresh(ctx, tx, a.actor, permission)
	if e != nil {
		return Operator{}, e
	}
	if e = a.domain.Principal(ctx, tx, fresh); e != nil {
		return Operator{}, e
	}
	request := ""
	if fresh.RequestID != nil {
		request = *fresh.RequestID
	}
	return Operator{ID: fresh.ID, Role: fresh.Role, RequestID: request, CanManage: slices.Contains(fresh.Permissions, "feedback.update"), operations: &operationsOperator{a, fresh}}, nil
}
func (o *Operations) WithAuthority(authority operationspermissions.Authority) *Operations {
	if o == nil || o.Domain == nil {
		return nil
	}
	d := *o.Domain
	d.Authority = authority
	d.Duty = nil
	return &Operations{Service: o.Service, Domain: &d}
}
func (o *Operations) facade(a operationspermissions.Actor) (*Service, error) {
	if o == nil || o.Service == nil || o.Domain == nil || o.Domain.Pool == nil || o.Service.Endpoint != o.Domain.Endpoint || a.Endpoint != o.Domain.Endpoint {
		return nil, fault.New("business_admin_unavailable", 503)
	}
	d := *o.Domain
	d.Permissions = func(action string, _ Object) []string {
		switch action {
		case "feedback-read", "feedback-query":
			return []string{"feedback.read"}
		case "feedback-update":
			return []string{"feedback.update"}
		}
		return nil
	}
	v := o.Service
	return &Service{Pool: v.Pool, Endpoint: v.Endpoint, Authority: &operationsAuthorization{&d, a}, Attachments: v.Attachments, Tasks: v.Tasks, RequestID: v.RequestID, Now: v.Now}, nil
}
func (o *Operations) List(ctx context.Context, a operationspermissions.Actor, q Query) (Object, error) {
	v, e := o.facade(a)
	if e != nil {
		return nil, e
	}
	return v.List(ctx, a.ID, q)
}
func (o *Operations) Get(ctx context.Context, a operationspermissions.Actor, id, historyAfter string) (Object, error) {
	v, e := o.facade(a)
	if e != nil {
		return nil, e
	}
	return v.Get(ctx, a.ID, id, historyAfter)
}
func (o *Operations) Event(ctx context.Context, a operationspermissions.Actor, id string, raw []byte) (Object, error) {
	v, e := o.facade(a)
	if e != nil {
		return nil, e
	}
	return v.Update(ctx, a.ID, id, raw)
}
func (o *Operations) Operation(ctx context.Context, a operationspermissions.Actor, id, operation string) (Object, error) {
	v, e := o.facade(a)
	if e != nil {
		return nil, e
	}
	if o.Domain.IsExecution(a) {
		return nil, fault.New("business_admin_denied", 403)
	}
	return v.Operation(ctx, a.ID, id, operation)
}
func (o *Operations) HeadWithin(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	if o == nil || o.Service == nil {
		return nil, fault.New("business_admin_unavailable", 503)
	}
	if !uuidPattern.MatchString(id) {
		return nil, invalid()
	}
	r, e := o.Service.head(ctx, tx, id, false)
	if e != nil {
		return nil, e
	}
	return Object{"id": r.id, "revision": r.revision}, nil
}
func (s *Service) operationsActor(a Operator) (*operationsOperator, bool) {
	authority, ok := s.Authority.(*operationsAuthorization)
	if !ok || a.operations == nil || a.operations.owner != authority || a.operations.actor.ID != a.ID || authority.domain.Endpoint != s.Endpoint {
		return nil, false
	}
	return a.operations, true
}
func (s *Service) authorizeOperations(ctx context.Context, tx pgx.Tx, a Operator, action string, selection Object) (Operator, error) {
	proof, ok := s.operationsActor(a)
	if !ok {
		return a, nil
	}
	fresh, e := proof.owner.domain.Operation(ctx, tx, proof.actor, action, selection)
	if e != nil {
		return Operator{}, e
	}
	if e = proof.owner.domain.Principal(ctx, tx, fresh); e != nil {
		return Operator{}, e
	}
	a.operations = &operationsOperator{proof.owner, fresh}
	a.Role = fresh.Role
	a.CanManage = slices.Contains(fresh.Permissions, "feedback.update")
	return a, nil
}
