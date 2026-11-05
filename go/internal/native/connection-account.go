package native

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
)

const officialNativeAuthority = "https://official.agigalaxy.org"

// Match the same HTTPS origin without changing the configured bytes used by
// signatures, account validation, storage keys or requests.
func isOfficialNativeAuthority(endpoint string) bool {
	u, err := url.Parse(endpoint)
	return err == nil && strings.EqualFold(u.Scheme, "https") && strings.EqualFold(u.Hostname(), "official.agigalaxy.org") && (u.Port() == "" || u.Port() == "443") && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == "" && !u.ForceQuery
}

type nativeAccountConnect struct {
	runtime  *Runtime
	accounts *NativeIdentityAccounts
	mu       sync.Mutex
	pending  map[ChoiceScope]*nativeAccountLogin
}

type nativeAccountLogin struct {
	id, secret, loginURL string
	until                time.Time
}

// accountStatus reflects the verified server association for this connected identity.
// A failed lookup cannot establish that an association is absent.
func (r *Runtime) officialAccountStatus(ctx context.Context) map[string]any {
	accounts := NewNativeIdentityAccounts(r)
	after := ""
	seen := map[string]bool{}
	for {
		value, err := accounts.Read(ctx, NativeIdentityAccountRead{Action: "query", After: after, Limit: 100})
		if err != nil {
			return map[string]any{"state": "unavailable"}
		}
		page := uploadObject(value)
		for _, item := range uploadRows(page["items"]) {
			if uploadObject(item)["state"] == "linked" {
				return map[string]any{"state": "linked"}
			}
		}
		next := text(page["nextAfter"])
		if next == "" {
			return map[string]any{"state": "unlinked"}
		}
		if seen[next] {
			return map[string]any{"state": "unavailable"}
		}
		seen[next] = true
		after = next
	}
}

func (c *nativeAccountConnect) login(ctx context.Context, scope ChoiceScope) (*nativeAccountLogin, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.runtime.connection.now()
	for key, item := range c.pending {
		if !item.until.After(now) {
			delete(c.pending, key)
		}
	}
	if item := c.pending[scope]; item != nil {
		return item, nil
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	secret := hex.EncodeToString(raw)
	out, err := c.runtime.Call(ctx, "/v1/identity/native-begin", map[string]any{"subjectId": scope.Owner, "proof": identity.Digest([]byte(secret))}, ConnectionCallOptions{Unauthenticated: true, ExpectedScope: &scope})
	if err != nil {
		return nil, err
	}
	target, parseErr := url.Parse(text(out["authorizationUrl"]))
	issuer, issuerErr := url.Parse(text(out["issuer"]))
	expires := time.Unix(integer(out["expiresAt"]), 0)
	secure := parseErr == nil && issuerErr == nil && target.Scheme == issuer.Scheme &&
		(target.Scheme == "https" || !isOfficialNativeAuthority(scope.Endpoint) && target.Scheme == "http" && target.Hostname() == "127.0.0.1")
	if !secure || target.Host == "" || target.Host != issuer.Host || target.User != nil || target.Fragment != "" ||
		!nativeAccountProvider(out, scope.Endpoint, true) || !controlUUID(out["loginId"]) || out["subjectId"] != scope.Owner || out["bindingId"] != "" || out["endpoint"] != scope.Endpoint || out["galaxyAuthorization"] != false ||
		!expires.After(now) || expires.After(now.Add(time.Duration(300+connectionClockSkewSeconds)*time.Second)) {
		return nil, connectionFailure("native_account_link_login_mismatch")
	}
	query := target.Query()
	if query.Get("redirect_uri") != out["redirectUri"] || query.Get("client_id") != out["clientId"] ||
		query.Get("response_type") != "code" || query.Get("code_challenge_method") != "S256" || query.Get("state") == "" || query.Get("nonce") == "" {
		return nil, connectionFailure("native_account_link_login_mismatch")
	}
	item := &nativeAccountLogin{text(out["loginId"]), secret, target.String(), expires}
	c.pending[scope] = item
	return item, nil
}

func (item *nativeAccountLogin) input() map[string]any {
	return map[string]any{"id": item.id, "secret": item.secret}
}

func (c *nativeAccountConnect) approved(ctx context.Context, scope ChoiceScope, login *nativeAccountLogin) (bool, error) {
	result, err := c.runtime.Call(ctx, "/v1/identity/native-status", login.input(), ConnectionCallOptions{Unauthenticated: true, ExpectedScope: &scope})
	if err != nil {
		return false, err
	}
	if result["id"] != login.id || result["subjectId"] != scope.Owner {
		return false, connectionFailure("native_account_link_status_mismatch")
	}
	switch result["state"] {
	case "awaiting-login", "exchanging", "awaiting-native-approval":
		return false, nil
	case "native-approved", "awaiting-local-signature":
		return true, nil
	}
	return false, connectionFailure("native_account_login_required")
}

func (c *nativeAccountConnect) review(ctx context.Context, b *BrowserChoices, plan ConnectionSettingsPlan) (any, error) {
	scope, err := c.runtime.store.ChoiceScope(ctx)
	if err != nil {
		return nil, err
	}
	if scope.Owner != plan.GalaxyID || scope.DeviceID != plan.DeviceID || scope.Revision != plan.Revision || scope.Endpoint != plan.Endpoint {
		return nil, connectionFailure("native_connection_selection_changed")
	}
	login, err := c.login(ctx, scope)
	if err != nil {
		return nil, err
	}
	input := BrowserChoiceInput{Name: "galaxy_native_account_connect", Scope: scope,
		Input:    map[string]any{"galaxyId": scope.Owner, "loginId": login.id, "expiresAt": login.until.Unix()},
		Message:  "请在银河官网登录并确认账户与本机 ID。确认后，此页面会显示接入结果。",
		LoginURL: login.loginURL,
		FirstUseSelectionDigest: func() string {
			if plan.FirstUse {
				return plan.SelectionDigest
			}
			return ""
		}(),
		ExternalApproval: func(ctx context.Context) (bool, error) { return c.approved(ctx, scope, login) },
	}
	return b.Review(ctx, input, func(ctx context.Context, selected *ChoiceScope) (any, error) {
		if selected == nil || *selected != scope {
			return nil, connectionFailure("native_connection_selection_changed")
		}
		var err error
		if _, err = c.runtime.ConnectReviewed(ctx, plan, selected); err != nil {
			return nil, err
		}
		newScope, err := c.runtime.store.ChoiceScope(ctx)
		if err != nil {
			return nil, err
		}
		if newScope.Owner != scope.Owner || newScope.Endpoint != scope.Endpoint {
			return nil, connectionFailure("native_connection_selection_changed")
		}
		claimed, err := c.runtime.Call(ctx, "/v1/identity/native-claim", login.input(), ConnectionCallOptions{ExpectedScope: &newScope})
		if err != nil {
			return nil, err
		}
		if claimed["id"] != login.id {
			return nil, connectionFailure("native_account_link_status_mismatch")
		}
		if claimed["alreadyLinked"] == true {
			return map[string]any{"state": "linked", "subjectId": newScope.Owner}, nil
		}
		preview, err := c.accounts.Prepare(ctx, "link", login.id)
		if err != nil {
			return nil, err
		}
		out, err := c.accounts.ExecuteReviewed(ctx, text(uploadObject(preview)["previewId"]), &newScope)
		if err == nil && uploadObject(out)["state"] != "linked" {
			return map[string]any{"state": "unknown", "id": login.id, "originalOperationRetained": true}, nil
		}
		return out, err
	})
}
