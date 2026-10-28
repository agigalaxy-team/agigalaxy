package builders

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
)

func (s *Service) permitted(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, row Object) (bool, error) {
	if row == nil || row["payload_text"] == nil {
		return false, nil
	}
	g, e := s.grant(ctx, tx, row, false)
	if e != nil {
		if missing(e) {
			return false, nil
		}
		return false, e
	}
	return s.visible(g, a), nil
}

// ManifestWithin returns the selected exact historical manifest only while its
// own declaration and consent remain readable. Maintenance is reported here;
// writes/export separately refuse a delisted or security-blocked registration.
func (s *Service) ManifestWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, input Object) (Object, error) {
	b, e := s.load(ctx, tx, txt(input, "builderId"), false)
	if e != nil {
		return nil, e
	}
	current, _, e := s.current(ctx, tx, a, b)
	if e != nil {
		return nil, e
	}
	var row Object
	for _, r := range b.rows {
		if r["id"] == input["manifestId"] && r["kind"] == "pack-manifest" {
			row = r
		}
	}
	allowed, e := s.permitted(ctx, tx, a, row)
	if e != nil {
		return nil, e
	}
	if !allowed {
		return nil, fault.New("builder_pack_unavailable", 404)
	}
	if identity.Digest([]byte(txt(row, "payload_text"))) != row["payload_hash"] {
		return nil, fault.New("builder_pack_integrity_mismatch", 500)
	}
	if input["manifestHash"] != nil && input["manifestHash"] != row["payload_hash"] {
		return nil, fault.New("builder_pack_hash_mismatch", 409)
	}
	event, e := parse("builderExtensionEventSchema", []byte(txt(row, "payload_text")))
	if e != nil {
		return nil, e
	}
	var declaration Object
	for _, r := range b.rows {
		if r["id"] == event["declarationId"] && r["kind"] == "declare" {
			declaration = r
		}
	}
	allowed, e = s.permitted(ctx, tx, a, declaration)
	if e != nil {
		return nil, e
	}
	if !allowed || declaration["payload_hash"] != event["declarationHash"] {
		return nil, fault.New("builder_pack_declaration_unavailable", 404)
	}
	published := obj(eventOf(declaration)["declaration"])
	manifest := obj(event["manifest"])
	release := obj(published["release"])
	if published["type"] != "worker" || manifest["version"] != release["version"] || manifest["sha256"] != release["buildHash"] || manifest["source"] != release["artifact"] {
		return nil, fault.New("builder_pack_release_mismatch", 409)
	}
	status := "historical-version"
	pack := latest(b.rows, "pack-manifest")
	if b.declaration["id"] == declaration["id"] && pack["id"] == row["id"] && current != nil {
		status = "current"
	}
	out := maintenance(b.rows)
	for k, v := range (Object{"builderId": input["builderId"], "manifestId": row["id"], "manifestHash": row["payload_hash"], "authorId": row["subject_id"], "declarationId": declaration["id"], "manifest": manifest, "versionStatus": status, "installationPerformed": false, "workerStarted": false, "capabilityVerified": false}) {
		out[k] = v
	}
	return out, nil
}
func eventOf(row Object) Object { return event(row) }
func (s *Service) Manifest(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	input, e := parse("packManifestReadSchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		return s.ManifestWithin(ctx, tx, a, input)
	})
}
func (s *Service) suite(suite Object, observed int64) Object {
	for _, pin := range s.SuitePins {
		if pin["name"] != suite["name"] || pin["version"] != suite["version"] {
			continue
		}
		state := "current"
		switch {
		case pin["revoked"] == true:
			state = "revoked"
		case pin["sha256"] != suite["sha256"] || pin["source"] != suite["source"]:
			state = "source-changed"
		case s.now() < num(pin, "notBefore") || observed < num(pin, "notBefore"):
			state = "outside-validity"
		case s.now() >= num(pin, "notAfter"):
			state = "expired"
		}
		return Object{"state": state, "portable": state == "current", "validUntil": pin["notAfter"]}
	}
	return Object{"state": "untracked", "portable": false}
}
func (s *Service) extension(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, b loadedBuilder, row Object) (Object, error) {
	if row == nil {
		return Object{"state": "not-declared", "record": nil}, nil
	}
	v := event(row)
	allowed, e := s.permitted(ctx, tx, a, row)
	if e != nil {
		return nil, e
	}
	if v == nil || !allowed {
		return Object{"state": "unavailable", "record": nil}, nil
	}
	if v["declarationId"] != b.declaration["id"] || v["declarationHash"] != b.declaration["payload_hash"] {
		return Object{"state": "stale-declaration", "eventId": row["id"], "revision": row["revision"], "record": nil}, nil
	}
	return Object{"state": "current", "eventId": row["id"], "payloadHash": row["payload_hash"], "revision": row["revision"], "record": v}, nil
}
func (s *Service) SupportWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, input Object) (Object, error) {
	b, e := s.load(ctx, tx, txt(input, "builderId"), false)
	if e != nil {
		return nil, e
	}
	declaration, grant, e := s.current(ctx, tx, a, b)
	if e != nil {
		return nil, e
	}
	support, e := s.extension(ctx, tx, a, b, latest(b.rows, "support-profile"))
	if e != nil {
		return nil, e
	}
	pack, e := s.extension(ctx, tx, a, b, latest(b.rows, "pack-manifest"))
	if e != nil {
		return nil, e
	}
	reports := []any{}
	last := map[string]any{}
	for _, row := range b.rows {
		if row["kind"] == "scope-report" {
			v := event(row)
			last[txt(row, "subject_id")+"\x00"+txt(obj(v["run"]), "testClass")] = row["id"]
		}
	}
	for _, row := range b.rows {
		if row["kind"] != "scope-report" {
			continue
		}
		allowed, e := s.permitted(ctx, tx, a, row)
		if e != nil {
			return nil, e
		}
		if !allowed {
			continue
		}
		v := event(row)
		suite := s.suite(obj(v["suite"]), num(v, "observedAt"))
		validity := "current"
		switch {
		case v["declarationId"] != b.declaration["id"] || v["declarationHash"] != b.declaration["payload_hash"]:
			validity = "stale-declaration"
		case support["state"] != "current" || v["supportId"] != support["eventId"] || v["supportHash"] != support["payloadHash"]:
			validity = "stale-support"
		case last[txt(row, "subject_id")+"\x00"+txt(obj(v["run"]), "testClass")] != row["id"]:
			validity = "superseded"
		case !contains(s.AssessorIDs, txt(row, "subject_id")):
			validity = "assessor-removed"
		case num(v, "expiresAt") <= s.now():
			validity = "expired"
		case suite["state"] != "current" && suite["state"] != "untracked":
			validity = "suite-" + txt(suite, "state")
		}
		result := clone(v)
		for k, value := range (Object{"assessorId": row["subject_id"], "validity": validity, "suiteStatus": suite, "authority": "configured-assessor-reported", "independentExecutionVerified": false, "capabilityVerified": false}) {
			result[k] = value
		}
		reports = append(reports, result)
	}
	tested := []any{}
	supportBody := obj(obj(support["record"])["support"])
	for _, action := range arr(supportBody["objectActions"]) {
		observations := []any{}
		state := "not-tested"
		for _, item := range reports {
			report := obj(item)
			if report["validity"] != "current" {
				continue
			}
			for _, c := range arr(report["checks"]) {
				check := obj(c)
				if check["action"] == action {
					observations = append(observations, Object{"reportId": report["id"], "assessorId": report["assessorId"], "testClass": obj(report["run"])["testClass"], "status": check["status"], "detail": check["detail"]})
					if check["status"] == "fail" {
						state = "reported-fail"
					} else if state != "reported-fail" && check["status"] == "pass" {
						state = "reported-pass"
					}
				}
			}
		}
		tested = append(tested, Object{"action": action, "state": state, "observations": observations, "authority": "scoped-assessor-report; no professional certification"})
	}
	support["record"] = nullable(supportBody)
	support["testedScopes"] = tested
	pack["record"] = nullable(obj(obj(pack["record"])["manifest"]))
	var packID any
	if b.parent["type"] == "worker" {
		packID = b.parent["id"]
	}
	for k, value := range (Object{"packId": packID, "authorId": b.parent["owner_id"], "identityMeaning": "typed pack reference within this worker registration", "installation": "not-performed-by-registry", "runtime": "not-started-by-registry", "actualUseCount": nil}) {
		pack[k] = value
	}
	out := maintenance(b.rows)
	for k, value := range (Object{"builderId": b.parent["id"], "ownerId": b.parent["owner_id"], "type": b.parent["type"], "revision": b.parent["revision"], "declarationId": b.declaration["id"], "declarationHash": b.declaration["payload_hash"], "release": declaration["release"], "support": support, "pack": pack, "reports": reports, "checkedAt": s.now(), "capabilityVerified": false, "canSubmitReport": a != nil && a.SubjectID != txt(b.parent, "owner_id") && contains(s.AssessorIDs, a.SubjectID), "disclosure": nil, "reportDisclosure": nil}) {
		out[k] = value
	}
	if a != nil && a.SubjectID == txt(b.parent, "owner_id") {
		out["disclosure"] = Object{"visibility": grant.Visibility, "viewers": grant.Viewers}
	}
	if a != nil && a.SubjectID != txt(b.parent, "owner_id") && contains(s.AssessorIDs, a.SubjectID) {
		out["reportDisclosure"] = Object{"visibility": grant.Visibility, "viewers": reportViewers(grant, txt(b.parent, "owner_id"), a.SubjectID)}
	}
	return out, nil
}
func reportViewers(g deviceauth.ConsentIntent, owner, assessor string) []string {
	if g.Visibility == "Public" {
		return []string{}
	}
	out := []string{owner}
	for _, v := range g.Viewers {
		if v != assessor && !contains(out, v) {
			out = append(out, v)
		}
	}
	return out
}
func (s *Service) Support(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	input, e := parse("builderExtensionReadSchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		return s.SupportWithin(ctx, tx, a, input)
	})
}
func (s *Service) ExportPack(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	input, e := parse("builderPackExportSchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		v, e := s.SupportWithin(ctx, tx, a, input)
		if e != nil {
			return nil, e
		}
		pack := obj(v["pack"])
		if pack["state"] != "current" || pack["eventId"] != input["manifestId"] {
			return nil, fault.New("builder_pack_unavailable", 404)
		}
		if v["delisted"] == true || v["securityIssue"] == true {
			return nil, fault.New("builder_pack_maintenance_blocked", 409)
		}
		return Object{"schemaVersion": 1, "kind": "galaxy-worker-pack-reference", "packId": pack["packId"], "authorId": v["ownerId"], "builderId": v["builderId"], "declarationId": v["declarationId"], "declarationHash": v["declarationHash"], "manifestId": pack["eventId"], "payloadHash": pack["payloadHash"], "manifest": pack["record"], "checkedAt": s.now(), "authority": "author-declared-selected-metadata", "signatureVerification": "use-original-consent-or-separate-signed-proof", "currentRevocationMustBeRechecked": true, "installationPerformed": false, "workerStarted": false, "capabilityVerified": false}, nil
	})
}
