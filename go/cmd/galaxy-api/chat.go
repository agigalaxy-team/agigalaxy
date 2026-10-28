package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountsocial"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type chatIdentity struct{ gateway *access.Gateway }

func (a chatIdentity) Account(r *http.Request, write bool) (string, chat.Authorization, error) {
	return a.gateway.Account(r, write)
}

func loadChat(ctx context.Context, pool *pgxpool.Pool, endpoint string, devices *deviceauth.Service, links *accountlinks.Service, budget *resourcebudget.Service, forum *community.Service, logger *slog.Logger, observed ...func(*string)) (*chat.Service, func(), error) {
	policy, err := community.LoadCommunityPolicy(os.Getenv("GALAXY_COMMUNITY_QUOTA_FILE"))
	if err != nil {
		return nil, nil, err
	}
	transport, configurationHash, err := chat.LoadTransport(os.Getenv("GALAXY_CHAT_CONFIG_FILE"))
	if err != nil {
		return nil, nil, err
	}
	service := &chat.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Links: links, Resources: budget,
		Rules: &businessrules.Service{Endpoint: endpoint, PromotionDays: forum.PromotionDays}, CommunityPolicy: policy}
	for _, capture := range observed {
		if capture != nil {
			capture(configurationHash)
		}
	}
	closeTransport := func() {}
	if transport != nil {
		service.Transport = transport
		closeTransport = func() { _ = transport.Stop() }
		startup, cancel := context.WithTimeout(ctx, 5*time.Second)
		err = transport.Start(startup)
		cancel()
		if err != nil {
			// Match the existing API: a failed initial handshake stops this
			// transport; it cannot silently retry external message commands.
			_ = transport.Stop()
			logger.Warn("chat_transport_unavailable", "error", err)
		}
	}
	return service, closeTransport, nil
}

func chatBookmark(service *chat.Service) accountsocial.SourceReader {
	return func(ctx context.Context, tx pgx.Tx, actor accountsocial.Actor, reference accountsocial.Reference) (accountsocial.Object, error) {
		current := chat.Actor{AccountID: actor.AccountID, Authority: actor.Authority}
		if !actor.Official {
			current.Device = &actor.Device
		}
		return service.ReadBookmarkWithin(ctx, tx, current, reference.RoomID, reference.MessageID)
	}
}
