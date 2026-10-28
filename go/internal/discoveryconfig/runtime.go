// Package discoveryconfig composes existing professional discovery adapters.
// Each process retains its own database pool and current-source authority.
package discoveryconfig

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5/pgxpool"
)

func Runtime(pool *pgxpool.Pool, endpoint string, c *discovery.Configuration, forum *community.Service, worker bool, authority *operationspermissions.BusinessAuthority) (*discovery.Runtime, error) {
	if c == nil {
		return nil, nil
	}
	source := &discovery.CommunitySource{Pool: pool, Endpoint: endpoint, Forum: forum, Worker: worker}
	r := &discovery.Runtime{Store: &discovery.Store{Pool: pool, Endpoint: endpoint}, Source: source, Authority: authority}
	var err error
	if cfg := c.Meilisearch; cfg != nil {
		index := ""
		if cfg.Index != nil {
			index = *cfg.Index
		}
		r.Meili, err = discovery.NewMeilisearch(cfg.URL, cfg.APIKey, index, discovery.ClientOptions{})
		if err != nil {
			return nil, err
		}
	}
	if cfg := c.Gorse; cfg != nil {
		r.Gorse, err = discovery.NewGorse(cfg.URL, cfg.APIKey, discovery.ClientOptions{})
		if err != nil {
			return nil, err
		}
	}
	if cfg := c.OpenPanel; cfg != nil {
		r.OpenPanel, err = discovery.NewOpenPanel(*cfg, discovery.ClientOptions{})
		if err != nil {
			return nil, err
		}
	}
	r.SearchQuality = &discovery.SearchQuality{Pool: pool, Endpoint: endpoint, Authority: authority, Meili: r.Meili, OpenPanel: r.OpenPanel}
	r.Recommendations = &discovery.Recommendations{Pool: pool, Endpoint: endpoint, Authority: authority, Source: source, OpenPanel: r.OpenPanel}
	return r, nil
}
