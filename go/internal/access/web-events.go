package access

import (
	"context"
	"net/http"
	"slices"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/webevents"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Each surface retains its original identity. Device-account association is
// supplied by the account domain, never inferred from a browser header.
type WebEventAuthority struct {
	Gateway             *Gateway
	Devices             *deviceauth.Service
	Public              *webevents.PublicSources
	DeviceAccountWithin func(context.Context, pgx.Tx, deviceauth.Actor, string) (string, error)
}

func NewWebEventAuthority(g *Gateway) *WebEventAuthority {
	a := &WebEventAuthority{Gateway: g}
	if g != nil {
		a.Public = &webevents.PublicSources{Pool: g.Pool, Endpoint: g.Config.Endpoint, AccountWithin: a.accountWithin, BindingWithin: a.bindingWithin}
	}
	return a
}

var _ webevents.Authority = (*WebEventAuthority)(nil)

func (a *WebEventAuthority) AuthorizeConnection(ctx context.Context, r *http.Request, surface string) (webevents.Principal, error) {
	if a == nil || a.Gateway == nil || surface != "admin" && surface != "web" {
		return webevents.Principal{}, fault.New("web_events_authority_unavailable", 503)
	}
	// A stream is ongoing authority verification, never new user activity. Clone
	// also prevents this transport choice from mutating the caller's request.
	passive := r.Clone(ctx)
	passive.Header.Del("X-Galaxy-User-Activity")
	if surface == "web" {
		return a.publicConnection(ctx, passive)
	}
	id, authorization, e := a.Gateway.Operator(passive, false, "workbench.read")
	if e != nil {
		return webevents.Principal{}, e
	}
	current, ok := authorization.(*bound)
	if !ok || current.gateway != a.Gateway {
		return webevents.Principal{}, fault.New("web_events_access_denied", 403)
	}
	return webevents.Principal{Actor: current, Identity: id, Endpoint: a.Gateway.Config.Endpoint, Surface: surface}, nil
}
func (a *WebEventAuthority) AuthorizeModule(ctx context.Context, p webevents.Principal, module string) (bool, error) {
	if a == nil || a.Gateway == nil {
		return false, fault.New("web_events_authority_unavailable", 503)
	}
	if p.Surface == "web" {
		return p.Endpoint == a.Gateway.Config.Endpoint && slices.Contains(webevents.Modules("web"), module), nil
	}
	if p.Surface != "admin" {
		return false, fault.New("web_events_access_denied", 403)
	}
	current, ok := p.Actor.(*bound)
	if !ok || current == nil || current.gateway != a.Gateway || current.kind != "operator" || p.Endpoint != a.Gateway.Config.Endpoint || p.Identity != current.id {
		return false, fault.New("web_events_access_denied", 403)
	}
	permission := webevents.Permission(module)
	if permission == "" {
		return false, nil
	}
	granted, e := postgres.InTx(ctx, a.Gateway.Pool, func(tx pgx.Tx) (bool, error) {
		_, e := current.Operator(ctx, tx, p.Endpoint, p.Identity, permission)
		return e == nil, e
	})
	if fault.Code(e) == "operations_permission_denied" {
		return false, nil
	}
	return granted, e
}
func (a *WebEventAuthority) AuthorizeSource(ctx context.Context, p webevents.Principal, e webevents.Event) (webevents.SourceDecision, error) {
	if a != nil && a.Public != nil && p.Surface == "web" {
		return a.Public.AuthorizeSource(ctx, p, e)
	}
	return webevents.Denied, fault.New("web_events_authority_unavailable", 503)
}

func (a *WebEventAuthority) publicConnection(ctx context.Context, r *http.Request) (webevents.Principal, error) {
	p := webevents.Principal{Kind: "anonymous", Identity: "anonymous", Endpoint: a.Gateway.Config.Endpoint, Surface: "web"}
	if _, present := r.Header["Authorization"]; present {
		if a.Devices == nil {
			return p, fault.New("web_events_authority_unavailable", 503)
		}
		value := header(r, "Authorization")
		if !strings.HasPrefix(value, "Bearer ") || len(value) <= 7 {
			return p, fault.New("access_denied", 401)
		}
		actor, e := a.Devices.Authenticate(ctx, strings.TrimPrefix(value, "Bearer "), "binding")
		if e != nil {
			return p, e
		}
		if _, present := r.Header["X-Galaxy-Account-Id"]; present {
			p.AccountID = header(r, "X-Galaxy-Account-ID")
			id, e := uuid.Parse(p.AccountID)
			if e != nil || !strings.EqualFold(id.String(), p.AccountID) {
				return p, fault.New("web_events_access_denied", 403)
			}
		}
		p.Kind, p.Actor, p.Identity, p.SubjectID = "device", actor, actor.SubjectID, actor.SubjectID
		return p, nil
	}
	if _, present := r.Header["X-Galaxy-Account-Id"]; present {
		id, current, e := a.Gateway.Account(r, false)
		if e != nil {
			return p, e
		}
		p.Kind, p.Actor, p.Identity, p.AccountID = "official-account", current, id, id
	}
	return p, nil
}
func (a *WebEventAuthority) bindingWithin(ctx context.Context, tx pgx.Tx, p webevents.Principal) error {
	actor, ok := p.Actor.(deviceauth.Actor)
	if !ok || a.Devices == nil || p.Kind != "device" || p.Endpoint != a.Gateway.Config.Endpoint || p.SubjectID != actor.SubjectID || p.Identity != actor.SubjectID {
		return fault.New("web_events_access_denied", 403)
	}
	return a.Devices.AuthorizeWithin(ctx, tx, actor, "binding")
}
func (a *WebEventAuthority) accountWithin(ctx context.Context, tx pgx.Tx, p webevents.Principal) (string, error) {
	if p.Kind == "official-account" {
		b, ok := p.Actor.(*bound)
		if !ok || b == nil || b.gateway != a.Gateway || p.Identity != b.id || p.AccountID != b.id {
			return "", fault.New("web_events_access_denied", 403)
		}
		return p.AccountID, b.Account(ctx, tx, p.Endpoint, p.AccountID)
	}
	if e := a.bindingWithin(ctx, tx, p); e != nil {
		return "", e
	}
	if a.DeviceAccountWithin == nil {
		return "", fault.New("web_events_authority_unavailable", 503)
	}
	return a.DeviceAccountWithin(ctx, tx, p.Actor.(deviceauth.Actor), p.AccountID)
}
