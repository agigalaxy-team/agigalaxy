package deviceauth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/devicefixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"path/filepath"
	"testing"
	"time"
)

func prepareControlFixture(t *testing.T, pool *pgxpool.Pool, dir string, bootstrap bool) devicefixture.Fixture {
	t.Helper()
	f := devicefixture.New(t, pool, dir)
	if !bootstrap {
		return f
	}
	ctx := context.Background()
	svc, e := Load(ctx, pool, Configuration{Endpoint: devicefixture.Endpoint, SigningKeyFile: filepath.Join(dir, "hub-private.pem"), SigningKeyID: "fixture", RootPinsFile: filepath.Join(dir, "root-pins.json"), KeyringFile: filepath.Join(dir, "keyring.json"), TrustDirectory: filepath.Join(dir, "trust"), Now: func() time.Time { return time.Unix(devicefixture.Now, 0) }})
	if e != nil {
		t.Fatal(e)
	}
	key, e := identity.PrivatePEM([]byte(f.OwnerPrivate))
	if e != nil {
		t.Fatal(e)
	}
	request := ControlRequest{Version: 2, OperationID: uuid.NewString(), SubjectID: f.Genesis.ID, Kind: "bootstrap", SignerKeyID: identity.Digest([]byte(f.PublicKeyPEM)), GenesisProof: f.Genesis.GenesisProof, NewDevice: &ControlDevice{DeviceID: f.DeviceID, PublicKeyPEM: f.PublicKeyPEM, Scopes: []string{"manage-identity", "binding", "history"}}}
	raw, e := json.Marshal(request)
	if e != nil {
		t.Fatal(e)
	}
	challenge, e := svc.ControlChallenge(ctx, raw)
	if e != nil {
		t.Fatal(e)
	}
	signature, e := identity.SignIdentityPayload(key, challenge["challenge"].(string), "galaxy-identity-control-v2+jws")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = svc.ControlCommit(ctx, ControlCommit{OperationID: request.OperationID, ControllerSignature: signature, NewDeviceProof: &signature}); e != nil {
		t.Fatal(e)
	}
	return f
}

// bindControlFixture issues a real session through the device service. The
// same-package test cannot import deviceauthfixture without an import cycle.
func bindControlFixture(t *testing.T, service *Service, f devicefixture.Fixture, scopes []string) (Actor, string) {
	t.Helper()
	ctx := context.Background()
	key, err := identity.PrivatePEM([]byte(f.OwnerPrivate))
	if err != nil {
		t.Fatal(err)
	}
	sign := func(payload, typ string) string {
		signature, err := identity.SignIdentityPayload(key, payload, typ)
		if err != nil {
			t.Fatal(err)
		}
		return signature
	}
	challenge, err := service.BindingChallenge(ctx, BindingInput{SubjectID: f.Genesis.ID, GenesisProof: f.Genesis.GenesisProof, InstallationID: f.InstallationID, Scopes: scopes, Control: &BindingControl{DeviceID: f.DeviceID, KeyID: identity.Digest([]byte(f.PublicKeyPEM)), Epoch: 1}}, true)
	if err != nil {
		t.Fatal(err)
	}
	bound, err := service.Bind(ctx, BindInput{Challenge: challenge["challenge"], Signature: sign(challenge["challenge"], "galaxy-binding-response+jws"), ClientSession: challenge["clientSession"]}, nil)
	if err != nil {
		t.Fatal(err)
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		t.Fatal(err)
	}
	credential := base64.RawURLEncoding.EncodeToString(secret)
	preview, err := service.Challenge(ctx, ChallengeInput{BindingID: bound.BindingID, CredentialHash: identity.Digest([]byte(credential))})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Activate(ctx, ActivateInput{Challenge: preview["challenge"], Signature: sign(preview["challenge"], "galaxy-session-response+jws")}, nil); err != nil {
		t.Fatal(err)
	}
	actor, err := service.Authenticate(ctx, credential, scopes[0])
	if err != nil {
		t.Fatal(err)
	}
	return actor, credential
}
