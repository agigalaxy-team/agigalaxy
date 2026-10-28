package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"math/big"
	"sort"
	"time"
)

type SharedSummaryService struct{ Chat *Service }

func (f *SharedSummaryService) run(ctx context.Context, a Actor, write bool, fn func(pgx.Tx) (Object, error)) (Object, error) {
	if a.Device == nil {
		return nil, fail("access_denied", 401)
	}
	return f.Chat.run(ctx, a, write, false, fn)
}
func sharedError() error { return fail("invalid_shared_summary_request", 400) }
func summaryRefs(v any) ([]any, bool) {
	refs, ok := v.([]any)
	if !ok || len(refs) > 100 {
		return nil, false
	}
	for _, v := range refs {
		r, ok := v.(map[string]any)
		if !ok || !strict(r, "messageId", "revision") || !validID(str(r, "messageId")) || !normalizeInteger(r, "revision", 1, 9007199254740991) {
			return nil, false
		}
	}
	return refs, true
}
func summaryContent(v any) (Object, bool) {
	c, ok := v.(map[string]any)
	if !ok || !strict(c, "generator", "coverage", "fragments", "keyMessageRefs") {
		return nil, false
	}
	g := obj(c, "generator")
	if g == nil || !strict(g, "kind", "label") || !has([]string{"user-model", "manual"}, str(g, "kind")) {
		return nil, false
	}
	if label, ok := g["label"]; ok {
		value, ok := label.(string)
		if !ok || textLength(value) > 120 {
			return nil, false
		}
	}
	coverage := obj(c, "coverage")
	if coverage == nil || !strict(coverage, "fromSequence", "throughSequence", "complete") || !digits.MatchString(str(coverage, "fromSequence")) || !digits.MatchString(str(coverage, "throughSequence")) {
		return nil, false
	}
	if _, ok := coverage["complete"].(bool); !ok {
		return nil, false
	}
	from, _ := new(big.Int).SetString(str(coverage, "fromSequence"), 10)
	through, _ := new(big.Int).SetString(str(coverage, "throughSequence"), 10)
	if from.Cmp(through) > 0 {
		return nil, false
	}
	fragments, ok := c["fragments"].([]any)
	if !ok || len(fragments) > 100 {
		return nil, false
	}
	seen := map[string]bool{}
	for _, v := range fragments {
		p, ok := v.(map[string]any)
		if !ok || !strict(p, "id", "kind", "text", "sourceRefs") || !validID(str(p, "id")) || seen[str(p, "id")] || !has([]string{"derived", "personal-note"}, str(p, "kind")) {
			return nil, false
		}
		seen[str(p, "id")] = true
		text, ok := p["text"].(string)
		if !ok || textLength(text) < 1 || textLength(text) > 8000 {
			return nil, false
		}
		refs, ok := summaryRefs(p["sourceRefs"])
		if !ok || str(p, "kind") == "derived" && len(refs) == 0 {
			return nil, false
		}
	}
	if _, ok := summaryRefs(c["keyMessageRefs"]); !ok {
		return nil, false
	}
	if len(stringifySeparators(encode(c))) > 65536 {
		return nil, false
	}
	return c, true
}
func sharedInput(raw []byte, publish, receipt bool) (Object, error) {
	keys := []string{"roomId", "shareId"}
	if publish {
		keys = []string{"shareId", "roomId", "expectedMemberRevision", "audience", "content", "agentGrantId", "supersedesShareId"}
	} else if receipt {
		keys = append(keys, "requestHash")
	}
	x, e := parse(raw, keys...)
	if e != nil || !validID(str(x, "roomId")) || !validID(str(x, "shareId")) {
		return nil, sharedError()
	}
	if receipt && !hashPattern.MatchString(str(x, "requestHash")) {
		return nil, sharedError()
	}
	if publish {
		content, ok := summaryContent(x["content"])
		if !ok || !normalizeInteger(x, "expectedMemberRevision", 1, 9007199254740991) || str(x, "audience") != "room-authorized-members" || len(content["fragments"].([]any)) == 0 && len(content["keyMessageRefs"].([]any)) == 0 {
			return nil, sharedError()
		}
		for _, key := range []string{"agentGrantId", "supersedesShareId"} {
			if v, ok := x[key]; ok && !validID(asString(v)) {
				return nil, sharedError()
			}
		}
	}
	return x, nil
}
func (f *SharedSummaryService) row(ctx context.Context, tx pgx.Tx, room, share string) (Object, error) {
	r, e := row(ctx, tx, "SELECT to_jsonb(s) FROM room_shared_summaries s WHERE room_id=$1 AND share_id=$2 FOR UPDATE", room, share)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, fail("shared_summary_unavailable", 404)
	}
	return r, nil
}
func summaryNotice(share, grant string) Object {
	out := Object{"clientMessageId": share, "text": "银河共享摘要与关键消息：" + share, "replyTo": nil}
	if grant != "" {
		out["agentGrantId"] = grant
	}
	return out
}
func cloneSummary(o Object) Object { var out Object; _ = protocol.Decode(encode(o), &out); return out }
func refKey(r Object) string {
	return str(r, "messageId") + ":" + big.NewInt(num(r, "revision")).String()
}
func contentReferences(content Object) []Object {
	unique := map[string]Object{}
	for _, value := range content["fragments"].([]any) {
		fragment, _ := value.(map[string]any)
		for _, value := range fragment["sourceRefs"].([]any) {
			ref, _ := value.(map[string]any)
			unique[refKey(ref)] = ref
		}
	}
	for _, value := range content["keyMessageRefs"].([]any) {
		ref, _ := value.(map[string]any)
		unique[refKey(ref)] = ref
	}
	out := []Object{}
	for _, ref := range unique {
		out = append(out, ref)
	}
	sort.SliceStable(out, func(i, j int) bool { return str(out[i], "messageId") < str(out[j], "messageId") })
	return out
}
func (f *SharedSummaryService) sourceState(ctx context.Context, tx pgx.Tx, a *Actor, room string, ref Object, maintenance bool) (Object, error) {
	if !maintenance {
		if a == nil {
			return nil, fail("access_denied", 401)
		}
		if _, e := f.Chat.requireRoom(ctx, tx, *a, room, true, false); e != nil {
			if fault.Status(e) == 403 || fault.Status(e) == 404 {
				return Object{"available": false}, nil
			}
			return nil, e
		}
	}
	r, e := row(ctx, tx, `SELECT to_jsonb(m)||jsonb_build_object('sequence',m.sequence::text,'edit_pending',EXISTS(SELECT 1 FROM chat_message_operations o WHERE o.message_id=m.message_id AND o.state='pending'),'author_pending',EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=m.subject_id AND d.state IN ('requested','review-needed','approved','partial','primary-erased'))) FROM chat_message_refs m WHERE m.message_id=$1 AND m.room_id=$2 FOR SHARE OF m`, ref["messageId"], room)
	if e != nil {
		return nil, e
	}
	if r == nil || str(r, "state") != "accepted" || num(r, "revision") != num(ref, "revision") || millis(r["expires_at"]) <= f.Chat.now().UnixMilli() {
		return Object{"available": false}, nil
	}
	var blocked bool
	if e = tx.QueryRow(ctx, "SELECT "+operationsBlocked+" FROM chat_message_refs m WHERE message_id=$1", r["message_id"]).Scan(&blocked); e != nil {
		return nil, e
	}
	if blocked || truth(r, "edit_pending") || truth(r, "author_pending") && (maintenance || a == nil || a.Device == nil || str(r, "subject_id") != a.Device.SubjectID) {
		return Object{"available": false, "temporarilyUnavailable": true}, nil
	}
	return Object{"available": true, "expiresAt": iso(r["expires_at"]), "authorId": r["subject_id"], "revision": r["revision"], "sequence": r["sequence"]}, nil
}

type summaryFiltered struct {
	Content, Persisted                     Object
	Invalidated, StorageChanged, Temporary bool
}

func (f *SharedSummaryService) filter(ctx context.Context, tx pgx.Tx, a *Actor, room string, content Object, maintenance bool) (summaryFiltered, error) {
	out := summaryFiltered{Content: Object{}}
	if content == nil || content["fragments"] == nil {
		return out, nil
	}
	result, persisted := cloneSummary(content), cloneSummary(content)
	cache := map[string]Object{}
	check := func(ref Object) (Object, error) {
		key := refKey(ref)
		if cached := cache[key]; cached != nil {
			return cached, nil
		}
		state, e := f.sourceState(ctx, tx, a, room, ref, maintenance)
		if e != nil {
			return nil, e
		}
		cache[key] = state
		return state, nil
	}
	fragments, retainedFragments, refs, retainedRefs := []any{}, []any{}, []any{}, []any{}
	for _, v := range result["fragments"].([]any) {
		fragment, _ := v.(map[string]any)
		valid, permanent := true, false
		for _, v := range fragment["sourceRefs"].([]any) {
			ref, _ := v.(map[string]any)
			state, e := check(ref)
			if e != nil {
				return out, e
			}
			if !truth(state, "available") {
				valid = false
				if !truth(state, "temporarilyUnavailable") {
					permanent = true
				}
			}
		}
		if valid {
			fragments = append(fragments, fragment)
		}
		if !permanent {
			retainedFragments = append(retainedFragments, fragment)
		}
	}
	for _, v := range result["keyMessageRefs"].([]any) {
		ref, _ := v.(map[string]any)
		state, e := check(ref)
		if e != nil {
			return out, e
		}
		if truth(state, "available") {
			refs = append(refs, ref)
		}
		if truth(state, "available") || truth(state, "temporarilyUnavailable") {
			retainedRefs = append(retainedRefs, ref)
		}
	}
	out.Invalidated = len(fragments) != len(result["fragments"].([]any)) || len(refs) != len(result["keyMessageRefs"].([]any))
	out.StorageChanged = len(retainedFragments) != len(persisted["fragments"].([]any)) || len(retainedRefs) != len(persisted["keyMessageRefs"].([]any))
	result["fragments"], result["keyMessageRefs"] = fragments, refs
	persisted["fragments"], persisted["keyMessageRefs"] = retainedFragments, retainedRefs
	if out.Invalidated {
		obj(result, "coverage")["complete"] = false
	}
	if out.StorageChanged {
		obj(persisted, "coverage")["complete"] = false
	}
	out.Content, out.Persisted = result, persisted
	out.Temporary = len(fragments) < len(retainedFragments) || len(refs) < len(retainedRefs)
	return out, nil
}
func (f *SharedSummaryService) reconcile(ctx context.Context, tx pgx.Tx, r Object) (Object, error) {
	if !has([]string{"pending", "published"}, str(r, "state")) {
		return r, nil
	}
	m, e := row(ctx, tx, "SELECT to_jsonb(m) FROM chat_message_refs m WHERE room_id=$1 AND subject_id=$2 AND client_message_id=$3 FOR SHARE", r["room_id"], r["subject_id"], r["share_id"])
	if e != nil {
		return nil, e
	}
	if m != nil && m["payload_hash"] != r["notice_hash"] {
		return nil, fail("shared_summary_message_conflict")
	}
	if m != nil && millis(m["expires_at"]) < millis(r["expires_at"]) {
		if _, e = tx.Exec(ctx, "UPDATE room_shared_summaries SET expires_at=$2 WHERE share_id=$1", r["share_id"], m["expires_at"]); e != nil {
			return nil, e
		}
		r["expires_at"] = m["expires_at"]
	}
	expired := millis(r["expires_at"]) <= f.Chat.now().UnixMilli() || m != nil && millis(m["expires_at"]) <= f.Chat.now().UnixMilli()
	removed := m != nil && has([]string{"retracted", "expired"}, str(m, "state"))
	if expired || removed {
		state := "retracted"
		if expired || str(m, "state") == "expired" {
			state = "expired"
		}
		var id any
		if m != nil {
			id = m["message_id"]
		}
		if _, e = tx.Exec(ctx, "UPDATE room_shared_summaries SET state=$2,content='{}'::jsonb,source_facts='[]'::jsonb,message_id=COALESCE(message_id,$3) WHERE share_id=$1", r["share_id"], state, id); e != nil {
			return nil, e
		}
		r["state"], r["content"], r["source_facts"] = state, Object{}, []any{}
		if id != nil {
			r["message_id"] = id
		}
		return r, nil
	}
	if m != nil && str(m, "state") == "accepted" && (str(r, "state") != "published" || r["message_id"] == nil) {
		if _, e = tx.Exec(ctx, "UPDATE room_shared_summaries SET state='published',message_id=$2 WHERE share_id=$1", r["share_id"], m["message_id"]); e != nil {
			return nil, e
		}
		r["state"], r["message_id"] = "published", m["message_id"]
	}
	return r, nil
}
func summaryFacts(facts any, content Object) []any {
	keys := map[string]bool{}
	if content["fragments"] != nil {
		for _, ref := range contentReferences(content) {
			keys[refKey(ref)] = true
		}
	}
	all, _ := facts.([]any)
	out := []any{}
	for _, v := range all {
		fact, _ := v.(map[string]any)
		if keys[refKey(fact)] {
			out = append(out, fact)
		}
	}
	return out
}
func (f *SharedSummaryService) view(ctx context.Context, tx pgx.Tx, a Actor, r Object) (Object, error) {
	r, e := f.reconcile(ctx, tx, r)
	if e != nil {
		return nil, e
	}
	if _, e = f.Chat.requireRoom(ctx, tx, a, str(r, "room_id"), true, false); e != nil {
		return nil, e
	}
	subject := a.Device.SubjectID
	if str(r, "state") == "pending" && str(r, "subject_id") != subject {
		return nil, fail("shared_summary_unavailable", 404)
	}
	if str(r, "subject_id") != subject {
		var pending bool
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased'))", r["subject_id"]).Scan(&pending); e != nil {
			return nil, e
		}
		if pending {
			return nil, fail("shared_summary_temporarily_unavailable", 404)
		}
	}
	blocked := func() (bool, error) {
		if r["message_id"] == nil {
			return false, nil
		}
		var blocked bool
		e := tx.QueryRow(ctx, "SELECT "+operationsBlocked+" FROM chat_message_refs m WHERE message_id=$1", r["message_id"]).Scan(&blocked)
		if e == pgx.ErrNoRows {
			e = nil
		}
		return blocked, e
	}
	noticeBlocked, e := blocked()
	if e != nil {
		return nil, e
	}
	filtered := summaryFiltered{Content: Object{}, Invalidated: true, Temporary: true}
	if !noticeBlocked {
		filtered, e = f.filter(ctx, tx, &a, str(r, "room_id"), obj(r, "content"), false)
		if e != nil {
			return nil, e
		}
	}
	if filtered.StorageChanged {
		facts := summaryFacts(r["source_facts"], filtered.Persisted)
		if _, e = tx.Exec(ctx, "UPDATE room_shared_summaries SET content=$2,source_facts=$3 WHERE share_id=$1", r["share_id"], encode(filtered.Persisted), encode(facts)); e != nil {
			return nil, e
		}
		r["source_facts"] = facts
	}
	noticeBlocked, e = blocked()
	if e != nil {
		return nil, e
	}
	if noticeBlocked {
		filtered = summaryFiltered{Content: Object{}, Invalidated: true, Temporary: true}
	}
	return Object{"shareId": r["share_id"], "roomId": r["room_id"], "authorId": r["subject_id"], "state": r["state"], "messageId": r["message_id"], "supersedesShareId": r["supersedes_share_id"], "createdAt": iso(r["created_at"]), "expiresAt": iso(r["expires_at"]), "content": filtered.Content, "sourceFacts": summaryFacts(r["source_facts"], filtered.Content), "sourceInvalidated": filtered.Invalidated, "sourcesTemporarilyUnavailable": filtered.Temporary, "audience": "room-authorized-members", "publicationPermission": false, "personalVersionChanged": false, "acceptedByRoom": str(r, "state") == "published"}, nil
}
func (f *SharedSummaryService) beforeSend(ctx context.Context, tx pgx.Tx, a Actor, room, share, hash string) error {
	c, e := f.Chat.requireRoom(ctx, tx, a, room, true, true)
	if e != nil {
		return e
	}
	r, e := f.row(ctx, tx, room, share)
	if e != nil {
		return e
	}
	if str(r, "subject_id") != a.Device.SubjectID || !has([]string{"pending", "published"}, str(r, "state")) || millis(r["expires_at"]) <= f.Chat.now().UnixMilli() {
		return fail("shared_summary_send_unavailable")
	}
	if str(r, "state") == "pending" && num(c.Room, "member_revision") != num(r, "member_revision") {
		return fail("shared_summary_audience_changed")
	}
	content := obj(r, "content")
	if canonical(content) != hash {
		return fail("shared_summary_sources_changed_select_again")
	}
	if content == nil || content["fragments"] == nil || len(content["fragments"].([]any)) == 0 && len(content["keyMessageRefs"].([]any)) == 0 {
		return fail("shared_summary_sources_unavailable")
	}
	filtered, e := f.filter(ctx, tx, &a, room, content, false)
	if e != nil {
		return e
	}
	if filtered.Invalidated {
		return fail("shared_summary_sources_unavailable")
	}
	return nil
}
func (f *SharedSummaryService) Publish(ctx context.Context, a Actor, raw []byte) (Object, error) {
	x, e := sharedInput(raw, true, false)
	if e != nil {
		return nil, e
	}
	prepared, e := f.run(ctx, a, true, func(tx pgx.Tx) (Object, error) {
		c, e := f.Chat.requireRoom(ctx, tx, a, str(x, "roomId"), true, true)
		if e != nil {
			return nil, e
		}
		prior, e := row(ctx, tx, "SELECT to_jsonb(s) FROM room_shared_summaries s WHERE share_id=$1 FOR UPDATE", x["shareId"])
		if e != nil {
			return nil, e
		}
		if prior != nil {
			if str(prior, "subject_id") != a.Device.SubjectID || prior["room_id"] != x["roomId"] || str(prior, "request_hash") != canonical(x) {
				return nil, fail("shared_summary_operation_conflict")
			}
			return f.reconcile(ctx, tx, prior)
		}
		if has([]string{"archived", "owner-succession"}, str(c.Room, "state")) {
			return nil, fail("chat_room_read_only")
		}
		if num(c.Room, "member_revision") != num(x, "expectedMemberRevision") {
			return nil, fail("shared_summary_audience_changed")
		}
		if e = f.Chat.agent(ctx, tx, a, str(x, "roomId"), str(x, "agentGrantId"), true); e != nil {
			return nil, e
		}
		if x["supersedesShareId"] != nil {
			previous, e := f.row(ctx, tx, str(x, "roomId"), str(x, "supersedesShareId"))
			if e != nil {
				return nil, e
			}
			if str(previous, "subject_id") != a.Device.SubjectID || str(previous, "state") == "pending" {
				return nil, fail("shared_summary_correction_unavailable")
			}
		}
		content := obj(x, "content")
		facts := []any{}
		for _, ref := range contentReferences(content) {
			state, e := f.sourceState(ctx, tx, &a, str(x, "roomId"), ref, false)
			if e != nil {
				return nil, e
			}
			if !truth(state, "available") {
				return nil, fail("shared_summary_sources_unavailable")
			}
			source, e := f.Chat.ReadSelectedWithin(ctx, tx, a, str(ref, "messageId"), num(ref, "revision"))
			if e != nil {
				return nil, e
			}
			if source["roomId"] != x["roomId"] {
				return nil, fail("shared_summary_source_room_mismatch", 403)
			}
			facts = append(facts, Object{"messageId": ref["messageId"], "revision": ref["revision"], "sequence": source["sequence"], "authorId": source["authorId"], "contentHash": source["contentHash"], "expiresAt": source["expiresAt"]})
		}
		if _, e = tx.Exec(ctx, `INSERT INTO room_shared_summaries(share_id,subject_id,room_id,member_revision,request_hash,notice_hash,supersedes_share_id,content,source_facts,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, x["shareId"], a.Device.SubjectID, x["roomId"], num(x, "expectedMemberRevision"), canonical(x), canonical(summaryNotice(str(x, "shareId"), str(x, "agentGrantId"))), x["supersedesShareId"], encode(content), encode(facts), f.Chat.now(), f.Chat.now().Add(time.Duration(num(c.Room, "retention_days"))*24*time.Hour)); e != nil {
			return nil, e
		}
		return f.row(ctx, tx, str(x, "roomId"), str(x, "shareId"))
	})
	if e != nil {
		return nil, e
	}
	if str(prepared, "state") == "pending" {
		if _, e = f.Chat.sendWithHook(ctx, a, str(x, "roomId"), encode(summaryNotice(str(x, "shareId"), str(x, "agentGrantId"))), func(ctx context.Context, tx pgx.Tx) error {
			return f.beforeSend(ctx, tx, a, str(x, "roomId"), str(x, "shareId"), canonical(obj(x, "content")))
		}); e != nil {
			return nil, e
		}
	}
	return f.Get(ctx, a, encode(Object{"roomId": x["roomId"], "shareId": x["shareId"]}))
}
func (f *SharedSummaryService) Get(ctx context.Context, a Actor, raw []byte) (Object, error) {
	x, e := sharedInput(raw, false, false)
	if e != nil {
		return nil, e
	}
	return f.run(ctx, a, false, func(tx pgx.Tx) (Object, error) {
		if _, e := f.Chat.requireRoom(ctx, tx, a, str(x, "roomId"), true, false); e != nil {
			return nil, e
		}
		r, e := f.row(ctx, tx, str(x, "roomId"), str(x, "shareId"))
		if e != nil {
			return nil, e
		}
		return f.view(ctx, tx, a, r)
	})
}
