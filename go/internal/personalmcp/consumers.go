package personalmcp

import (
	"context"
	"encoding/json"

	"github.com/agigalaxy-team/agigalaxy/go/internal/builders"
	"github.com/agigalaxy-team/agigalaxy/go/internal/capsules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/choices"
	"github.com/agigalaxy-team/agigalaxy/go/internal/civ2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/configurations"
	contextdata "github.com/agigalaxy-team/agigalaxy/go/internal/context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/contributions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/experiencereviews"
	"github.com/agigalaxy-team/agigalaxy/go/internal/history"
	"github.com/agigalaxy-team/agigalaxy/go/internal/historyv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/honor"
	"github.com/agigalaxy-team/agigalaxy/go/internal/hubs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/information"
	"github.com/agigalaxy-team/agigalaxy/go/internal/moderation"
	"github.com/agigalaxy-team/agigalaxy/go/internal/notifications"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/personalaudit"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/agigalaxy-team/agigalaxy/go/internal/projects"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/agigalaxy-team/agigalaxy/go/internal/qualification"
	"github.com/agigalaxy-team/agigalaxy/go/internal/recruitment"
	"github.com/agigalaxy-team/agigalaxy/go/internal/requesterhistory"
	"github.com/agigalaxy-team/agigalaxy/go/internal/searchv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/subjectlifecycle"
	"github.com/agigalaxy-team/agigalaxy/go/internal/summaries"
	"github.com/agigalaxy-team/agigalaxy/go/internal/targetgovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/trustpackages"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/jackc/pgx/v5"
)

// Services contains real owning services, plus direct adapters supplied by the
// other domain owners. Extra consumers use original catalog names and schemas;
// they receive the exact opaque OAuth actor, not a reconstructed subject.
type Services struct {
	Devices            *deviceauth.Service
	Summaries          *summaries.Service
	Choices            *choices.Service
	Trust              *trustpackages.Service
	Tasks              *taskmaterials.Service
	Outcome            *taskmaterials.OutcomeService
	Contributions      *contributions.Service
	Honor              *honor.Service
	RequesterHistory   *requesterhistory.Service
	PublicWrites       *publicwrites.Service
	Qualification      *qualification.Service
	Experience         *experiencereviews.Service
	Comments           *taskmaterials.CommentService
	CommentGovernance  *taskmaterials.CommentGovernance
	Cases              *cases.Service
	Records            *verificationrecords.Service
	Configurations     *configurations.Service
	Context            *contextdata.Service
	History            *history.Service
	HistoryV2          *historyv2.Service
	CI                 *civ2.Service
	Search             *searchv2.Service
	Profiles           *profiles.Service
	Exports            *subjectlifecycle.Service
	Chat               *chat.Service
	SharedSummaries    *chat.SharedSummaryService
	Attachments        *chat.AttachmentService
	Contacts           *chat.ContactService
	Forum              *community.Service
	Projects           *projects.Service
	Recruitment        *recruitment.Service
	Opportunities      *opportunities.Service
	TargetGovernance   *targetgovernance.Service
	Moderation         *moderation.Service
	Capsules           *capsules.Service
	Builders           *builders.Service
	Hubs               *hubs.Service
	Peering            *hubs.Peering
	Information        *information.Service
	InformationWatches *information.Watches
	Inbox              *notifications.Service
	Evidence           *evidence.Service
	Proofs             *evidence.ProofService
	LegacySearch       *discovery.LegacySearch
	Audit              *personalaudit.Service
	Tools              map[string]Consumer
}

func str(input Object, key string) string { s, _ := input[key].(string); return s }
func integer(input Object, key string, fallback int) int {
	if v, ok := input[key].(float64); ok {
		return int(v)
	}
	return fallback
}
func decode(input Object, out any) error {
	raw, e := protocol.EncodeJS(input)
	if e != nil {
		return e
	}
	return json.Unmarshal(raw, out)
}
func (s Services) consumers() map[string]Consumer {
	out := map[string]Consumer{}
	for name, consumer := range s.Tools {
		if consumer != nil {
			out[name] = consumer
		}
	}
	adapt := func(name string, fn func(context.Context, deviceauth.Actor, Object) (Object, error)) {
		out[name] = func(ctx context.Context, a deviceauth.Actor, q Object, _ *string) (any, error) { return fn(ctx, a, q) }
	}
	if s.Devices != nil {
		out["galaxy_connection_status"] = func(ctx context.Context, a deviceauth.Actor, _ Object, _ *string) (any, error) {
			return postgres.InTx(ctx, s.Devices.Pool, func(tx pgx.Tx) (any, error) {
				auth, e := s.Devices.CurrentControlWithin(ctx, tx, a, "binding")
				if e != nil {
					return nil, e
				}
				return Object{"subjectId": a.SubjectID, "bindingId": a.BindingID, "endpoint": s.Devices.Endpoint, "scopes": auth.CredentialScopes, "authorization": "oauth-resource", "consentRequired": true}, nil
			})
		}
	}
	if p := s.PublicWrites; p != nil {
		out["galaxy_account_quotas"] = func(ctx context.Context, a deviceauth.Actor, _ Object, _ *string) (any, error) {
			return p.Status(ctx, publicwrites.Actor{Device: &a, Scope: "binding"})
		}
	}
	if p := s.Summaries; p != nil {
		adapt("galaxy_personal_summary_preferences", func(ctx context.Context, a deviceauth.Actor, _ Object) (Object, error) { return p.Preferences(ctx, a) })
		adapt("galaxy_personal_summary_preferences_save", p.SavePreference)
		adapt("galaxy_personal_summary_put", p.Put)
		adapt("galaxy_personal_summary_get", p.Get)
		adapt("galaxy_personal_summary_receipt", p.Receipt)
		adapt("galaxy_personal_summary_list", p.List)
		adapt("galaxy_personal_summary_sources", p.Sources)
		adapt("galaxy_personal_summary_delete", p.Delete)
	}
	if p := s.Choices; p != nil {
		adapt("galaxy_choice_preferences", func(ctx context.Context, a deviceauth.Actor, _ Object) (Object, error) { return p.Preferences(ctx, a) })
		adapt("galaxy_choice_preferences_save", p.SavePreference)
		adapt("galaxy_choice_put", p.Put)
		adapt("galaxy_choice_get", p.Get)
		adapt("galaxy_choice_receipt", p.Receipt)
		adapt("galaxy_choice_list", p.List)
		adapt("galaxy_choice_delete", p.Delete)
	}
	if p := s.Trust; p != nil {
		methods := map[string]func(context.Context, trustpackages.Actor, Object) (Object, error){"galaxy_trust_sources": p.Sources, "galaxy_trust_permission_preview": p.Preview, "galaxy_trust_permission_revoke_preview": p.RevokePreview, "galaxy_trust_permission_submit": p.Submit, "galaxy_trust_permission_receipt": p.Receipt, "galaxy_trust_permission_status": p.Status, "galaxy_trust_permission_query": p.Query}
		for name, fn := range methods {
			out[name] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
				return fn(ctx, trustpackages.Actor{Actor: a, HTTPRequestID: id}, q)
			}
		}
	}
	if p := s.Contributions; p != nil {
		methods := map[string]func(context.Context, contributions.Actor, Object) (any, error){"galaxy_contribution_status": p.Status, "galaxy_contribution_sources": p.OwnedSources, "galaxy_contribution_preview": p.Preview}
		for name, fn := range methods {
			out[name] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
				return fn(ctx, contributions.Actor{Actor: a, HTTPRequestID: id}, q)
			}
		}
		out["galaxy_contribution_read"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			actor := contributions.Actor{Actor: a, HTTPRequestID: id}
			return p.ReadProjection(ctx, &actor, q)
		}
		out["galaxy_contribution_publish"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			var input contributions.Envelope
			if e := decode(q, &input); e != nil {
				return nil, e
			}
			return p.Submit(ctx, contributions.Actor{Actor: a, HTTPRequestID: id}, input)
		}
	}
	if p := s.Honor; p != nil {
		out["galaxy_honor_v2_query"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			actor := honor.Actor{Actor: a, HTTPRequestID: id}
			return p.QueryV2(ctx, &actor, q)
		}
		out["galaxy_honor_v2_ranking"] = func(ctx context.Context, _ deviceauth.Actor, q Object, _ *string) (any, error) {
			return p.RankingV2(ctx, q)
		}
	}
	if p := s.RequesterHistory; p != nil {
		adapt("galaxy_requester_history_v2_query", func(ctx context.Context, a deviceauth.Actor, q Object) (Object, error) { return p.Query(ctx, &a, q) })
		adapt("galaxy_requester_history_v2_facts", func(ctx context.Context, a deviceauth.Actor, q Object) (Object, error) { return p.Facts(ctx, &a, q) })
	}
	if s.Tasks != nil {
		s.taskConsumers(out)
	}
	if s.Outcome != nil {
		s.outcomeConsumers(out)
	}
	s.qualificationConsumers(out)
	s.commentConsumers(out)
	s.factConsumers(out)
	s.chatConsumers(out)
	s.communityConsumers(out)
	s.reuseConsumers(out)
	s.commonConsumers(out)
	s.auditPackConsumers(out)
	return out
}
