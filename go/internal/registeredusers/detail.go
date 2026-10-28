package registeredusers

import "context"

func (s *Service) Detail(ctx context.Context, a Actor, id string) (Object, error) {
	initial, e := s.current(ctx, a, "")
	if e != nil {
		return nil, e
	}
	row, e := s.targetWithin(ctx, s.Pool, id)
	if e != nil {
		return nil, e
	}
	u, state := s.native(ctx, row)
	permissions := permissionView(initial)
	evidence := Object{"state": "unavailable", "hasCredentials": nil, "hasFederatedIdentities": nil}
	stage := Object{"state": "unknown", "basis": "insufficient-native-evidence"}
	issuer, subject := str(row["issuer"]), str(row["external_subject"])
	if u != nil && permissions["canReadIdentity"] == true {
		if facts, e := s.Directory.RegistrationEvidence(ctx, issuer, subject); e == nil {
			evidence = Object{"state": "available", "hasCredentials": facts["hasCredentials"], "hasFederatedIdentities": facts["hasFederatedIdentities"]}
			pending := u.Enabled && u.Email != nil && *u.Email != "" && u.Local && !u.Federated && !u.ServiceAccount && has(u.RequiredActions, "UPDATE_PASSWORD") && facts["hasCredentials"] == false && facts["hasFederatedIdentities"] == false
			completed := facts["hasCredentials"] == true || facts["hasFederatedIdentities"] == true || u.Federated
			if pending || completed {
				stage["basis"] = "current-native-credential-and-federation-metadata"
				if pending {
					stage["state"] = "completion-required"
				} else {
					stage["state"] = "registered"
				}
			}
		}
	}
	management := Object{"state": "not-configured"}
	if s.Directory != nil {
		management["state"] = "unavailable"
	}
	if u != nil && s.Directory != nil {
		if v, e := s.Directory.Management(ctx, issuer, subject); e == nil {
			management = v
		}
	}
	sessions := Object{"sso": Object{"state": "unavailable", "activeCount": nil, "scope": "keycloak-user-sso"}, "website": Object{"state": "unavailable", "activeCount": nil, "scope": "website-portal"}}
	if u != nil && permissions["canReadIdentity"] == true {
		if v, e := s.Directory.SessionSummary(ctx, issuer, subject); e == nil {
			sessions["sso"] = v
		}
		if s.Portal != nil {
			if v, e := s.Portal.Summary(ctx, issuer, subject); e == nil && whole(v["activeCount"], 0, 9007199254740991) {
				sessions["website"] = Object{"state": "available", "activeCount": v["activeCount"], "scope": "website-portal"}
			}
		}
	}
	actor, e := s.current(ctx, initial, "")
	if e != nil {
		return nil, e
	}
	permissions = permissionView(actor)
	if permissions["canReadIdentity"] != true {
		evidence = Object{"state": "unavailable", "hasCredentials": nil, "hasFederatedIdentities": nil}
		stage = Object{"state": "unknown", "basis": "not-authorized"}
		for _, k := range []string{"sso", "website"} {
			obj(sessions[k])["state"] = "unavailable"
			obj(sessions[k])["activeCount"] = nil
		}
	}
	caps := Object{"canResetPassword": has(actor.Permissions, "accounts.password.reset") && permissions["canReadIdentity"] == true && u != nil && u.Enabled && u.Email != nil && *u.Email != "" && u.EmailVerified && management["state"] == "available", "canDisableLogin": has(actor.Permissions, "accounts.login.disable") && u != nil && u.Enabled && management["state"] == "available", "canRestoreLogin": has(actor.Permissions, "accounts.login.restore") && u != nil && !u.Enabled && management["state"] == "available", "canRevokeSessions": has(actor.Permissions, "accounts.sessions.revoke") && u != nil && management["state"] == "available" && s.Portal != nil, "canCorrectProfile": has(actor.Permissions, "accounts.profile.correct") && row["profile_account_id"] != nil, "canPresetProfile": has(actor.Permissions, "accounts.profile.correct") && permissions["canReadProfile"] == true && u != nil && row["account_id"] == nil}
	masked := cloneObject(row)
	masked["present"] = state == "available"
	for _, k := range []string{"email", "email_verified", "enabled", "registered_at", "identity_display_name"} {
		masked[k] = nil
	}
	item := s.item(masked, u, permissions["canReadIdentity"] == true, stage)
	presence := state
	if state == "available" {
		presence = "present"
	}
	obj(item["identity"])["presence"] = presence
	history, e := s.History(ctx, a, id, Object{})
	if e != nil {
		return nil, e
	}
	final, e := s.current(ctx, actor, "")
	if e != nil {
		return nil, e
	}
	finalPermissions := permissionView(final)
	if permissions["canReadIdentity"] == true && finalPermissions["canReadIdentity"] != true || permissions["canReadProfile"] == true && finalPermissions["canReadProfile"] != true {
		return nil, fail("operations_permission_denied", 403)
	}
	var businessRef any
	if row["account_id"] != nil {
		businessRef = Object{"accountId": row["account_id"], "href": "/admin/operations/users?account=" + str(row["account_id"])}
	}
	profile := Object{"state": "not-authorized", "avatarKey": nil, "bio": nil}
	if permissions["canReadProfile"] == true {
		if row["profile_account_id"] != nil {
			profile = Object{"state": "available", "source": "business-profile", "avatarKey": row["avatar_key"], "bio": valueDefault(row["bio"], "")}
		} else if row["account_id"] == nil {
			profile = Object{"state": "available", "source": "registration-preset", "avatarKey": row["preset_avatar_key"], "bio": valueDefault(row["preset_bio"], "")}
		} else {
			profile["state"] = "not-formed"
		}
	}
	version, e := TargetVersion(row, u)
	if e != nil {
		return nil, e
	}
	return s.stamp(Object{"item": item, "businessRef": businessRef, "targetVersion": version, "versionBasis": "observed-current-source", "permissions": permissions, "capabilities": caps, "websiteProfile": profile, "security": Object{"identityManagement": management["state"], "registrationEvidence": evidence, "sessions": sessions}, "history": Object{"items": history["items"], "nextAfter": history["nextAfter"]}}), nil
}
