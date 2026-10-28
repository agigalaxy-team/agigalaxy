package personalmcp

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/moderation"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/projects"
	"github.com/agigalaxy-team/agigalaxy/go/internal/recruitment"
	"github.com/agigalaxy-team/agigalaxy/go/internal/targetgovernance"
	"github.com/jackc/pgx/v5"
)

func (s Services) communityConsumers(out map[string]Consumer) {
	if p := s.Forum; p != nil {
		if p.AccountLinks != nil {
			out["galaxy_community_account_options"] = func(ctx context.Context, a deviceauth.Actor, _ Object, _ *string) (any, error) {
				return postgres.InTx(ctx, p.Pool, func(tx pgx.Tx) (any, error) {
					rr, e := p.AccountLinks.ForScope("binding").AvailableWithin(ctx, tx, a)
					if e != nil {
						return nil, e
					}
					items := []Object{}
					for _, r := range rr {
						items = append(items, Object{"id": r["id"]})
					}
					return Object{"items": items, "selectionRequired": len(rr) > 1}, nil
				})
			}
		}
		out["galaxy_community_topics"] = func(context.Context, deviceauth.Actor, Object, *string) (any, error) {
			v := p.Topics()
			return Object{"items": v["items"], "legacyTopic": v["unclassified"]}, nil
		}
		for _, name := range []string{"galaxy_community_query", "galaxy_community_read", "galaxy_community_replies", "galaxy_community_versions", "galaxy_community_owned"} {
			out[name] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
				scope := "binding"
				if name == "galaxy_community_owned" {
					scope = "assistance"
				}
				reader := p.ForIdentity(a, scope, "")
				reader.RequestID = requestID(id)
				account := str(q, "accountId")
				args := without(q, "accountId")
				if name == "galaxy_community_read" {
					if str(q, "versionId") != "" {
						return reader.GetVersion(ctx, account, str(q, "postId"), str(q, "versionId"))
					}
					return reader.GetPost(ctx, account, str(q, "postId"))
				}
				if name == "galaxy_community_versions" {
					args = without(args, "postId")
				}
				raw, e := rawInput(args)
				if e != nil {
					return nil, e
				}
				switch name {
				case "galaxy_community_query":
					return reader.Query(ctx, account, raw)
				case "galaxy_community_replies":
					return reader.Replies(ctx, account, raw)
				case "galaxy_community_versions":
					return reader.Versions(ctx, account, str(q, "postId"), raw)
				default:
					return reader.Owned(ctx, account, raw)
				}
			}
		}
	}
	if p := s.Projects; p != nil {
		out["galaxy_project_v2_query"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			raw, e := rawInput(q)
			if e != nil {
				return nil, e
			}
			return p.List(ctx, projects.Actor{Device: &a, RequestID: requestID(id)}, raw)
		}
		out["galaxy_project_v2_get"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.Get(ctx, projects.Actor{Device: &a, RequestID: requestID(id)}, str(q, "projectId"))
		}
		out["galaxy_project_v2_event"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			raw, e := rawInput(q)
			if e != nil {
				return nil, e
			}
			return p.Submit(ctx, projects.Actor{Device: &a, RequestID: requestID(id)}, raw)
		}
		out["galaxy_project_v2_preferences"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.Preferences(ctx, projects.Actor{Device: &a, RequestID: requestID(id)}, str(q, "projectId"))
		}
		out["galaxy_project_v2_preferences_save"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			raw, e := rawInput(without(q, "projectId"))
			if e != nil {
				return nil, e
			}
			return p.SavePreferences(ctx, projects.Actor{Device: &a, RequestID: requestID(id)}, str(q, "projectId"), raw)
		}
	}
	if p := s.Recruitment; p != nil {
		for name, fn := range map[string]func(context.Context, recruitment.Actor, []byte) (Object, error){"galaxy_recruitment_v2_query": p.Query, "galaxy_recruitment_v2_receipt": p.OperationReceipt, "galaxy_recruitment_v2_event": p.Submit} {
			out[name] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
				raw, e := rawInput(q)
				if e != nil {
					return nil, e
				}
				return fn(ctx, recruitment.Actor{Device: &a, RequestID: requestID(id)}, raw)
			}
		}
		out["galaxy_recruitment_v2_get"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.Get(ctx, recruitment.Actor{Device: &a, RequestID: requestID(id)}, str(q, "recruitmentId"))
		}
	}
	if p := s.Opportunities; p != nil {
		out["galaxy_discovery_query"] = func(ctx context.Context, a deviceauth.Actor, q Object, _ *string) (any, error) {
			return p.QueryLegacy(ctx, &a, q)
		}
		out["galaxy_discovery_preferences"] = func(ctx context.Context, a deviceauth.Actor, _ Object, id *string) (any, error) {
			return p.Preferences(ctx, a, id)
		}
		out["galaxy_discovery_preferences_save"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.SavePreferences(ctx, a, q, id)
		}

		out["galaxy_discovery_v2_query"] = func(ctx context.Context, a deviceauth.Actor, q Object, _ *string) (any, error) {
			return p.Query(ctx, &a, q)
		}
		out["galaxy_discovery_v2_detail"] = func(ctx context.Context, a deviceauth.Actor, q Object, _ *string) (any, error) {
			return p.Detail(ctx, &a, q)
		}
	}
	if p := s.TargetGovernance; p != nil {
		out["galaxy_target_governance_config"] = func(ctx context.Context, a deviceauth.Actor, _ Object, id *string) (any, error) {
			return p.Config(ctx, targetgovernance.Actor{Device: &a, RequestID: requestID(id)})
		}
		for name, fn := range map[string]func(context.Context, targetgovernance.Actor, []byte) (Object, error){"galaxy_target_governance_target": p.TargetInfo, "galaxy_target_governance_query": p.Query, "galaxy_target_governance_report": p.Report, "galaxy_target_governance_event": p.Event, "galaxy_target_governance_receipt": p.Receipt} {
			out[name] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
				raw, e := rawInput(q)
				if e != nil {
					return nil, e
				}
				return fn(ctx, targetgovernance.Actor{Device: &a, RequestID: requestID(id)}, raw)
			}
		}
		out["galaxy_target_governance_get"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.Read(ctx, targetgovernance.Actor{Device: &a, RequestID: requestID(id)}, str(q, "reportId"))
		}
	}
	if p := s.Moderation; p != nil {
		out["galaxy_moderation_config"] = func(ctx context.Context, a deviceauth.Actor, _ Object, id *string) (any, error) {
			return p.Config(ctx, moderation.Actor{Device: &a, RequestID: requestID(id)})
		}
		for name, fn := range map[string]func(context.Context, moderation.Actor, []byte) (Object, error){"galaxy_moderation_query": p.Query, "galaxy_moderation_report": p.Report, "galaxy_moderation_receipt": p.Receipt} {
			out[name] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
				raw, e := rawInput(q)
				if e != nil {
					return nil, e
				}
				return fn(ctx, moderation.Actor{Device: &a, RequestID: requestID(id)}, raw)
			}
		}
		out["galaxy_moderation_get"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.Get(ctx, moderation.Actor{Device: &a, RequestID: requestID(id)}, str(q, "reportId"))
		}
		out["galaxy_moderation_event"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			raw, e := rawInput(without(q, "reportId"))
			if e != nil {
				return nil, e
			}
			return p.Event(ctx, moderation.Actor{Device: &a, RequestID: requestID(id)}, str(q, "reportId"), raw)
		}
	}
}
