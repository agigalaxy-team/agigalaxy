package native

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

const hostDeletionFile = "galaxy-deletion-records.json"

var hostDeletionGUID = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var hostDeletionHash = regexp.MustCompile(`^[a-f0-9]{64}$`)
var hostDeletionUUID = regexp.MustCompile(`(?i)^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)

func hostDeletionKeys(row map[string]any, keys ...string) bool {
	if row == nil {
		return false
	}
	allowed := map[string]bool{}
	for _, key := range keys {
		allowed[key] = true
	}
	for key := range row {
		if !allowed[key] {
			return false
		}
	}
	return true
}
func hostDeletionInteger(value any) bool {
	switch v := value.(type) {
	case json.Number:
		return connectionSafeInteger(v)
	case int:
		return v >= 0 && int64(v) <= 9007199254740991
	case int64:
		return v >= 0 && v <= 9007199254740991
	}
	return false
}

func hostDeletionError() error { return connectionFailure("local_deletion_record_invalid") }
func hostDeletionState(v any) bool {
	return isOne(text(v), "requested", "review-needed", "approved", "rejected", "cancelled", "partial", "primary-erased")
}
func hostDeletionRead(path string, max int64, missing bool) (map[string]any, error) {
	meta, e := os.Lstat(path)
	if errors.Is(e, os.ErrNotExist) && missing {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	if !meta.Mode().IsRegular() || meta.Mode()&os.ModeSymlink != 0 || meta.Size() > max {
		return nil, hostDeletionError()
	}
	raw, e := os.ReadFile(path)
	if e != nil {
		return nil, e
	}
	if int64(len(raw)) > max {
		return nil, hostDeletionError()
	}
	var out map[string]any
	if protocol.Decode(raw, &out) != nil || out == nil {
		return nil, hostDeletionError()
	}
	return out, nil
}
func hostDeletionIdentity(dir string) (string, error) {
	for _, name := range []string{".galaxy-initialization.json", ".galaxy-reset.json"} {
		if _, e := os.Lstat(filepath.Join(dir, name)); e == nil {
			return "", connectionFailure("local_recovery_required")
		} else if !errors.Is(e, os.ErrNotExist) {
			return "", e
		}
	}
	id, e := hostDeletionRead(filepath.Join(dir, "galaxy-id.json"), 16384, false)
	if e != nil {
		return "", e
	}
	if !connectionGenesis(text(id["id"]), uploadObject(id["genesisProof"])) {
		return "", hostDeletionError()
	}
	return text(id["id"]), nil
}
func hostDeletionRecord(row map[string]any) bool {
	if !hostDeletionKeys(row, "requestId", "subjectId", "endpoint", "recordedAt", "requestHash", "lastAction", "observedState", "observedAt") || !hostDeletionUUID.MatchString(text(row["requestId"])) || !hostDeletionGUID.MatchString(text(row["subjectId"])) || !nativeAccountURL(row["endpoint"]) || len([]rune(text(row["endpoint"]))) > 2048 || !hostDeletionInteger(row["recordedAt"]) {
		return false
	}
	if v, ok := row["requestHash"]; ok && !hostDeletionHash.MatchString(text(v)) {
		return false
	}
	if v, ok := row["lastAction"]; ok && !isOne(text(v), "request", "cancel") {
		return false
	}
	if v, ok := row["observedState"]; ok && !hostDeletionState(v) {
		return false
	}
	if v, ok := row["observedAt"]; ok && !hostDeletionInteger(v) {
		return false
	}
	return true
}
func hostDeletionArchive(dir string) (map[string]any, error) {
	value, e := hostDeletionRead(filepath.Join(dir, hostDeletionFile), 524288, true)
	if e != nil {
		return nil, e
	}
	if value == nil {
		return map[string]any{"version": 1, "records": []any{}}, nil
	}
	rows, ok := value["records"].([]any)
	if !connectionExact(value, "version", "records") || !hostDeletionInteger(value["version"]) || integer(value["version"]) != 1 || !ok || len(rows) > 128 {
		return nil, hostDeletionError()
	}
	for _, row := range rows {
		if !hostDeletionRecord(uploadObject(row)) {
			return nil, hostDeletionError()
		}
	}
	return value, nil
}
func hostDeletionIntent(row map[string]any) bool {
	keys := []string{"version", "id", "endpoint", "subjectId", "bindingId", "issuedAt", "expiresAt", "action"}
	switch row["action"] {
	case "request":
		keys = append(keys, "scope", "reason", "takeout", "exportManifestSha256")
		if row["scope"] != "all-owned-service-data" || !isOne(text(row["reason"]), "account-exit", "privacy", "other") || !isOne(text(row["takeout"]), "already-exported", "not-needed") {
			return false
		}
		if v, ok := row["exportManifestSha256"]; ok && (!hostDeletionHash.MatchString(text(v)) || row["takeout"] != "already-exported") {
			return false
		}
	case "cancel":
		keys = append(keys, "requestId", "expectedRevision")
		if !hostDeletionUUID.MatchString(text(row["requestId"])) || !hostDeletionInteger(row["expectedRevision"]) || integer(row["expectedRevision"]) < 1 {
			return false
		}
	default:
		return false
	}
	return hostDeletionKeys(row, keys...) && hostDeletionInteger(row["version"]) && integer(row["version"]) == 1 && hostDeletionUUID.MatchString(text(row["id"])) && nativeAccountURL(row["endpoint"]) && hostDeletionGUID.MatchString(text(row["subjectId"])) && hostDeletionUUID.MatchString(text(row["bindingId"])) && hostDeletionInteger(row["issuedAt"]) && hostDeletionInteger(row["expiresAt"]) && integer(row["expiresAt"]) > integer(row["issuedAt"]) && integer(row["expiresAt"])-integer(row["issuedAt"]) <= 300
}

// These inherited-stdio methods preserve local locators only. Endpoint is a
// label for the original controller, not network authority or an adopted actor.
func (s *Store) hostDeletionCall(ctx context.Context, method string, params json.RawMessage) (any, error) {
	x, e := hostDecode[struct {
		Endpoint string         `json:"endpoint"`
		Preview  map[string]any `json:"preview,omitempty"`
		Result   map[string]any `json:"result,omitempty"`
	}](params)
	if e != nil {
		return nil, e
	}
	var exact map[string]any
	if protocol.Decode(params, &exact) != nil {
		return nil, hostDeletionError()
	}
	keys := []string{"endpoint"}
	input := map[string]any{}
	expected := ""
	switch method {
	case "local.deletion.list":
	case "local.deletion.rememberPreview":
		keys = append(keys, "preview")
		payload, ok := x.Preview["payloadJson"].(string)
		var intent map[string]any
		if !ok || protocol.Decode([]byte(payload), &intent) != nil || !hostDeletionIntent(intent) || intent["endpoint"] != x.Endpoint || x.Preview["endpoint"] != x.Endpoint {
			return nil, hostDeletionError()
		}
		id := intent["id"]
		if intent["action"] == "cancel" {
			id = intent["requestId"]
		}
		if x.Preview["requestId"] != id {
			return nil, hostDeletionError()
		}
		input["requestId"], input["lastAction"] = id, intent["action"]
		if intent["action"] == "request" {
			hash := sha256.Sum256([]byte(payload))
			input["requestHash"] = hex.EncodeToString(hash[:])
		}
		expected = text(intent["subjectId"])
	case "local.deletion.observe":
		keys = append(keys, "result")
		if v, ok := x.Result["endpoint"]; ok && v != x.Endpoint {
			return nil, hostDeletionError()
		}
		if !hostDeletionState(x.Result["state"]) {
			return nil, hostDeletionError()
		}
		id := x.Result["id"]
		if id == nil {
			id = x.Result["requestId"]
		}
		input["requestId"], input["observedState"], input["observedAt"] = id, x.Result["state"], time.Now().Unix()
		if v, ok := x.Result["subjectId"]; ok {
			expected = text(v)
			if v != nil && expected == "" {
				return nil, hostDeletionError()
			}
		}
	default:
		return nil, hostDeletionError()
	}
	if !connectionExact(exact, keys...) {
		return nil, hostDeletionError()
	}
	var out any
	e = s.With(ctx, method != "local.deletion.list", func(dir string) error {
		if e := ctx.Err(); e != nil {
			return e
		}
		subject, e := hostDeletionIdentity(dir)
		if e != nil {
			return e
		}
		if expected != "" && expected != subject {
			return connectionFailure("local_deletion_identity_changed")
		}
		archive, e := hostDeletionArchive(dir)
		if e != nil {
			return e
		}
		rows := archive["records"].([]any)
		if method == "local.deletion.list" {
			filtered := []any{}
			for _, raw := range rows {
				r := uploadObject(raw)
				if r["endpoint"] == x.Endpoint && r["subjectId"] == subject {
					filtered = append(filtered, r)
				}
			}
			sort.SliceStable(filtered, func(i, j int) bool {
				return integer(uploadObject(filtered[i])["recordedAt"]) > integer(uploadObject(filtered[j])["recordedAt"])
			})
			out = map[string]any{"source": "local-history", "currentStateVerified": false, "records": filtered}
		} else {
			row := map[string]any{"requestId": input["requestId"], "subjectId": subject, "endpoint": x.Endpoint, "recordedAt": time.Now().Unix()}
			index := -1
			for i, raw := range rows {
				prior := uploadObject(raw)
				if prior["requestId"] == input["requestId"] && prior["endpoint"] == x.Endpoint && prior["subjectId"] == subject {
					index = i
					for k, v := range prior {
						row[k] = v
					}
					break
				}
			}
			if row["requestHash"] != nil && input["requestHash"] != nil && row["requestHash"] != input["requestHash"] {
				return connectionFailure("local_deletion_request_changed")
			}
			for k, v := range input {
				row[k] = v
			}
			if !hostDeletionRecord(row) {
				return hostDeletionError()
			}
			if index < 0 {
				if len(rows) >= 128 {
					return connectionFailure("local_deletion_archive_full")
				}
				rows = append(rows, row)
			} else {
				rows[index] = row
			}
			archive["records"] = rows
			if e := ctx.Err(); e != nil {
				return e
			}
			current, e := hostDeletionIdentity(dir)
			if e != nil {
				return e
			}
			if current != subject {
				return connectionFailure("local_deletion_identity_changed")
			}
			if e = writeJSON(filepath.Join(dir, hostDeletionFile), archive); e != nil {
				return e
			}
			out = row
		}
		return ctx.Err()
	})
	return out, e
}
