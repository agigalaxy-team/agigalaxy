package discovery

import (
	"context"
	"errors"
	"sort"
	"strconv"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/jackc/pgx/v5"
)

func (s *LegacyIndex) requireGrant(ctx context.Context, tx pgx.Tx, input deviceauth.ConsentRequirement) (deviceauth.ConsentIntent, error) {
	if s.ConsentReader != nil {
		return s.ConsentReader(ctx, tx, input)
	}
	if s.Devices == nil {
		return deviceauth.ConsentIntent{}, fail("search_source_unavailable")
	}
	return s.Devices.RequireWorkerConsentWithin(ctx, tx, input)
}
func (s *LegacyIndex) build(ctx context.Context, tx pgx.Tx, job LegacyIndexJob) (*LegacyDocument, error) {
	age, e := s.maxAge()
	if e != nil {
		return nil, e
	}
	kind, id, subject := str(job.Payload, "sourceType"), str(job.Payload, "sourceId"), str(job.Payload, "subjectId")
	dependencies := map[string]bool{}
	until := s.now().Unix() + age
	collect := func(ctx context.Context, tx pgx.Tx, input deviceauth.ConsentRequirement) (deviceauth.ConsentIntent, error) {
		intent, e := s.requireGrant(ctx, tx, input)
		if e != nil {
			return intent, e
		}
		dependencies["consent:"+intent.ID] = true
		dependencies["binding:"+intent.BindingID] = true
		until = min(until, intent.ExpiresAt)
		return intent, nil
	}
	grant := func(row Object, action string, publicOnly bool) error {
		intent, e := collect(ctx, tx, deviceauth.ConsentRequirement{ID: str(row, "consent_id"), SubjectID: str(row, "subject_id"), ObjectID: str(row, "id"), Action: action, Recipient: s.Endpoint, PayloadJSON: str(row, "payload_text")})
		if e != nil {
			return e
		}
		if publicOnly && (intent.Visibility != "Public" || intent.Purpose != "public-profile" || intent.ExpiresAt <= s.now().Unix() || intent.IssuedAt > s.now().Unix() || intent.CurrentVisibility != nil && intent.CurrentVisibility.DeletionPending) {
			return qualityFailure("index_source_not_public", 404)
		}
		return nil
	}
	lock := func(refs ...string) error {
		for _, ref := range refs {
			dependencies[ref] = true
		}
		_, e := tx.Exec(ctx, "SELECT public.galaxy_search_lock_sources($1::jsonb)", jsonString(refs))
		return e
	}
	caseSource := func(caseID, owner string, publicOnly bool) (Object, []Object, error) {
		if e := lock("case:" + caseID); e != nil {
			return nil, nil, e
		}
		parent, e := rowObject(ctx, tx, "SELECT to_jsonb(c) FROM cases c WHERE id=$1 AND subject_id=$2", caseID, owner)
		if e != nil {
			return nil, nil, e
		}
		if parent == nil || str(parent, "state") == "withdrawn" {
			return nil, nil, qualityFailure("index_case_unavailable", 404)
		}
		rows, e := tx.Query(ctx, "SELECT to_jsonb(e) FROM case_events e WHERE case_id=$1 ORDER BY version LIMIT 1001", caseID)
		if e != nil {
			return nil, nil, e
		}
		events := []Object{}
		for rows.Next() {
			var raw []byte
			var event Object
			if e = rows.Scan(&raw); e != nil {
				rows.Close()
				return nil, nil, e
			}
			if e = decode(raw, &event); e != nil {
				rows.Close()
				return nil, nil, e
			}
			events = append(events, event)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, nil, e
		}
		if len(events) == 0 || len(events) > 1000 || int64(len(events)) != number(parent, "version") || str(events[0], "kind") != "case" {
			return nil, nil, qualityFailure("index_case_unavailable", 404)
		}
		for _, event := range events {
			if e = grant(event, "case.teaser.publish", publicOnly); e != nil {
				return nil, nil, e
			}
		}
		return parent, events, nil
	}
	document := &LegacyDocument{Type: kind, ID: id, SubjectID: subject, Metadata: Object{}}
	switch kind {
	case "case", "history":
		parent, events, e := caseSource(id, subject, true)
		if e != nil {
			return nil, e
		}
		root := object(events[0]["payload"])
		document.Title = str(root, "title")
		document.Summary = str(root, "summary")
		document.Version = strconv.FormatInt(number(parent, "version"), 10)
		document.SearchText = document.Title + " " + document.Summary
		document.Metadata = Object{"sourceType": kind, "sourceVersion": parent["version"]}
	case "proof":
		row, e := rowObject(ctx, tx, "SELECT to_jsonb(p) FROM proofs p WHERE id=$1 AND subject_id=$2", id, subject)
		if e != nil {
			return nil, e
		}
		if row == nil || row["revoked_at"] != nil {
			return nil, qualityFailure("index_proof_unavailable", 404)
		}
		submission, e := rowObject(ctx, tx, "SELECT to_jsonb(e) FROM evidence_submissions e WHERE id=$1", row["evidence_id"])
		if e != nil {
			return nil, e
		}
		if submission == nil {
			return nil, qualityFailure("index_proof_unavailable", 404)
		}
		if e = lock("case:"+str(submission, "case_id"), "evidence:"+str(submission, "id"), "proof:"+id); e != nil {
			return nil, e
		}
		if s.Evidence == nil {
			return nil, fail("search_source_unavailable")
		}
		reader := *s.Evidence
		reader.ConsentReader = collect
		reader.LockCaseState = func(ctx context.Context, tx pgx.Tx, caseID, owner string) (string, error) {
			var state string
			e := tx.QueryRow(ctx, "SELECT state FROM cases WHERE id=$1 AND subject_id=$2", caseID, owner).Scan(&state)
			if errors.Is(e, pgx.ErrNoRows) {
				return "", qualityFailure("case_not_found", 404)
			}
			return state, e
		}
		proof := &evidence.ProofService{Evidence: &reader}
		observation, e := proof.CurrentSourceObservationWithin(ctx, tx, str(row, "evidence_id"), subject)
		if e != nil {
			return nil, e
		}
		if observation != str(row, "observation_id") {
			return nil, qualityFailure("index_proof_unavailable", 404)
		}
		if e = grant(row, "proof.publish", true); e != nil {
			return nil, e
		}
		var payload Object
		if e = decode([]byte(str(row, "payload_text")), &payload); e != nil {
			return nil, e
		}
		until = min(until, number(payload, "expiresAt"))
		source := object(payload["source"])
		repository := str(source, "owner") + "/" + str(source, "repository")
		runID := jsScalar(source["runId"])
		document.Title = repository + " · run " + runID
		document.Summary = str(payload, "conclusion")
		document.SearchText = strings.Join([]string{repository, str(source, "commit"), runID, str(payload, "conclusion"), str(payload, "scope")}, " ")
		document.Version = observation
		document.Metadata = Object{"sourceType": kind, "observationId": row["observation_id"], "conclusion": payload["conclusion"], "signatureVerified": false}
	case "worker", "hub":
		if e = lock("builder:" + id); e != nil {
			return nil, e
		}
		parent, e := rowObject(ctx, tx, "SELECT to_jsonb(b) FROM builders b WHERE id=$1 AND owner_id=$2 AND type=$3", id, subject, kind)
		if e != nil {
			return nil, e
		}
		if parent == nil {
			return nil, qualityFailure("index_builder_unavailable", 404)
		}
		rows, e := tx.Query(ctx, "SELECT to_jsonb(e) FROM builder_events e WHERE builder_id=$1 ORDER BY revision LIMIT 1001", id)
		if e != nil {
			return nil, e
		}
		events := []Object{}
		var declaration Object
		delisted := false
		for rows.Next() {
			var raw []byte
			var row Object
			if e = rows.Scan(&raw); e != nil {
				rows.Close()
				return nil, e
			}
			if e = decode(raw, &row); e != nil {
				rows.Close()
				return nil, e
			}
			events = append(events, row)
			if str(row, "kind") == "declare" {
				declaration = row
			}
			if str(row, "kind") == "maintenance" {
				var event Object
				if e = decode([]byte(str(row, "payload_text")), &event); e != nil {
					rows.Close()
					return nil, e
				}
				if str(event, "action") == "delist" {
					delisted = true
				} else if str(event, "action") == "relist" {
					delisted = false
				}
			}
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
		if declaration == nil || len(events) > 1000 || int64(len(events)) != number(parent, "revision") {
			return nil, qualityFailure("index_builder_unavailable", 404)
		}
		if delisted {
			return nil, qualityFailure("index_builder_delisted", 404)
		}
		if e = grant(declaration, "builder.publish", true); e != nil {
			return nil, e
		}
		var payload Object
		if e = decode([]byte(str(declaration, "payload_text")), &payload); e != nil {
			return nil, e
		}
		value := object(payload["declaration"])
		document.Title = str(value, "name")
		document.Summary = str(value, "scope")
		fields := builderFields(value)
		text := []string{}
		for _, field := range fields {
			text = append(text, field.value)
		}
		document.SearchText = strings.Join(text, " ")
		document.Version = str(declaration, "id")
		document.Metadata = Object{"sourceType": kind, "declarationId": declaration["id"], "declarationHash": declaration["payload_hash"], "revision": parent["revision"], "version": object(value["release"])["version"]}
	case "capsule":
		if e = lock("capsule:" + id); e != nil {
			return nil, e
		}
		rows, e := tx.Query(ctx, "SELECT to_jsonb(e) FROM capsule_events e WHERE capsule_id=$1 AND subject_id=$2 AND kind='version' ORDER BY revision DESC LIMIT 100", id, subject)
		if e != nil {
			return nil, e
		}
		events := []Object{}
		for rows.Next() {
			var raw []byte
			var event Object
			if e = rows.Scan(&raw); e != nil {
				rows.Close()
				return nil, e
			}
			if e = decode(raw, &event); e != nil {
				rows.Close()
				return nil, e
			}
			events = append(events, event)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
		for _, row := range events {
			var payload Object
			if str(row, "payload_text") == "" {
				continue
			}
			if e = decode([]byte(str(row, "payload_text")), &payload); e != nil {
				return nil, e
			}
			if payload == nil || number(payload, "schemaVersion") == 2 {
				continue
			}
			if e = grant(row, "capsule.publish", true); e != nil {
				if hiddenLegacySource(e) {
					continue
				}
				return nil, e
			}
			if _, _, e = caseSource(str(object(payload["sourceResolution"]), "caseId"), subject, false); e != nil {
				if hiddenLegacySource(e) {
					continue
				}
				return nil, e
			}
			document.Title = str(payload, "title")
			document.Summary = str(payload, "problemPattern")
			document.SearchText = document.Title + " " + document.Summary
			document.Version = str(row, "id")
			document.Metadata = Object{"sourceType": kind, "versionId": row["id"], "version": payload["version"], "capabilityId": payload["capabilityId"]}
			break
		}
		if document.Version == "" {
			return nil, qualityFailure("index_capsule_unavailable", 404)
		}
	default:
		return nil, errors.New("invalid search job kind")
	}
	if until <= s.now().Unix() {
		return nil, qualityFailure("index_source_expired", 404)
	}
	document.ValidUntil = until
	for dependency := range dependencies {
		document.Dependencies = append(document.Dependencies, dependency)
	}
	sort.Strings(document.Dependencies)
	return document, nil
}

type searchField struct{ name, value string }

func builderFields(declaration Object) []searchField {
	fields := []searchField{{"name", str(declaration, "name")}, {"scope", str(declaration, "scope")}, {"version", str(object(declaration["release"]), "version")}}
	switch str(declaration, "type") {
	case "worker":
		configuration := object(declaration["configuration"])
		tools, _ := stringArray(configuration["tools"])
		tasks, _ := stringArray(configuration["taskTypes"])
		capabilities := []string{}
		for _, value := range objects(declaration["capabilities"]) {
			capabilities = append(capabilities, str(value, "id")+" "+str(value, "claim")+" "+str(value, "limitations"))
		}
		fields = append(fields, searchField{"configuration", str(configuration, "summary")}, searchField{"modelFamily", str(configuration, "modelFamily")}, searchField{"tools", strings.Join(tools, " ")}, searchField{"taskTypes", strings.Join(tasks, " ")}, searchField{"capabilities", strings.Join(capabilities, " ")})
	case "hub":
		fields = append(fields, searchField{"operator", str(declaration, "operator")}, searchField{"region", str(declaration, "region")}, searchField{"endpoint", str(declaration, "endpoint")}, searchField{"specVersion", str(object(declaration["manifest"]), "specVersion")})
	}
	return fields
}
func jsScalar(value any) string {
	if s, ok := value.(string); ok {
		return s
	}
	return jsonString(value)
}
