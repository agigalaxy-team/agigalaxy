package messaging

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"net"
	"strings"
)

func (s *SMTPService) Domains(ctx context.Context, a Actor) (Object, error) {
	type snapshot struct {
		actor   Actor
		current Object
	}
	saved, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (snapshot, error) {
		actor, e := s.require(ctx, tx, a, "smtp.read")
		if e != nil {
			return snapshot{}, e
		}
		current, e := s.current(ctx, tx)
		return snapshot{actor: actor, current: current}, e
	})
	if e != nil {
		return nil, e
	}
	resolve := s.ResolveTXT
	if resolve == nil {
		resolve = net.DefaultResolver.LookupTXT
	}
	read := func(name, prefix string) Object {
		records, e := resolve(ctx, name)
		if e != nil {
			state := "unavailable"
			if dns, ok := e.(*net.DNSError); ok && dns.IsNotFound {
				state = "not-found"
			}
			return Object{"state": state, "records": []any{}}
		}
		selected := []any{}
		for _, value := range records {
			if !strings.HasPrefix(value, prefix) {
				continue
			}
			if len(value) > 2048 {
				value = value[:2048]
			}
			selected = append(selected, value)
			if len(selected) == 10 {
				break
			}
		}
		state := "not-found"
		if len(selected) > 0 {
			state = "record-found"
		}
		return Object{"state": state, "records": selected}
	}
	domain := "agigalaxy.org"
	selector := obj(saved.current["configuration"])["dkimSelector"]
	dkim := Object{"selector": nil, "state": "selector-not-configured", "records": []any{}}
	if selector != nil {
		dkim = read(str(selector)+"._domainkey."+domain, "v=DKIM1")
		dkim["selector"] = selector
	}
	result := Object{"domain": domain, "spf": read(domain, "v=spf1"), "dmarc": read("_dmarc."+domain, "v=DMARC1"), "dkim": dkim, "alignment": "unknown", "checkedAt": s.now().Unix()}
	_, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
		e := s.helper().audit(ctx, tx, saved.actor, "smtp-dns-check", nil, nil, Object{}, Object{"state": "checked", "version": saved.current["version"]})
		return e == nil, e
	})
	return result, e
}
