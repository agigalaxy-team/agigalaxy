package main

import (
	"context"
	"os"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/servicemetadata"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The development entry can run account-only domains without a device signer.
// Any partial original configuration is an error, never an unsigned fallback.
func loadDevices(ctx context.Context, pool *pgxpool.Pool, endpoint string) (*deviceauth.Service, error) {
	names := []string{"GALAXY_SIGNING_KEY_FILE", "GALAXY_SIGNING_KEY_ID", "GALAXY_ROOT_PINS_FILE", "GALAXY_KEYRING_FILE", "GALAXY_TRUST_DIRECTORY"}
	values := make([]string, len(names))
	configured := 0
	for i, name := range names {
		values[i] = os.Getenv(name)
		if values[i] != "" {
			configured++
		}
	}
	if configured == 0 {
		return nil, nil
	}
	if configured != len(names) {
		return nil, fault.New("device_auth_configuration_invalid", 400)
	}
	return deviceauth.Load(ctx, pool, deviceauth.Configuration{
		Endpoint: endpoint, SigningKeyFile: values[0], SigningKeyID: values[1],
		RootPinsFile: values[2], KeyringFile: values[3], TrustDirectory: values[4],
	})
}

func deviceReady(devices *deviceauth.Service, now time.Time) bool {
	if devices == nil {
		return false
	}
	keys, ok := devices.Signer.(*deviceauth.SessionKeyring)
	if !ok || keys.Pins == nil {
		return false
	}
	pin, ok := keys.Pins()[keys.KID]
	at := now.Unix()
	return ok && !pin.Revoked && pin.NotBefore <= at && at+86400 <= pin.NotAfter && pin.TrustedUntil != nil && at+300 <= *pin.TrustedUntil
}

func loadServiceMetadata(devices *deviceauth.Service) (*servicemetadata.Service, error) {
	if devices == nil {
		return nil, nil
	}
	keys, ok := devices.Signer.(*deviceauth.SessionKeyring)
	if !ok {
		return nil, fault.New("device_auth_configuration_invalid", 400)
	}
	return servicemetadata.New(servicemetadata.Configuration{
		Endpoint: devices.Endpoint, SigningKeyID: keys.KID,
		Operator: os.Getenv("GALAXY_OPERATOR"), Region: os.Getenv("GALAXY_REGION"),
		NetworkProfileFile: os.Getenv("GALAXY_NETWORK_PROFILE_FILE"), Keyring: keys.PublicKeyring(),
		SignManifest: keys.SignManifest, AssertManifestAvailable: keys.AssertManifestAvailable, KeyStatuses: keys.SigningKeyStatuses,
	})
}
