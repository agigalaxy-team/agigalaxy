package native

import (
	"bytes"
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
)

func panelEqual(a, b any) bool {
	x, e := jstext.EncodeJSON(a)
	y, f := jstext.EncodeJSON(b)
	return e == nil && f == nil && bytes.Equal(x, y)
}
func (l *panelLease) pendingMessage(ctx context.Context, v *panelView) (panelMap, error) {
	key := v.draftKey + ":pending-message"
	row, e := l.read(ctx, key)
	if e != nil || row == nil {
		return nil, e
	}
	payload := psObject(row["payload"])
	if !isOne(text(row["state"]), "unknown", "pending") {
		return panelMap{"clientMessageId": payload["clientMessageId"], "state": row["state"]}, nil
	}
	room := text(psObject(l.panel.viewInput(v)["object"])["id"])
	receipt, e := l.call(ctx, "/v2/chat/rooms/"+room+"/receipt", panelMap{"clientMessageId": payload["clientMessageId"], "requestHash": row["requestHash"]})
	if e != nil {
		if panelFatal(e) {
			return nil, e
		}
		return panelMap{"clientMessageId": payload["clientMessageId"], "state": "unknown"}, nil
	}
	state := receipt["state"]
	if state == "not-found" {
		state = "absent"
	}
	next := psObject(psClone(row))
	next["state"] = state
	if e = l.put(ctx, key, next); e != nil {
		return nil, e
	}
	return panelMap{"clientMessageId": payload["clientMessageId"], "state": state}, nil
}
func (l *panelLease) sendMessage(ctx context.Context, v *panelView, x panelMap) (panelMap, error) {
	if psObject(l.panel.viewInput(v)["object"])["kind"] != "room" {
		return nil, panelError("panel_room_required")
	}
	key := v.draftKey + ":pending-message"
	return l.panel.serial(ctx, key, func() (panelMap, error) {
		grant, e := l.replyGrant(ctx, v)
		if e != nil {
			return nil, e
		}
		if grant == nil {
			return nil, panelError("chat_agent_not_authorized")
		}
		row, e := l.read(ctx, key)
		if e != nil {
			return nil, e
		}
		if row != nil && psObject(row["payload"])["clientMessageId"] == x["clientMessageId"] {
			payload := psObject(row["payload"])
			if !panelEqual(payload["text"], x["text"]) || payload["replyTo"] != x["replyTo"] || payload["agentGrantId"] != grant["grantId"] {
				return nil, panelError("chat_message_conflict")
			}
			if row["state"] == "accepted" {
				return l.render(ctx, v)
			}
			receipt, e := l.pendingMessage(ctx, v)
			if e != nil {
				return nil, e
			}
			if receipt["state"] == "accepted" {
				return l.render(ctx, v)
			}
			if !isOne(text(receipt["state"]), "absent", "pending") {
				out, e := l.render(ctx, v)
				if e == nil {
					out["messageResult"] = receipt
				}
				return out, e
			}
		} else {
			if row != nil && isOne(text(row["state"]), "unknown", "pending", "conflict") {
				return nil, panelError("panel_message_pending")
			}
			payload := panelMap{"clientMessageId": x["clientMessageId"], "text": x["text"], "replyTo": x["replyTo"], "agentGrantId": grant["grantId"]}
			raw, e := jstext.EncodeJSON(payload)
			if e != nil {
				return nil, e
			}
			row = panelMap{"payload": payload, "requestHash": identity.Digest(raw), "state": "unknown"}
		}
		next := psObject(psClone(row))
		next["state"] = "unknown"
		if e = l.put(ctx, key, next); e != nil {
			return nil, e
		}
		room := text(psObject(l.panel.viewInput(v)["object"])["id"])
		out, e := l.call(ctx, "/v2/chat/rooms/"+room+"/send", row["payload"])
		if e == nil {
			next["state"] = out["state"]
			if e = l.put(ctx, key, next); e != nil {
				return nil, e
			}
		} else {
			if panelFatal(e) {
				return nil, e
			}
			if _, e = l.pendingMessage(ctx, v); e != nil {
				return nil, e
			}
		}
		return l.render(ctx, v)
	})
}
