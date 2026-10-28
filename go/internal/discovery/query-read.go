package discovery

import (
	"context"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
)

func queryAuthority(live *p.BusinessAuthority, reader p.Authority) *p.BusinessAuthority {
	out := &p.BusinessAuthority{Human: reader}
	if live != nil {
		out.Duty, out.Execution = live.Duty, live.Execution
	}
	return out
}

// QueryRead ports keep the same qualified sources and native clients. The
// search reader constructs no copy of reconcileMu or in-flight command state.
func (r *Runtime) QueryRead(ctx context.Context, a Actor, authority p.Authority, view, id string, input Object) (Object, error) {
	reader := &Runtime{Store: r.Store, Source: r.Source, Meili: r.Meili, Gorse: r.Gorse, Now: r.Now, SearchQuality: r.SearchQuality, Recommendations: r.Recommendations, OpenPanel: r.OpenPanel, Authority: queryAuthority(r.Authority, authority)}
	query := Object{"kind": view}
	for k, v := range input {
		query[k] = v
	}
	return reader.Analytics(ctx, a, query)
}
func (s *Recommendations) QueryRead(ctx context.Context, a Actor, authority p.Authority, view, id string, input Object) (Object, error) {
	reader := &Recommendations{Pool: s.Pool, Endpoint: s.Endpoint, Authority: queryAuthority(s.Authority, authority), Source: s.Source, OpenPanel: s.OpenPanel, Now: s.Now}
	switch view {
	case "overview":
		return reader.Overview(ctx, a, input)
	case "history":
		return reader.History(ctx, a, input)
	}
	return nil, recommendationInvalid()
}
func (q *SearchQuality) QueryRead(ctx context.Context, a Actor, authority p.Authority, view, id string, input Object) (Object, error) {
	reader := q.WithAuthority(queryAuthority(q.Authority, authority))
	switch view {
	case "overview":
		return reader.Overview(ctx, a, input)
	case "history":
		return reader.History(ctx, a, input)
	}
	return nil, settingsInvalid()
}
func QuerySearchSettings(value Object) (Object, error) { return canonicalSettings(value) }
func QueryThemeKey(value string) bool                  { return themeKey(value) }
