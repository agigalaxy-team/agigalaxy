package main

import (
	"context"
	"net/http"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/communitygrowth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/honor"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
)

func communityGrowthHandler(forum *community.Service, profiles *accounts.Service, publicLinks *accounts.PublicQueries, honors *honor.Service, identity accounts.HTTPIdentity, authority *operationspermissions.BusinessAuthority, recommendations *discovery.Runtime, next http.Handler) (http.Handler, *communitygrowth.Service, *communitygrowth.AssessmentService) {
	growth := &communitygrowth.Service{Pool: forum.Pool, Endpoint: forum.Endpoint, Forum: forum, Authority: authority}
	growth.PublicAccountWithin = func(ctx context.Context, tx pgx.Tx, _ string, account string) (communitygrowth.Object, error) {
		return profiles.PublicProfileWithin(ctx, tx, account, nil)
	}
	assessment := &communitygrowth.AssessmentService{Service: growth}
	growth.OnSourceWithin = assessment.SourceChangedWithin
	assessment.ReadSourceWithin = growth.AssessmentSourceWithin
	previousContent := forum.OnContentWithin
	forum.OnContentWithin = func(ctx context.Context, tx pgx.Tx, change community.ContentChange) error {
		if previousContent != nil {
			if e := previousContent(ctx, tx, change); e != nil {
				return e
			}
		}
		if _, e := growth.ReconcilePublicSourceWithin(ctx, tx, forum, change.Kind, change.ID); e != nil {
			return e
		}
		return growth.MarkContentChangedWithin(ctx, tx, change.Kind, change.ID)
	}
	previousReaction := forum.OnReactionWithin
	forum.OnReactionWithin = func(ctx context.Context, tx pgx.Tx, change community.ReactionChange) error {
		if previousReaction != nil {
			if e := previousReaction(ctx, tx, change); e != nil {
				return e
			}
		}
		if e := growth.ReconcileReactionWithin(ctx, tx, forum, change); e != nil {
			return e
		}
		if recommendations == nil || recommendations.Store == nil {
			return nil
		}
		// Preserve the real relation. Delivery separately checks the current
		// public qualification, including later withdrawal and restoration.
		return recommendations.Store.QueueFeedbackStateWithin(ctx, tx, discovery.FeedbackState{
			ProfileID: "account:" + change.AccountID, ItemKey: change.Kind + "_" + change.ID, Type: "like",
			Active: change.Liked, Revision: change.Revision, OccurredAt: time.Now().UTC(),
		})
	}
	legacy := func(ctx context.Context, account string, limit int, after string) (communitygrowth.Object, error) {
		return growth.PublicLegacyHonors(ctx, publicLinks, honors, account, limit, after)
	}
	return communitygrowth.Handler{Service: growth, Assessment: assessment, Accounts: identity, LegacyHonors: legacy, Next: next}, growth, assessment
}
