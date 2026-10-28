package native

import (
	"bytes"
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/trustpackages"
	"os"
	"path/filepath"
)

func trustFileText(v any) string {
	if s, ok := v.(jstext.String); ok {
		return s.Decoded()
	}
	return text(v)
}
func trustOrderedContainer(container map[string]any) *protocol.OrderedObject {
	files := protocol.NewOrderedObject()
	source := psObject(container["files"])
	for _, key := range []string{"summary.md", "objects.json", "identity.json"} {
		files.Set(key, source[key])
	}
	out := protocol.NewOrderedObject()
	out.Set("format", container["format"])
	out.Set("files", files)
	out.Set("manifestJson", container["manifestJson"])
	out.Set("signature", container["signature"])
	return out
}
func trustOrderedBundle(bundle map[string]any) *protocol.OrderedObject {
	out := protocol.NewOrderedObject()
	for _, key := range []string{"format", "mediaType", "credential"} {
		out.Set(key, bundle[key])
	}
	out.Set("package", trustOrderedContainer(psObject(bundle["package"])))
	return out
}
func (h *NativeTrust) writeExport(ctx context.Context, l *nativeTrustLease, container, bundle map[string]any) (any, error) {
	verified, e := trustpackages.Verify(container, trustpackages.VerifyOptions{Now: h.now()})
	if e != nil {
		return nil, e
	}
	id := text(verified["packageId"])
	if bundle != nil {
		manifest, e := trustParseText(container["manifestJson"])
		if e != nil {
			return nil, e
		}
		document, e := trustParseText(psObject(container["files"])["identity.json"])
		if e != nil {
			return nil, e
		}
		control, e := trustpackages.VerifyPortableIdentity(document)
		if e != nil {
			return nil, e
		}
		public := ""
		for _, v := range trustArray(control["devices"]) {
			key := psObject(v)
			if key["keyId"] == manifest["keyId"] && psInt(key["epoch"]) == psInt(manifest["epoch"]) {
				public = text(key["publicKey"])
			}
		}
		if public == "" {
			return nil, connectionFailure("trust_vc_signer_mismatch")
		}
		issuer, e := trustpackages.SubjectURI(text(manifest["subjectId"]))
		if e != nil {
			return nil, e
		}
		options := trustpackages.VCVerifyOptions{Now: h.now(), TrustedIssuers: map[string]map[string]trustpackages.VCIssuerPin{issuer: {text(manifest["keyId"]): {PublicKeyPEM: public}}}}
		if audience := psObject(manifest["audience"]); audience["kind"] == "subjects" {
			subjects := trustArray(audience["subjectIds"])
			if len(subjects) > 0 {
				s := text(subjects[0])
				options.Audience = &s
			}
		}
		if _, e = trustpackages.VerifyVC(bundle, options); e != nil {
			return nil, e
		}
	}
	if e = l.check(ctx); e != nil {
		return nil, e
	}
	files := psObject(container["files"])
	names := []string{"summary.md", "objects.json", "identity.json", "manifest.json", "manifest.jws", "galaxy-trust-package.json"}
	contents := map[string]string{}
	for _, key := range names[:3] {
		contents[key] = trustFileText(files[key])
	}
	contents["manifest.json"] = text(container["manifestJson"])
	contents["manifest.jws"] = text(container["signature"])
	raw, e := protocol.EncodeJS(trustOrderedContainer(container))
	if e != nil {
		return nil, e
	}
	contents["galaxy-trust-package.json"] = string(raw)
	if bundle != nil {
		hash := identity.Digest([]byte(text(bundle["credential"])))
		a, b := "credential-"+hash+".vc.jwt", "galaxy-trust-vc-jose-"+hash+".json"
		names = append(names, a, b)
		contents[a] = text(bundle["credential"])
		raw, e = protocol.EncodeJS(trustOrderedBundle(bundle))
		if e != nil {
			return nil, e
		}
		contents[b] = string(raw)
	}
	var folder string
	paths := []any{}
	e = h.runtime.store.With(ctx, true, func(root string) error {
		// No nested Store lock: synchronous reference/generation checks are used
		// inside the original file transaction; full material checks surround it.
		if e := h.runtime.checkOperation(l.generation); e != nil {
			return e
		}
		if e := h.runtime.store.verifyChoiceWithin(root, &l.scope); e != nil {
			return e
		}
		directory := func(path string) error {
			if e := os.Mkdir(path, 0700); e != nil && !errors.Is(e, os.ErrExist) {
				return e
			}
			stat, e := os.Lstat(path)
			if e != nil {
				return e
			}
			resolved, e := filepath.EvalSymlinks(path)
			if e != nil {
				return e
			}
			if !stat.IsDir() || stat.Mode()&os.ModeSymlink != 0 || filepath.Clean(resolved) != filepath.Clean(path) {
				return connectionFailure("trust_export_directory_changed")
			}
			return nil
		}
		parent := filepath.Join(root, "trust-packages")
		if e := directory(parent); e != nil {
			return e
		}
		folder = filepath.Join(parent, id)
		if e := directory(folder); e != nil {
			return e
		}
		for _, name := range names {
			if e := h.runtime.checkOperation(l.generation); e != nil {
				return e
			}
			path := filepath.Join(folder, name)
			data := []byte(contents[name])
			f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
			if errors.Is(e, os.ErrExist) {
				stat, e := os.Lstat(path)
				if e != nil {
					return e
				}
				limit := int64(4500000)
				if bundle != nil && (name == names[len(names)-1] || name == names[len(names)-2]) {
					limit = 6500000
				}
				if !stat.Mode().IsRegular() || stat.Mode()&os.ModeSymlink != 0 || stat.Size() > limit {
					return connectionFailure("trust_export_existing_file_conflict")
				}
				existing, e := os.ReadFile(path)
				if e != nil {
					return e
				}
				if !bytes.Equal(existing, data) {
					return connectionFailure("trust_export_existing_file_conflict")
				}
			} else if e != nil {
				return e
			} else {
				_, e = f.Write(data)
				closeErr := f.Close()
				if e != nil {
					return e
				}
				if closeErr != nil {
					return closeErr
				}
			}
			paths = append(paths, path)
			if e := h.runtime.checkOperation(l.generation); e != nil {
				return e
			}
		}
		return h.runtime.store.verifyChoiceWithin(root, &l.scope)
	})
	if e != nil {
		return nil, e
	}
	if e = l.check(ctx); e != nil {
		return nil, e
	}
	out := map[string]any{"packageId": id, "directory": folder, "files": paths, "importedBusinessFacts": 0, "remotePublished": false, "privateKeyExported": false}
	if bundle != nil {
		out["profile"] = trustpackages.VCProfile
		out["mediaType"] = trustpackages.VCMediaType
		out["issuerAuthority"] = "self-issued-package-attestation"
		out["currentStatus"] = "unknown"
		out["capabilityVerified"] = false
	}
	return out, nil
}

func (h *NativeTrust) CheckOnline(ctx context.Context, container map[string]any, endpoint string, expected *ChoiceScope) (any, error) {
	l, e := h.capture(ctx)
	if e != nil {
		return nil, e
	}
	if expected == nil || *expected != l.scope {
		return nil, connectionFailure("trust_identity_changed")
	}
	offline, e := trustpackages.Verify(container, trustpackages.VerifyOptions{Now: h.now()})
	if e != nil {
		return nil, e
	}
	if endpoint != h.runtime.store.Endpoint {
		return nil, connectionFailure("trust_selected_endpoint_required")
	}
	if l.binding == nil {
		return nil, connectionFailure("trust_connection_required")
	}
	objects, e := trustParseText(psObject(container["files"])["objects.json"])
	if e != nil {
		return nil, e
	}
	items := []any{}
	for _, v := range trustArray(objects["sources"]) {
		source := psObject(v)
		ref := psObject(source["ref"])
		reason := ""
		permission := psObject(source["permission"])
		if ref["endpoint"] != endpoint {
			reason = "different-selected-service"
		} else if permission == nil {
			reason = "reference-only-no-online-source-access-granted"
		} else {
			valid := false
			key, _ := trustCanonical(ref)
			for _, v := range trustArray(offline["sources"]) {
				checked := psObject(v)
				other, _ := trustCanonical(checked["ref"])
				if key == other && psObject(checked["reproductionPermission"])["status"] == "signature-and-scope-valid" {
					valid = true
				}
			}
			if !valid {
				reason = "included-license-invalid-or-expired"
			}
		}
		item := map[string]any{"ref": source["ref"]}
		if reason != "" {
			item["status"] = "not-checked"
			item["reason"] = reason
		} else {
			_, grant, _, e := trustCompact(text(permission["signed"]))
			if e != nil {
				return nil, e
			}
			status, e := l.call(ctx, "/v2/trust-package/permissions/status", map[string]any{"id": grant["id"]}, false)
			if e != nil {
				if check := l.check(ctx); check != nil {
					return nil, check
				}
				item["status"] = "not-checked"
				item["reason"] = runtimeErrorCode(e)
			} else {
				for k, v := range status {
					item[k] = v
				}
			}
		}
		items = append(items, item)
	}
	control := map[string]any{"status": "not-checked", "reason": "different-selected-service"}
	document, e := trustParseText(psObject(container["files"])["identity.json"])
	if e != nil {
		return nil, e
	}
	if document["authority"] == endpoint {
		remote, e := l.call(ctx, "/v2/identity/"+text(offline["subjectId"])+"/control", nil, false)
		if e == nil {
			var current map[string]any
			current, e = trustpackages.VerifyPortableIdentity(remote)
			if e == nil {
				manifest, err := trustParseText(container["manifestJson"])
				if err != nil {
					return nil, err
				}
				same := psInt(current["epoch"]) == psInt(manifest["epoch"])
				found := false
				for _, v := range trustArray(current["devices"]) {
					if psObject(v)["keyId"] == manifest["keyId"] {
						found = true
					}
				}
				status := "control-changed"
				if same && found {
					status = "included-signer-current"
				}
				control = map[string]any{"status": status, "checkedAt": remote["checkedAt"]}
			}
		}
		if e != nil {
			if check := l.check(ctx); check != nil {
				return nil, check
			}
			control = map[string]any{"status": "not-checked", "reason": runtimeErrorCode(e)}
		}
	}
	if e = l.check(ctx); e != nil {
		return nil, e
	}
	return map[string]any{"offline": offline, "online": map[string]any{"selectedEndpoint": endpoint, "checkedAt": h.now(), "control": control, "items": items, "capabilityVerified": false}, "uploadedPackage": false}, nil
}
