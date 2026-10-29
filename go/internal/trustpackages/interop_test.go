package trustpackages

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/devicefixture"
	"github.com/google/uuid"
)

func TestCurrentAuthorPermissionAndReceipt(t *testing.T) {
	admin, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	const endpoint = "https://trust.example.invalid"
	scopes := []string{"binding", "consent", "case-teaser"}
	owner := deviceauthfixture.NewEndpoint(t, admin, t.TempDir(), scopes, endpoint)
	recipient := deviceauthfixture.NewEndpoint(t, admin, t.TempDir(), scopes, endpoint)
	pool, err := postgres.Open(ctx, dsn+"&options=-c%20role%3Dgalaxy_api")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	now := func() time.Time { return time.Unix(devicefixture.Now, 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: endpoint, Now: now}
	cs := &cases.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Now: now}
	caseID := uuid.NewString()
	payload := map[string]any{"schemaVersion": 2, "kind": "case-created", "eventId": caseID, "caseId": caseID, "expectedVersion": 0, "actorId": owner.Actor.SubjectID, "localRef": "trust-" + caseID, "title": "Exact author statement", "summary": "Private authored record", "source": map[string]any{"kind": "local", "reference": "trust-" + caseID}, "synthetic": false}
	grant := owner.Grant(t, payload, "case.teaser.publish", caseID, "Private", []string{recipient.Actor.SubjectID})
	raw, _ := json.Marshal(grant)
	if _, err = cs.SubmitV2(ctx, owner.Actor, raw, ""); err != nil {
		t.Fatal(err)
	}
	reader := &SourceReader{Endpoint: endpoint, Cases: cs, ReadCaseAsAuthor: cs.ReadV2GrantAuthorWithin, Now: now}
	s := New(pool, endpoint, devices, now)
	s.ReadSource, s.ReadAuthorSource = reader.ReadWithin, reader.ReadAuthorWithin
	h := Handler{Service: s}
	request := func(other bool, path string, input Object) Object {
		t.Helper()
		raw, _ := json.Marshal(input)
		r := httptest.NewRequest("POST", "/v2/trust-package/"+path, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		token := owner.Credential
		if other {
			token = recipient.Credential
		}
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
		var result Object
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	same := func(a, b Object, label string) {
		t.Helper()
		x, _ := json.Marshal(a)
		y, _ := json.Marshal(b)
		if !bytes.Equal(x, y) {
			t.Fatalf("%s: %s != %s", label, x, y)
		}
	}
	sign := func(text string) Object {
		t.Helper()
		key, e := identity.PrivatePEM([]byte(owner.Materials.OwnerPrivate))
		if e != nil {
			t.Fatal(e)
		}
		signed, e := identity.SignIdentityPayload(key, text, "galaxy-trust-source-permission-v1+jws")
		if e != nil {
			t.Fatal(e)
		}
		return Object{"signed": signed}
	}
	source := Object{"endpoint": endpoint, "kind": "case-event", "id": caseID, "version": 1, "caseId": caseID}
	previewInput := Object{"id": uuid.NewString(), "operationId": uuid.NewString(), "source": source, "grantee": recipient.Actor.SubjectID, "audience": Object{"kind": "subjects", "subjectIds": []any{recipient.Actor.SubjectID}}, "expiresAt": devicefixture.Now + 1800}
	preview := request(false, "permissions/preview", previewInput)
	signed := sign(str(preview, "payloadJson"))
	receipt := request(false, "permissions/submit", signed)
	same(receipt, request(false, "permissions/submit", signed), "lost grant ACK")
	lookup := Object{"id": previewInput["id"]}
	request(true, "permissions/receipt", lookup)
	request(true, "permissions/status", lookup)
	selection := Object{"selections": []any{Object{"ref": source, "mode": "copy", "permissionId": previewInput["id"]}}, "audience": previewInput["audience"], "expiresAt": devicefixture.Now + 900}
	before := request(true, "sources", selection)
	items := array(before["items"])
	if len(items) != 1 || object(items[0])["state"] != "available" || object(object(items[0])["snapshot"])["mode"] != "copy" || !bytes.Contains(mustJSON(object(items[0])["snapshot"]), []byte("Exact author statement")) {
		t.Fatalf("permission did not return the authored copy: %v", before)
	}
	revoke := Object{"id": previewInput["id"], "operationId": uuid.NewString()}
	revokePreview := request(false, "permissions/revoke-preview", revoke)
	revokeSigned := sign(str(revokePreview, "payloadJson"))
	revoked := request(false, "permissions/submit", revokeSigned)
	same(revoked, request(false, "permissions/submit", revokeSigned), "lost revoke ACK")
	status := request(true, "permissions/status", lookup)
	if status["status"] != "revoked" || status["sourceAccessGranted"] != false {
		t.Fatalf("revocation status: %v", status)
	}
	after := request(true, "sources", selection)
	items = array(after["items"])
	if len(items) != 1 || object(items[0])["state"] != "unavailable" || object(items[0])["snapshot"] != nil {
		t.Fatalf("revoked permission returned source: %v", after)
	}
	request(false, "permissions/receipt", lookup)
}

func mustJSON(v any) []byte { raw, _ := json.Marshal(v); return raw }
