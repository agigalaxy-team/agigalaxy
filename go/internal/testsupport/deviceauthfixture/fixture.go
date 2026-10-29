// Package deviceauthfixture composes the real Go device authority for isolated tests.
package deviceauthfixture

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/devicefixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Fixture struct {
	Materials  devicefixture.Fixture
	Service    *deviceauth.Service
	Actor      deviceauth.Actor
	Credential string
}

// Prepare performs a real control bootstrap without creating a binding.
func Prepare(t *testing.T, pool *pgxpool.Pool, dir string, scopes []string) Fixture {
	return PrepareEndpoint(t, pool, dir, scopes, devicefixture.Endpoint)
}

// PrepareEndpoint bootstraps a synthetic identity against the selected endpoint.
func PrepareEndpoint(t *testing.T, pool *pgxpool.Pool, dir string, scopes []string, endpoint string) Fixture {
	t.Helper()
	ctx := context.Background()
	m := devicefixture.NewEndpoint(t, pool, dir, endpoint)
	svc, e := deviceauth.Load(ctx, pool, deviceauth.Configuration{Endpoint: endpoint, SigningKeyFile: filepath.Join(dir, "hub-private.pem"), SigningKeyID: "fixture", RootPinsFile: filepath.Join(dir, "root-pins.json"), KeyringFile: filepath.Join(dir, "keyring.json"), TrustDirectory: filepath.Join(dir, "trust"), Now: func() time.Time { return time.Unix(devicefixture.Now, 0) }})
	if e != nil {
		t.Fatal(e)
	}
	key, e := identity.PrivatePEM([]byte(m.OwnerPrivate))
	if e != nil {
		t.Fatal(e)
	}
	controlScopes := append([]string{"manage-identity"}, scopes...)
	request := deviceauth.ControlRequest{Version: 2, OperationID: uuid.NewString(), SubjectID: m.Genesis.ID, Kind: "bootstrap", SignerKeyID: identity.Digest([]byte(m.PublicKeyPEM)), GenesisProof: m.Genesis.GenesisProof, NewDevice: &deviceauth.ControlDevice{DeviceID: m.DeviceID, PublicKeyPEM: m.PublicKeyPEM, Scopes: controlScopes}}
	raw, e := json.Marshal(request)
	if e != nil {
		t.Fatal(e)
	}
	challenge, e := svc.ControlChallenge(ctx, raw)
	if e != nil {
		t.Fatal(e)
	}
	sign := func(payload, typ string) string {
		t.Helper()
		signature, e := identity.SignIdentityPayload(key, payload, typ)
		if e != nil {
			t.Fatal(e)
		}
		return signature
	}
	sig := sign(challenge["challenge"].(string), "galaxy-identity-control-v2+jws")
	if _, e = svc.ControlCommit(ctx, deviceauth.ControlCommit{OperationID: request.OperationID, ControllerSignature: sig, NewDeviceProof: &sig}); e != nil {
		t.Fatal(e)
	}
	return Fixture{Materials: m, Service: svc}
}

// New additionally creates a real binding and activates its device session.
func New(t *testing.T, pool *pgxpool.Pool, dir string, scopes []string) Fixture {
	return NewEndpoint(t, pool, dir, scopes, devicefixture.Endpoint)
}

// NewEndpoint additionally creates an authenticated synthetic session.
func NewEndpoint(t *testing.T, pool *pgxpool.Pool, dir string, scopes []string, endpoint string) Fixture {
	t.Helper()
	ctx := context.Background()
	prepared := PrepareEndpoint(t, pool, dir, scopes, endpoint)
	m, svc := prepared.Materials, prepared.Service
	key, e := identity.PrivatePEM([]byte(m.OwnerPrivate))
	if e != nil {
		t.Fatal(e)
	}
	sign := func(payload, typ string) string {
		t.Helper()
		signature, e := identity.SignIdentityPayload(key, payload, typ)
		if e != nil {
			t.Fatal(e)
		}
		return signature
	}
	bound, e := svc.BindingChallenge(ctx, deviceauth.BindingInput{SubjectID: m.Genesis.ID, GenesisProof: m.Genesis.GenesisProof, InstallationID: m.InstallationID, Scopes: scopes, Control: &deviceauth.BindingControl{DeviceID: m.DeviceID, KeyID: identity.Digest([]byte(m.PublicKeyPEM)), Epoch: 1}}, true)
	if e != nil {
		t.Fatal(e)
	}
	binding, e := svc.Bind(ctx, deviceauth.BindInput{Challenge: bound["challenge"], Signature: sign(bound["challenge"], "galaxy-binding-response+jws"), ClientSession: bound["clientSession"]}, nil)
	if e != nil {
		t.Fatal(e)
	}
	data := make([]byte, 32)
	if _, e = rand.Read(data); e != nil {
		t.Fatal(e)
	}
	credential := base64.RawURLEncoding.EncodeToString(data)
	preview, e := svc.Challenge(ctx, deviceauth.ChallengeInput{BindingID: binding.BindingID, CredentialHash: identity.Digest([]byte(credential))})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = svc.Activate(ctx, deviceauth.ActivateInput{Challenge: preview["challenge"], Signature: sign(preview["challenge"], "galaxy-session-response+jws")}, nil); e != nil {
		t.Fatal(e)
	}
	actor, e := svc.Authenticate(ctx, credential, scopes[0])
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(dir, "credential.txt"), []byte(credential), 0600); e != nil {
		t.Fatal(e)
	}
	return Fixture{Materials: m, Service: svc, Actor: actor, Credential: credential}
}

// Grant captures an actual consent for the supplied synthetic payload. The
// exact JSON bytes are returned unchanged for the subsequent Go service call.
func (f Fixture) Grant(t *testing.T, payload map[string]any, action, objectID, visibility string, viewers []string) map[string]any {
	t.Helper()
	if viewers == nil {
		viewers = []string{}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	fields := make([]string, 0, len(payload))
	for name := range payload {
		fields = append(fields, name)
	}
	sort.Strings(fields)
	purpose := "operational"
	if visibility == "Public" {
		purpose = "public-profile"
	}
	intent := deviceauth.ConsentIntent{Version: 1, ID: uuid.NewString(), SubjectID: f.Actor.SubjectID, BindingID: f.Actor.BindingID, Endpoint: f.Service.Endpoint, ObjectID: objectID, Action: action, Purpose: purpose, Recipient: f.Service.Endpoint, Fields: fields, Visibility: visibility, Viewers: viewers, PayloadHash: identity.Digest(raw), PolicyVersion: "0.1", IssuedAt: devicefixture.Now, ExpiresAt: devicefixture.Now + 2591900}
	signedRaw, err := json.Marshal(intent)
	if err != nil {
		t.Fatal(err)
	}
	private, err := identity.PrivatePEM([]byte(f.Materials.OwnerPrivate))
	if err != nil {
		t.Fatal(err)
	}
	signature, err := identity.SignIdentityPayload(private, string(signedRaw), "galaxy-consent+jws")
	if err != nil {
		t.Fatal(err)
	}
	captured, err := f.Service.CaptureConsent(context.Background(), f.Actor, signature)
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{"consentId": captured.ConsentID, "payloadJson": string(raw)}
}
