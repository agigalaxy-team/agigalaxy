package access

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"net/url"
	"strings"
)

// FindByEmail is the original bounded, exact native directory query. It reuses
// this already-loaded reader and its token handling; it never scans a realm.
func (d *KeycloakDirectory) FindByEmail(ctx context.Context, email string) ([]DirectoryIdentity, error) {
	if _, ok := directoryEmail(email); !ok {
		return nil, fault.New("invalid_operations_email", 400)
	}
	if d == nil {
		return nil, fault.New("identity_directory_unavailable", 503)
	}
	query := url.Values{"email": {email}, "exact": {"true"}, "max": {"100"}}
	var raw any
	if e := d.read(ctx, "users?"+query.Encode(), false, &raw); e != nil {
		return nil, e
	}
	users, ok := raw.([]any)
	if !ok {
		return nil, fault.New("identity_directory_unavailable", 503)
	}
	out := []DirectoryIdentity{}
	for _, entry := range users {
		user, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		subject, _ := user["id"].(string)
		address, valid := directoryEmail(user["email"])
		if !subjectPattern.MatchString(subject) || !valid || strings.ToLower(address) != strings.ToLower(email) {
			continue
		}
		out = append(out, DirectoryIdentity{Issuer: d.issuer, ExternalSubject: subject, State: "available", Email: address, Enabled: user["enabled"] == true, EmailVerified: user["emailVerified"] == true})
	}
	return out, nil
}
