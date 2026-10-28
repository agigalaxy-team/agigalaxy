package builders

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"time"
)

func Specification() Object {
	var v Object
	_ = protocol.Decode([]byte(specificationJSON), &v)
	return v
}

// schemaOrder preserves Zod object output order for the original snapshot hash.
func schemaOrder(schema any, value any) any {
	s := obj(schema)
	for _, union := range []string{"oneOf", "anyOf"} {
		branches := arr(s[union])
		selected := any(nil)
		for _, b := range branches {
			props := obj(obj(b)["properties"])
			for _, key := range []string{"kind", "type", "action"} {
				if c, ok := obj(props[key])["const"]; ok && obj(value)[key] == c {
					selected = b
					break
				}
			}
			if selected != nil {
				break
			}
		}
		if selected == nil {
			for _, b := range branches {
				kind := obj(b)["type"]
				if kind == "object" && obj(value) != nil || kind == "array" && arr(value) != nil {
					selected = b
					break
				}
			}
		}
		if selected != nil {
			return schemaOrder(selected, value)
		}
	}
	if values := obj(value); values != nil {
		if properties, ok := s["properties"].(*protocol.OrderedObject); ok {
			out := protocol.NewOrderedObject()
			for _, key := range properties.Keys() {
				if v, ok := values[key]; ok {
					out.Set(key, schemaOrder(properties.Values()[key], v))
				}
			}
			return out
		}
	}
	if values, ok := value.([]any); ok {
		out := []any{}
		for _, v := range values {
			out = append(out, schemaOrder(s["items"], v))
		}
		return out
	}
	return value
}
func eventWire(v Object) (any, error) {
	raw, e := protocol.Encode(v)
	if e != nil {
		return nil, e
	}
	v, e = parse("builderEventSchema", raw)
	if e != nil {
		return nil, e
	}
	schemas, e := protocol.DecodeOrdered([]byte(builderEventOrderJSON))
	if e != nil {
		return nil, e
	}
	return schemaOrder(obj(schemas)[txt(v, "kind")], v), nil
}

func init() {
	routes["/v1/builders/specification"] = "specification"
	routes["/v1/builders/node-control/export"] = "export-control"
	routes["/v1/builders/reports/export"] = "export-report"
}
func (s *Service) auditPortable(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, auth deviceauth.ControlAuthorization, row Object, action, requestID string) error {
	var rid any
	if requestID != "" {
		rid = requestID
	}
	scopes, _ := protocol.Encode(auth.CredentialScopes)
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
 SELECT $1,$7,$2::text,COALESCE($3::text,$2::text),'accepted',1,ch.payload->>'installationId',b.audience,'builders',c.id,b.id,$3::uuid,COALESCE($3::text,$2::text),b.scopes,$4::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$5::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE c.id=$6::uuid`, a.SubjectID, row["id"], rid, string(scopes), a.BindingID, row["consent_id"], action)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("builder export audit unavailable")
	}
	return nil
}
func (s *Service) ExportNodeControl(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	in, e := parse("nodeControlRequestSchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		b, e := s.load(ctx, tx, txt(in, "builderId"), false)
		if e != nil {
			return nil, e
		}
		current, grant, e := s.current(ctx, tx, &a, b)
		if e != nil {
			return nil, e
		}
		state, e := s.nodeControl(ctx, tx, &a, b, current)
		if e != nil {
			return nil, e
		}
		unavailable := fault.New("node_control_export_unavailable", 409)
		if s.SignConformance == nil || state["state"] != "node-authorized-owner" || state["controlId"] != in["controlId"] {
			return nil, unavailable
		}
		var row Object
		for _, r := range b.rows {
			if r["id"] == state["controlId"] {
				row = r
				break
			}
		}
		control := event(row)
		cg, e := s.grant(ctx, tx, row, false)
		if e != nil {
			return nil, e
		}
		bindings, e := query(ctx, tx, "SELECT expires_at FROM bindings WHERE id=ANY($1::uuid[])", []string{cg.BindingID, grant.BindingID})
		if e != nil {
			return nil, e
		}
		checked := s.now()
		expiry := min(checked+300, num(control, "expiresAt"), cg.ExpiresAt, grant.ExpiresAt)
		for _, binding := range bindings {
			expiry = min(expiry, binding["expires_at"].(time.Time).Unix())
		}
		if len(bindings) == 0 || expiry <= checked {
			return nil, unavailable
		}
		orderedControl, e := eventWire(control)
		if e != nil {
			return nil, e
		}
		data := ordered("version", 1, "id", row["id"], "builderId", b.parent["id"], "ownerId", b.parent["owner_id"], "nodeId", control["nodeId"], "declarationId", b.declaration["id"], "declarationHash", b.declaration["payload_hash"], "control", orderedControl, "controlPayloadJson", row["payload_text"], "sourceEventHash", row["payload_hash"], "checkedAt", checked, "expiresAt", expiry, "authority", "registry-attested-node-authorization", "capabilityVerified", false, "endpointControlVerified", false, "maintenance", orderKeys(maintenance(b.rows), "delisted", "securityIssue"), "statusPath", "/v1/builders/node-control/export")
		encoded, _ := protocol.EncodeJS(data)
		if _, e = parse("nodeControlSnapshotSchema", encoded); e != nil {
			return nil, e
		}
		signed, e := s.SignConformance(ctx, "node-control", data, txt(row, "id"), expiry-checked)
		if e != nil {
			return nil, e
		}
		if e = s.auditPortable(ctx, tx, a, auth, row, "builder.node-control.export", requestID); e != nil {
			return nil, e
		}
		return Object{"signed": signed}, nil
	})
}
func (s *Service) ExportReport(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	in, e := parse("conformanceRequestSchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		current, e := s.ReadWithin(ctx, tx, &a, in)
		if e != nil {
			return nil, e
		}
		var item Object
		for _, r := range arr(current["reports"]) {
			if obj(r)["id"] == in["reportId"] {
				item = obj(r)
				break
			}
		}
		unavailable := fault.New("conformance_report_unavailable", 409)
		if s.SignConformance == nil || item == nil || item["validity"] != "current" || obj(item["suiteStatus"])["portable"] != true {
			return nil, unavailable
		}
		rows, e := query(ctx, tx, "SELECT id::text,subject_id,consent_id::text,payload_hash,payload_text FROM builder_events WHERE id=ANY($1::uuid[])", []string{txt(item, "id"), txt(current, "declarationId")})
		if e != nil {
			return nil, e
		}
		var row, decl Object
		for _, r := range rows {
			if r["id"] == item["id"] {
				row = r
			}
			if r["id"] == current["declarationId"] {
				decl = r
			}
		}
		rg, e := s.grant(ctx, tx, row, false)
		if e != nil {
			return nil, e
		}
		dg, e := s.grant(ctx, tx, decl, false)
		if e != nil {
			return nil, e
		}
		checked := s.now()
		expiry := min(checked+300, num(item, "expiresAt"), num(obj(item["suiteStatus"]), "validUntil"), rg.ExpiresAt, dg.ExpiresAt)
		if expiry <= checked {
			return nil, unavailable
		}
		var report Object
		if protocol.Decode([]byte(txt(row, "payload_text")), &report) != nil {
			return nil, fmt.Errorf("invalid original builder report")
		}
		reportWire, e := eventWire(report)
		if e != nil {
			return nil, e
		}
		reportJSON, e := protocol.EncodeJS(reportWire)
		if e != nil {
			return nil, e
		}
		version := 1
		if report["profile"] != nil {
			version = 2
		}
		data := ordered("version", version, "id", item["id"], "builderId", current["builderId"], "ownerId", current["ownerId"], "assessorId", item["assessorId"], "declarationId", current["declarationId"], "declarationHash", current["declarationHash"], "release", orderKeys(obj(obj(current["declaration"])["release"]), "version", "buildHash", "sourceCommit"), "report", reportWire, "reportHash", identity.Digest(reportJSON), "sourceEventHash", row["payload_hash"], "checkedAt", checked, "expiresAt", expiry, "suiteVerification", "operator-pinned-reference", "authority", "registry-signed-assessor-report", "capabilityVerified", false, "independentExecutionVerified", false, "maintenance", orderKeys(current, "delisted", "securityIssue"), "statusPath", "/v1/builders/reports/export")
		encoded, _ := protocol.EncodeJS(data)
		if _, e = parse("conformanceSnapshotSchema", encoded); e != nil {
			return nil, e
		}
		signed, e := s.SignConformance(ctx, "conformance", data, txt(item, "id"), expiry-checked)
		if e != nil {
			return nil, e
		}
		if e = s.auditPortable(ctx, tx, a, auth, row, "builder.export", requestID); e != nil {
			return nil, e
		}
		return Object{"signed": signed}, nil
	})
}
