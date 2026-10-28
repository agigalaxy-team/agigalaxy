package taskmaterials

import (
	"context"
	"errors"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/jackc/pgx/v5"
)

// ReadCapsuleWithin keeps the original outcome reader's required identity.
// Public audience permits a current authenticated reader; it is not an
// anonymous actor or a replacement for the capsule's own source authorization.
func (o *OutcomeService) ReadCapsuleWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) (Object, error) {
	if a == nil || a.SubjectID == "" {
		return nil, fail("access_denied", 403)
	}
	return o.ReadWithin(ctx, tx, Actor{Actor: *a}, id)
}

func (o *OutcomeService) Inspect(ctx context.Context, a Actor, id string) (any, error) {
	if !validID(id) {
		return nil, fail("invalid_outcome_material_request", 400)
	}
	return o.run(ctx, a, "evidence", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		m, e := o.lock(ctx, tx, id, false)
		if e != nil {
			return nil, e
		}
		if m == nil || !contains([]string{str(m, "subject_id"), str(m, "author_id")}, a.SubjectID) {
			return nil, fail("outcome_material_unavailable", 404)
		}
		request, e := outcomeOperation(ctx, tx, m["request_id"])
		if e != nil {
			return nil, e
		}
		if request == nil {
			return nil, fail("outcome_material_unavailable", 404)
		}
		if a.SubjectID != str(m, "subject_id") {
			if _, e = o.requireConsent(ctx, tx, request); e != nil {
				return nil, e
			}
		}
		var sourceContent any
		var reason, name, media, readExpiry any
		source := obj(m, "source")
		messageID := ""
		capture := func(e error) error {
			var serviceError *fault.Error
			if !errors.As(e, &serviceError) {
				return e
			}
			reason = fault.Code(e)
			return nil
		}
		if str(source, "kind") == "message" {
			messageID = str(source, "id")
			selected, e := o.exactSource(ctx, tx, a, source)
			if e == nil {
				if o.RecheckMessage == nil {
					e = fail("outcome_message_source_unavailable", 503)
				} else {
					var current Object
					current, e = o.RecheckMessage(ctx, tx, a, str(source, "roomId"), messageID, num(source["version"]))
					if e == nil {
						if str(current, "room_id") != str(source, "roomId") || str(current, "subject_id") != selected.AuthorID || str(current, "state") != "accepted" || num(current["revision"]) != num(source["version"]) || sec(current["expires_at"]) <= o.now() {
							e = fail("chat_message_version_unavailable")
						} else {
							sourceContent = Object{"source": selected.Source, "authorId": selected.AuthorID, "size": selected.Size, "content": selected.Text, "readExpiresAt": sec(current["expires_at"]), "currentRoomReadOnly": true, "independentRetentionGranted": false}
						}
					}
				}
			}
			if e != nil {
				if fatal := capture(e); fatal != nil {
					return nil, fatal
				}
			}
		} else if str(source, "kind") == "attachment" {
			if o.InspectAttachment == nil {
				reason = "outcome_attachment_copy_unavailable"
			} else {
				attachment, e := o.InspectAttachment(ctx, tx, a, str(source, "id"))
				if e != nil {
					if fatal := capture(e); fatal != nil {
						return nil, fatal
					}
				} else if num(source["version"]) != 1 || str(attachment, "room_id") != str(source, "roomId") || str(attachment, "sha256") != str(source, "sha256") {
					reason = "outcome_source_changed"
				} else {
					name, media = attachment["name"], attachment["media_type"]
					expiry := sec(attachment["expires_at"])
					if attachment["expires_at"] == nil {
						expiry = sec(attachment["prepare_expires_at"])
					}
					if expiry > 0 {
						readExpiry = expiry
					}
					messageID = str(attachment, "message_id")
					if messageID != "" {
						var msg Object
						msg, e = row(ctx, tx, "SELECT jsonb_build_object('expires_at',expires_at) FROM chat_message_refs WHERE message_id=$1 FOR SHARE", messageID)
						if e != nil {
							return nil, e
						}
						if msg != nil && sec(msg["expires_at"]) > 0 {
							expiry = sec(msg["expires_at"])
							if readExpiry != nil {
								expiry = min(expiry, num(readExpiry))
							}
							readExpiry = expiry
						}
					}
				}
			}
		}
		if a.SubjectID != str(m, "subject_id") {
			if _, e = o.requireConsent(ctx, tx, request); e != nil {
				return nil, e
			}
		}
		if messageID != "" && (sourceContent != nil || name != nil || media != nil) {
			// Reuse the chat domain's real current metadata authority after source I/O.
			// It checks effective operation hiding, current membership and source TTL.
			if o.RecheckMessage == nil {
				return nil, fail("outcome_message_source_unavailable", 503)
			}
			revision := num(source["version"])
			if str(source, "kind") == "attachment" {
				var current Object
				current, e = row(ctx, tx, "SELECT jsonb_build_object('revision',revision) FROM chat_message_refs WHERE message_id=$1 FOR SHARE", messageID)
				if e != nil {
					return nil, e
				}
				revision = num(current["revision"])
			}
			if _, e = o.RecheckMessage(ctx, tx, a, str(source, "roomId"), messageID, revision); e != nil {
				var serviceError *fault.Error
				if !errors.As(e, &serviceError) {
					return nil, e
				}
				sourceContent = nil
				name = nil
				media = nil
				readExpiry = nil
				reason = "chat_message_version_unavailable"
			}
		}
		if content, ok := sourceContent.(Object); ok && num(content["readExpiresAt"]) <= o.now() {
			sourceContent = nil
			reason = "chat_message_version_unavailable"
		}
		if readExpiry != nil && num(readExpiry) <= o.now() {
			name = nil
			media = nil
			readExpiry = nil
			reason = "attachment_content_unavailable"
		}
		payload, e := parseObject(str(request, "payload_text"))
		if e != nil {
			return nil, e
		}
		out := o.view(m)
		out["requestHash"] = request["payload_hash"]
		out["request"] = payload
		out["sourceContent"] = sourceContent
		out["sourceContentReason"] = reason
		out["sourceName"] = name
		out["sourceMediaType"] = media
		out["sourceReadExpiresAt"] = readExpiry
		return out, nil
	})
}
func (o *OutcomeService) Query(ctx context.Context, a Actor, view, after string, limit int) (any, error) {
	if view == "" {
		view = "requested"
	}
	if limit == 0 {
		limit = 20
	}
	if !contains([]string{"requested", "authored"}, view) || after != "" && !validID(after) || limit < 1 || limit > 50 {
		return nil, fail("invalid_outcome_material_request", 400)
	}
	return o.run(ctx, a, "evidence", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		owner := "subject_id"
		if view == "authored" {
			owner = "author_id"
		}
		var cursor *string
		if after != "" {
			cursor = &after
		}
		candidates, e := rows(ctx, tx, "SELECT to_jsonb(m) FROM outcome_materials_v2 m WHERE "+owner+"=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3", a.SubjectID, cursor, limit+1)
		if e != nil {
			return nil, e
		}
		items := []Object{}
		for _, m := range candidates[:min(limit, len(candidates))] {
			if str(m, "subject_id") != a.SubjectID {
				event, e := outcomeOperation(ctx, tx, m["request_id"])
				if e != nil {
					return nil, e
				}
				if _, e = o.requireConsent(ctx, tx, event); e != nil {
					var serviceError *fault.Error
					if errors.As(e, &serviceError) {
						continue
					}
					return nil, e
				}
			}
			items = append(items, o.view(m))
		}
		var next any
		if len(candidates) > limit {
			next = candidates[limit-1]["id"]
		}
		return Object{"items": items, "nextAfter": next}, nil
	})
}
func (o *OutcomeService) Receipt(ctx context.Context, a Actor, id, hash string) (any, error) {
	if !validID(id) || !hashPattern.MatchString(hash) {
		return nil, fail("invalid_outcome_material_request", 400)
	}
	return o.run(ctx, a, "evidence", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		e, err := outcomeOperation(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		out := Object{"operationId": id, "state": "absent"}
		if e == nil || str(e, "subject_id") != a.SubjectID {
			return out, nil
		}
		if str(e, "payload_hash") != hash {
			out["state"] = "conflict"
			return out, nil
		}
		m, err := o.lock(ctx, tx, str(e, "material_id"), false)
		if err != nil {
			return nil, err
		}
		if m == nil {
			return nil, fail("outcome_material_unavailable", 404)
		}
		out["state"] = "recorded"
		out["material"] = o.view(m)
		return out, nil
	})
}
func (o *OutcomeService) PurgeExpired(ctx context.Context, limit int) (any, error) {
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > 100 {
		return nil, fail("invalid_outcome_material_request", 400)
	}
	return o.purgeCopies(ctx, limit)
}

// CleanupWithin can run under the lifecycle coordinator's existing transaction.
// It only reconciles external deletion: an uncommitted reservation cannot prove
// that an earlier DELETE was not sent. Inline text retains the original cleanup.
func (o *OutcomeService) CleanupWithin(ctx context.Context, tx pgx.Tx, at int64, limit int) (Object, error) {
	if at < 0 || limit < 1 || limit > 1000 {
		return nil, fail("invalid_outcome_material_request", 400)
	}
	candidates, e := rows(ctx, tx, `SELECT to_jsonb(q) FROM (SELECT m.* FROM outcome_materials_v2 m WHERE m.purged_at IS NULL AND (m.purge_pending OR m.expires_at<=$1 OR (m.state='requested' AND m.request_expires_at<=$1) OR EXISTS(SELECT 1 FROM cases c WHERE c.id=m.case_id AND c.state='withdrawn') OR EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id IN(m.subject_id,m.author_id) AND d.state IN ('approved','partial','primary-erased'))) ORDER BY m.created_at,m.id LIMIT $2 FOR UPDATE SKIP LOCKED) q`, stamp(at), limit)
	if e != nil {
		return nil, e
	}
	erased := 0
	for _, m := range candidates {
		if str(m, "storage_key") != "" {
			if !objectremoval.Capable(o.Store) {
				return nil, fail("outcome_material_storage_unavailable", 503)
			}
			removals := o.removalService()
			d := outcomeRemovalDescriptor(m)
			if _, e = removals.ObserveWithin(ctx, tx, d); e != nil {
				return nil, e
			}
			status, resolveError := removals.ResolveWithin(ctx, tx, o.Store, d, nil)
			if resolveError != nil && status.State == "" {
				return nil, resolveError
			}
			// Preserve the committed technical pending state on storage errors.
			// The copy stays unavailable and its pointer remains for later HEAD.
			if !status.ObjectRemoved {
				continue
			}
		}
		if _, e = tx.Exec(ctx, "UPDATE outcome_materials_v2 SET state='erased',body_text='',name='',media_type='',storage_key=NULL,encryption_key_id=NULL,purge_pending=false,purged_at=$2 WHERE id=$1", m["id"], stamp(at)); e != nil {
			return nil, e
		}
		erased++
	}
	return Object{"outcomeMaterialCopiesErased": erased, "externalCopiesErased": false}, nil
}

func (o *OutcomeService) removalService() *objectremoval.Service {
	if o.Removals != nil {
		return o.Removals
	}
	return &objectremoval.Service{Pool: o.Pool, Endpoint: o.Endpoint, Now: o.Now}
}
func outcomeRemovalDescriptor(m Object) objectremoval.Descriptor {
	return objectremoval.Descriptor{Domain: "outcome", ObjectID: str(m, "id"), StorageKey: str(m, "storage_key"), KeyID: str(m, "encryption_key_id"), SHA256: str(m, "sha256"), ByteSize: num(m["byte_size"])}
}
