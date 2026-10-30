package agentos

import (
	"context"
	"net/url"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
)

func historyQuery(u *url.URL) (string, error) {
	q, e := url.ParseQuery(u.RawQuery)
	if e != nil || len(u.RawQuery) > 600 {
		return "", fail("invalid_operations_agentos_request", 400)
	}
	for k, v := range q {
		if k != "before" || len(v) != 1 || v[0] == "" {
			return "", fail("invalid_operations_agentos_request", 400)
		}
	}
	return q.Get("before"), nil
}
func cardTurnsQuery(u *url.URL) ([]string, error) {
	q, e := url.ParseQuery(u.RawQuery)
	if e != nil || len(u.RawQuery) > 2500 {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	turns := []string{}
	seen := map[string]bool{}
	for k, v := range q {
		if k != "turnId" || len(v) > 50 {
			return nil, fail("invalid_operations_agentos_request", 400)
		}
		for _, id := range v {
			if !validOperationID(id) {
				return nil, fail("invalid_operations_agentos_request", 400)
			}
			if !seen[id] {
				turns = append(turns, id)
				seen[id] = true
			}
		}
	}
	return turns, nil
}
func (s *Conversations) ReadCardsForTurns(ctx context.Context, a operationspermissions.Actor, domain string, turns []string) (Object, error) {
	if len(turns) == 0 {
		return s.ReadCards(ctx, a, domain)
	}
	if s.Tools == nil {
		return nil, fail("operations_agentos_conversation_not_ready", 503)
	}
	items, err := s.Tools.readCardBatch(ctx, a, domain, turns...)
	if err != nil {
		return nil, err
	}
	at := s.now().Unix()
	return Object{"domain": domain, "items": items, "checkedAt": at}, nil
}
