package native

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

// managedPrepareIdentity preserves an existing owner and creates one only for
// a new store. It never binds a remote account or changes an existing identity.
func managedPrepareIdentity(ctx context.Context, input ManagedNativeInstallationInput) (map[string]any, error) {
	store, err := NewStore(input.DataDirectory, input.Endpoint)
	if err != nil {
		return nil, err
	}
	if input.KeepIdentity {
		owner, err := store.Owner(ctx)
		if err != nil {
			return nil, err
		}
		if owner == "" {
			return nil, fault.New("native_update_identity_missing", 409)
		}
		return map[string]any{"created": false, "existingIdentityPreserved": true}, nil
	}
	scope, err := store.ChoiceScope(ctx)
	if err != nil {
		return nil, err
	}
	if input.Host == "opencode" {
		return installationPrepareLocal(ctx, store, input.SubjectType, &scope)
	}
	owner := ""
	err = store.With(ctx, false, func(dir string) error {
		if e := store.verifyChoiceWithin(dir, &scope); e != nil {
			return e
		}
		var e error
		owner, e = store.ownerWithin(dir, "")
		return e
	})
	if err != nil {
		return nil, err
	}
	if owner != "" {
		return map[string]any{"created": false, "existingIdentityPreserved": true}, nil
	}
	created, err := store.Initialize(ctx, InitializationInput{InitializationPath: "personal-galaxy", SubjectType: input.SubjectType}, true, &scope)
	if err != nil {
		return nil, err
	}
	return map[string]any{"created": text(created["identity"]) != "", "existingIdentityPreserved": false}, nil
}

// Ensure the chosen persistent data is never placed inside immutable releases.
func managedDataOutsideInstall(data, root string) bool {
	return !installationPathInside(data, root) && !installationPathInside(root, data)
}
