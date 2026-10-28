package subjectlifecycle

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// ForumConsumers are the migrated forum's within-transaction read and original
// lifecycle permission selectors. The API assembler supplies these real ports.
type ForumConsumers struct {
	ReadVersion       func(context.Context, pgx.Tx, Actor, string, string) (Object, error)
	ReadReply         func(context.Context, pgx.Tx, Actor, string) (Object, error)
	PermissionAllowed func(context.Context, pgx.Tx, string, string, string, string) (bool, error)
}

func (s *Service) ConnectForum(f ForumConsumers) {
	if s.Transforms == nil {
		s.Transforms = map[string]Transformer{}
	}
	if s.Views == nil {
		s.Views = map[string]ViewReader{}
	}
	if f.ReadVersion != nil {
		s.Views["forum-post-version"] = func(ctx context.Context, tx pgx.Tx, a Actor, v View, _ string) (any, error) {
			if v.VersionID == nil {
				return nil, invalidExport()
			}
			return f.ReadVersion(ctx, tx, a, v.ID, *v.VersionID)
		}
	}
	if f.ReadReply != nil {
		s.Views["forum-reply"] = func(ctx context.Context, tx pgx.Tx, a Actor, v View, _ string) (any, error) {
			return f.ReadReply(ctx, tx, a, v.ID)
		}
	}
	if f.ReadVersion != nil && f.ReadReply != nil && f.PermissionAllowed != nil {
		s.Transforms["forum-events"] = func(ctx context.Context, tx pgx.Tx, a Actor, item Object, _ int64) (Object, error) {
			allowed := false
			if text(item["payload_text"]) != "" {
				switch text(item["kind"]) {
				case "create-post", "publish-version":
					view, e := f.ReadVersion(ctx, tx, a, text(item["post_id"]), text(item["version_id"]))
					if e != nil {
						return nil, e
					}
					allowed = text(view["availability"]) == "available"
				case "create-reply":
					view, e := f.ReadReply(ctx, tx, a, text(item["reply_id"]))
					if e != nil {
						return nil, e
					}
					allowed = text(view["availability"]) == "available"
				default:
					var e error
					allowed, e = f.PermissionAllowed(ctx, tx, text(item["permission_id"]), a.SubjectID, text(item["payload_hash"]), "")
					if e != nil {
						return nil, e
					}
				}
			}
			if !allowed {
				item["payload_text"] = ""
			}
			item["contentAvailable"] = allowed
			item["authority"] = "current-forum-read-only; original hash is historical"
			return item, nil
		}
	}
	if f.PermissionAllowed != nil {
		s.Transforms["forum-governance-events"] = func(ctx context.Context, tx pgx.Tx, a Actor, item Object, _ int64) (Object, error) {
			allowed := false
			if text(item["payload_text"]) != "" {
				var e error
				allowed, e = f.PermissionAllowed(ctx, tx, text(item["permission_id"]), a.SubjectID, text(item["payload_hash"]), "Private")
				if e != nil {
					return nil, e
				}
			}
			if !allowed {
				item["payload_text"] = ""
			}
			item["contentAvailable"] = allowed
			item["authority"] = "current-exact-private-forum-permission-only"
			return item, nil
		}
	}
}
