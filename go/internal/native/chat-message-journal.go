package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
)

// One current-identity/service/room journal retains only original send locators.
// Message bodies and grants remain in the original caller; this journal never replays them.
func chatJournalKey(l *nativeIdentityLease, room string) string {
	return "native-chat-sends:" + l.scope.Endpoint + ":" + l.scope.Owner + ":" + room
}
func chatSendHash(body map[string]any) (string, error) {
	value := identityClone(body)
	if _, ok := value["replyTo"]; !ok {
		value["replyTo"] = nil
	}
	raw, err := identity.Canonical(value)
	if err != nil {
		return "", err
	}
	return identity.Digest(raw), nil
}
func chatJournalPrepare(ctx context.Context, l *nativeIdentityLease, room string, body map[string]any) (map[string]any, error) {
	hash, err := chatSendHash(body)
	if err != nil {
		return nil, err
	}
	id := text(body["clientMessageId"])
	var existing map[string]any
	err = l.update(ctx, chatJournalKey(l, room), func(old map[string]any) (map[string]any, error) {
		if old == nil {
			old = map[string]any{"version": 1, "roomId": room, "items": map[string]any{}}
		}
		items := uploadObject(old["items"])
		if old["roomId"] != room || items == nil {
			return nil, fault.New("native_chat_journal_invalid", 500)
		}
		for key, entry := range items {
			if uploadObject(entry)["state"] == "accepted" {
				delete(items, key)
			}
		}
		prior := uploadObject(items[id])
		if prior != nil {
			if prior["requestHash"] != hash {
				return nil, fault.New("native_chat_original_message_changed", 409)
			}
			existing = identityClone(prior)
			if prior["state"] == "conflict" {
				return nil, fault.New("native_chat_original_message_conflict", 409)
			}
		}
		items[id] = map[string]any{"clientMessageId": id, "requestHash": hash, "state": "unknown"}
		return old, nil
	})
	return existing, err
}
func chatJournalObserve(ctx context.Context, l *nativeIdentityLease, room, id, hash string, result map[string]any) error {
	state := text(result["state"])
	if state == "not-found" {
		state = "absent"
	}
	if state == "" && result["messageId"] != nil {
		state = "accepted"
	}
	if !isOne(state, "accepted", "absent", "conflict") {
		return nil
	}
	return l.update(ctx, chatJournalKey(l, room), func(old map[string]any) (map[string]any, error) {
		if old == nil {
			return nil, nil
		}
		items := uploadObject(old["items"])
		row := uploadObject(items[id])
		if row == nil || row["requestHash"] != hash {
			return old, nil
		}
		if state == "accepted" {
			delete(items, id)
		} else {
			row["state"] = state
		}
		return old, nil
	})
}
func chatJournalPending(ctx context.Context, l *nativeIdentityLease, room string) (map[string]any, error) {
	row, err := l.read(ctx, chatJournalKey(l, room))
	if err != nil {
		return nil, err
	}
	items := []any{}
	if row != nil {
		if row["roomId"] != room || uploadObject(row["items"]) == nil {
			return nil, fault.New("native_chat_journal_invalid", 500)
		}
		needsCleanup := false
		for _, entry := range uploadObject(row["items"]) {
			value := uploadObject(entry)
			if value != nil && value["state"] == "accepted" {
				needsCleanup = true
			} else if value != nil {
				items = append(items, identityClone(value))
			}
		}
		if needsCleanup {
			err = l.update(ctx, chatJournalKey(l, room), func(current map[string]any) (map[string]any, error) {
				for key, entry := range uploadObject(current["items"]) {
					if uploadObject(entry)["state"] == "accepted" {
						delete(uploadObject(current["items"]), key)
					}
				}
				return current, nil
			})
			if err != nil {
				return nil, err
			}
		}
	}
	return map[string]any{"roomId": room, "items": items}, nil
}
