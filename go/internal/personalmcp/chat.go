package personalmcp

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
)

func without(q Object, keys ...string) Object {
	out := Object{}
	for k, v := range q {
		out[k] = v
	}
	for _, k := range keys {
		delete(out, k)
	}
	return out
}
func mcpChatActor(a deviceauth.Actor, id *string) chat.Actor {
	return chat.Actor{Device: &a, RequestID: requestID(id)}
}
func (s Services) chatConsumers(out map[string]Consumer) {
	if p := s.Chat; p != nil {
		raw := map[string]func(context.Context, chat.Actor, []byte) (Object, error){"galaxy_chat_rooms": p.List, "galaxy_chat_create": p.Create, "galaxy_chat_export_owned": p.ExportOwned}
		for name, fn := range raw {
			out[name] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
				raw, e := rawInput(q)
				if e != nil {
					return nil, e
				}
				return fn(ctx, mcpChatActor(a, id), raw)
			}
		}
		roomRead := map[string]func(context.Context, chat.Actor, string) (Object, error){"galaxy_chat_room": p.Get, "galaxy_chat_join_preview": p.JoinPreview, "galaxy_chat_decisions": p.Decisions, "galaxy_chat_leave": p.Leave}
		for name, fn := range roomRead {
			if fn == nil {
				continue
			}
			out[name] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
				return fn(ctx, mcpChatActor(a, id), str(q, "roomId"))
			}
		}
		roomRaw := map[string]func(context.Context, chat.Actor, string, []byte) (Object, error){"galaxy_chat_join": p.Join, "galaxy_chat_agent_participants": p.QueryAgentParticipants, "galaxy_chat_history": p.History, "galaxy_chat_send": p.Send, "galaxy_chat_message_status": p.MessageStatus, "galaxy_chat_propose": p.Propose, "galaxy_chat_vote": p.Vote, "galaxy_chat_accept_invitation": p.Accept, "galaxy_chat_agent_cursor": p.Cursor}
		for name, fn := range roomRaw {
			out[name] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
				args := without(q, "roomId")
				if name == "galaxy_chat_agent_cursor" {
					args["kind"] = "agent"
				}
				raw, e := rawInput(args)
				if e != nil {
					return nil, e
				}
				return fn(ctx, mcpChatActor(a, id), str(q, "roomId"), raw)
			}
		}
		out["galaxy_chat_invitations"] = func(ctx context.Context, a deviceauth.Actor, _ Object, id *string) (any, error) {
			return p.Invitations(ctx, mcpChatActor(a, id))
		}
		out["galaxy_chat_edit"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			raw, e := rawInput(without(q, "roomId", "messageId"))
			if e != nil {
				return nil, e
			}
			return p.Edit(ctx, mcpChatActor(a, id), str(q, "roomId"), str(q, "messageId"), raw)
		}
		out["galaxy_chat_retract"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.Retract(ctx, mcpChatActor(a, id), str(q, "roomId"), str(q, "messageId"))
		}
	}
	if p := s.Attachments; p != nil {
		out["galaxy_attachment_config"] = func(context.Context, deviceauth.Actor, Object, *string) (any, error) { return p.Specification(), nil }
		for name, fn := range map[string]func(context.Context, chat.Actor, []byte) (Object, error){"galaxy_attachment_read": p.Get, "galaxy_attachment_owned": p.QueryOwn, "galaxy_attachment_revoke": p.Revoke} {
			out[name] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
				raw, e := rawInput(q)
				if e != nil {
					return nil, e
				}
				return fn(ctx, mcpChatActor(a, id), raw)
			}
		}
	}
	if p := s.SharedSummaries; p != nil {
		for name, fn := range map[string]func(context.Context, chat.Actor, []byte) (Object, error){"galaxy_chat_shared_summary_publish": p.Publish, "galaxy_chat_shared_summary_get": p.Get, "galaxy_chat_shared_summary_receipt": p.Receipt, "galaxy_chat_shared_summary_list": p.List, "galaxy_chat_shared_summary_retract": p.Retract} {
			out[name] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
				raw, e := rawInput(q)
				if e != nil {
					return nil, e
				}
				return fn(ctx, mcpChatActor(a, id), raw)
			}
		}
	}
	if p := s.Contacts; p != nil {
		for name, fn := range map[string]func(context.Context, chat.Actor, []byte) (Object, error){"galaxy_contacts_v2_query": p.Query, "galaxy_contact_v2_event": p.Submit} {
			out[name] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
				raw, e := rawInput(q)
				if e != nil {
					return nil, e
				}
				return fn(ctx, mcpChatActor(a, id), raw)
			}
		}
		out["galaxy_contact_v2_get"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.Get(ctx, mcpChatActor(a, id), str(q, "contactId"))
		}
	}
}
