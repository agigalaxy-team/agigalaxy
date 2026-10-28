package native

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	whatwg "github.com/nlnwa/whatwg-url/url"
)

func integrationProfileContract() map[string]any {
	var out map[string]any
	_ = protocol.Decode([]byte(integrationProfileContractsJSON), &out)
	return out
}
func (s *Store) integrationSnapshot(ctx context.Context) (map[string]any, error) {
	var snapshot map[string]any
	e := s.With(ctx, false, func(dir string) error { var e error; snapshot, e = integrationSnapshotWithin(dir); return e })
	return snapshot, e
}
func (s *Store) IntegrationReadStatus(ctx context.Context) (map[string]any, error) {
	snapshot, e := s.integrationSnapshot(ctx)
	if e != nil {
		return nil, e
	}
	out := integrationStatus(snapshot)
	out["catalog"] = InitializationCatalog()
	return out, nil
}
func (s *Store) IntegrationConnectionStatus(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	e := s.With(ctx, false, func(dir string) error {
		snapshot, e := integrationSnapshotWithin(dir)
		if e != nil {
			return e
		}
		var profile map[string]any
		exists, e := readJSON(filepath.Join(dir, "galaxy-connection-profile.json"), &profile)
		if e != nil {
			return e
		}
		integration := uploadObject(uploadObject(snapshot["state"])["integration"])
		if !exists || profile == nil {
			profile = uploadObject(integration["connectionProfile"])
		}
		contract := integrationProfileContract()
		out = identityClone(contract["empty"])
		out["appliedCapabilityProfile"] = integration["capabilityProfile"]
		out["enabledModuleIds"] = []any{}
		enabled := map[string]bool{}
		for _, v := range uploadRows(integration["modules"]) {
			enabled[text(uploadObject(v)["id"])] = true
		}
		for _, v := range uploadRows(out["includedModuleIds"]) {
			if enabled[text(v)] {
				out["enabledModuleIds"] = append(uploadRows(out["enabledModuleIds"]), v)
			}
		}
		if profile != nil {
			for _, v := range uploadRows(profile["targets"]) {
				target := uploadObject(v)
				target["id"] = integrationTrim(target["id"])
			}
			for _, v := range uploadRows(profile["scopes"]) {
				scope := uploadObject(v)
				for _, key := range []string{"id", "targetId", "recipient", "purpose"} {
					scope[key] = integrationTrim(scope[key])
				}
				for i, x := range uploadRows(scope["visibleFields"]) {
					uploadRows(scope["visibleFields"])[i] = integrationTrim(x)
				}
			}
			for _, v := range uploadRows(profile["audit"]) {
				row := uploadObject(v)
				if value, ok := row["scopeId"]; ok {
					row["scopeId"] = integrationTrim(value)
				}
			}
			schema := uploadObject(contract["schema"])
			remoteDefaults(schema, profile)
			for _, v := range uploadRows(profile["scopes"]) {
				remoteDefaults(uploadObject(uploadObject(schema["properties"])["scopes"])["items"].(map[string]any), uploadObject(v))
			}
			if remoteChatValidate(schema, profile) != nil {
				return connectionFailure("local_connection_profile_invalid")
			}
			targets := map[string]bool{}
			official := 0
			for _, v := range uploadRows(profile["targets"]) {
				target := uploadObject(v)
				id := text(target["id"])
				if targets[id] {
					return connectionFailure("local_connection_profile_invalid")
				}
				targets[id] = true
				if target["kind"] == "official" {
					official++
				}
				u, e := whatwg.Parse(text(target["endpoint"]))
				if e != nil || u.Scheme() != "https" || u.Host() == "" || u.Username() != "" || u.Password() != "" || u.Search() != "" || u.Hash() != "" {
					return connectionFailure("local_connection_profile_invalid")
				}
			}
			if official > 1 {
				return connectionFailure("local_connection_profile_invalid")
			}
			scopes := map[string]bool{}
			for _, v := range uploadRows(profile["scopes"]) {
				scope := uploadObject(v)
				id := text(scope["id"])
				if scopes[id] || !targets[text(scope["targetId"])] {
					return connectionFailure("local_connection_profile_invalid")
				}
				scopes[id] = true
			}
			out["selectionState"] = "local-intent-saved"
			out["audit"] = profile["audit"]
			out["targets"] = []any{}
			for _, v := range uploadRows(profile["targets"]) {
				row := identityClone(v)
				row["state"] = "configured-unverified"
				row["manifest"] = map[string]any{"state": "not-fetched"}
				row["binding"] = map[string]any{"state": "not-bound"}
				out["targets"] = append(uploadRows(out["targets"]), row)
			}
			if len(uploadRows(out["targets"])) > 0 {
				out["message"] = "已保存本地端点配置；未验证、未连接。"
			}
			out["scopes"] = []any{}
			for _, v := range uploadRows(profile["scopes"]) {
				row := identityClone(v)
				row["state"] = "proposed"
				if row["revokedAt"] != nil && row["revokedAt"] != "" {
					row["state"] = "revoked"
				} else if integrationExpired(row["expiresAt"]) {
					row["state"] = "expired"
				}
				row["authorized"] = false
				out["scopes"] = append(uploadRows(out["scopes"]), row)
			}
		}
		if snapshot["recoveryRequired"] == true {
			out["state"] = "recovery-required"
			out["recoveryRequired"] = true
		}
		return nil
	})
	return out, e
}
func integrationDescribe(identity map[string]any) map[string]any {
	id := text(identity["id"])
	if !connectionSubject.MatchString(id) {
		return map[string]any{"format": "legacy", "note": "This existing local Galaxy ID predates GUID-32 v1 and is preserved without silent rewriting."}
	}
	alphabet := "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	var milliseconds int64
	for _, c := range id[6:16] {
		milliseconds = (milliseconds << 5) + int64(strings.IndexRune(alphabet, c))
	}
	at := time.UnixMilli(milliseconds).UTC()
	iso := at.Format("2006-01-02T15:04:05.000Z")
	if at.Year() > 9999 {
		iso = fmt.Sprintf("+%06d-%02d-%02dT%02d:%02d:%02d.%03dZ", at.Year(), at.Month(), at.Day(), at.Hour(), at.Minute(), at.Second(), at.Nanosecond()/1000000)
	}
	return map[string]any{"id": id, "format": "guid-32-v1", "version": id[4:5], "originCode": id[5:6], "origin": uploadObject(integrationProfileContract()["origins"])[id[5:6]], "issuedAtMs": milliseconds, "issuedAt": iso, "genesisCommitment": id[16:], "fieldLimits": []string{"The origin is only an immutable issuance context, not a trust or Hub claim.", "The timestamp is creation metadata, not activity or verification time.", "The Genesis Commitment is opaque and must not be decoded as personal data or a capability claim."}}
}
func integrationOfficialWebsite() (map[string]any, string) {
	raw := uploadTrim(os.Getenv("GALAXY_OFFICIAL_SITE_URL"))
	configured := false
	selected := ""
	if raw != "" {
		if u, e := whatwg.Parse(raw); e == nil && u.Scheme() == "https" && u.Host() != "" && u.Username() == "" && u.Password() == "" {
			configured = true
			selected = u.String()
		}
	}
	var address, reason any
	if configured {
		address = selected
	} else {
		reason = "GALAXY_OFFICIAL_SITE_URL is not configured as a valid HTTPS URL. A local preview is never presented as the official website."
	}
	platform := runtime.GOOS
	if platform == "windows" {
		platform = "win32"
	}
	return map[string]any{"platform": platform, "supported": runtime.GOOS == "windows", "configured": configured, "url": address, "reason": reason}, selected
}
func integrationOpenWebsite(ctx context.Context) (map[string]any, error) {
	out, target := integrationOfficialWebsite()
	out["opened"] = false
	if out["supported"] != true {
		out["state"] = "unsupported-platform"
		return out, nil
	}
	if out["configured"] != true {
		out["state"] = "website-not-configured"
		return out, nil
	}
	_, e := navigationPlatformOpen(ctx, target)
	if e != nil {
		return nil, e
	}
	out["state"] = "opened"
	out["opened"] = true
	return out, nil
}
