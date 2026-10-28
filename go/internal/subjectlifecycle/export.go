package subjectlifecycle

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type CreateInput struct {
	ID       string   `json:"id"`
	Datasets []string `json:"datasets"`
	Views    []View   `json:"views"`
}
type PageInput struct {
	ID      string `json:"id"`
	Dataset string `json:"dataset"`
	After   string `json:"after"`
	Limit   int    `json:"limit"`
}
type BinaryInput struct {
	ID       string `json:"id"`
	Dataset  string `json:"dataset"`
	RecordID string `json:"recordId"`
	Offset   int    `json:"offset"`
	Length   int    `json:"length"`
}

var exportCursor = regexp.MustCompile(`^[a-zA-Z0-9:._-]{0,200}$`)

func validID(id string) bool {
	v, e := uuid.Parse(id)
	return e == nil && strings.EqualFold(v.String(), id)
}
func invalidExport() error { return fault.New("invalid_export_request", 400) }
func (s *Service) Specification(ctx context.Context, a Actor) (any, error) {
	return s.run(ctx, a, "data-export", false, func(_ pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		kinds := []string{}
		for _, kind := range viewKinds {
			scope := catalog.ViewScopes[kind]
			if slices.Contains(auth.CredentialScopes, scope) {
				kinds = append(kinds, kind)
			}
		}
		var status any
		if s.ServiceStatus != nil {
			status = s.ServiceStatus()
		}
		return Object{"version": 1, "endpoint": s.Endpoint, "subjectId": a.SubjectID, "datasets": catalog.Datasets, "ownership": "own-submissions-and-selected-current-authorized-views", "viewKinds": kinds, "binaryDatasets": []string{"outcome-materials-v2"}, "binaryExportPolicy": "current-authorized-outcome-material-read; unavailable after revocation or expiry; chunked up to 524288 bytes", "maxSelectedViews": 32, "serviceStatus": status, "maxLifetimeSeconds": 600, "maxPageSize": 100, "serverStoresPayloadCopy": false, "excluded": []string{"authentication challenges and credentials", "service secrets", "other authors records without current read permission", "remote source files"}, "proofPolicy": "historical signed bytes; current public validity requires online recheck"}, nil
	})
}
func (s *Service) validateCreate(input *CreateInput) error {
	if !validID(input.ID) {
		return invalidExport()
	}
	if input.Datasets == nil {
		input.Datasets = append([]string{}, catalog.Datasets...)
	}
	if input.Views == nil {
		input.Views = []View{}
	}
	if len(input.Datasets) < 1 || len(input.Datasets) > len(catalog.Datasets)+1 || len(input.Views) > 32 {
		return invalidExport()
	}
	seen := map[string]bool{}
	for _, name := range input.Datasets {
		if seen[name] || name != "authorized-views" && !slices.Contains(catalog.Datasets, name) {
			return invalidExport()
		}
		seen[name] = true
	}
	if seen["authorized-views"] != (len(input.Views) > 0) {
		return invalidExport()
	}
	seen = map[string]bool{}
	for _, v := range input.Views {
		_, known := catalog.ViewScopes[v.Kind]
		if !known || !validID(v.ID) || v.VersionID != nil && (!validID(*v.VersionID) || v.Kind != "capsule" && v.Kind != "forum-post-version") || v.Kind == "forum-post-version" && v.VersionID == nil || v.Version != nil && (*v.Version < 1 || v.Kind != "evidence" && v.Kind != "verification") || v.TaskID != nil && (!validID(*v.TaskID) || v.Kind != "case") {
			return invalidExport()
		}
		raw, _ := encoded(v)
		if seen[string(raw)] {
			return invalidExport()
		}
		seen[string(raw)] = true
	}
	return nil
}
func (s *Service) sourceReady(name string) error {
	if name == "authorized-views" {
		return nil
	}
	src, ok := catalog.Sources[name]
	if !ok {
		return invalidExport()
	}
	if src.Transform && (name == "task-materials" || name == "forum-events" || name == "forum-governance-events") && s.Transforms[name] == nil {
		return unavailable()
	}
	if name == "outcome-materials-v2" && s.OutcomeMaterials == nil {
		return fault.New("export_binary_unavailable", 503)
	}
	return nil
}
func (s *Service) view(ctx context.Context, tx pgx.Tx, a Actor, v View, auth deviceauth.ControlAuthorization, kind string) (Object, error) {
	scope := catalog.ViewScopes[v.Kind]
	if !slices.Contains(auth.CredentialScopes, scope) || v.Kind == "case" && v.TaskID != nil && !slices.Contains(auth.CredentialScopes, "assistance") {
		return nil, fault.New("export_view_scope_required", 403)
	}
	reader := s.Views[v.Kind]
	if reader == nil && !(v.Kind == "context" && s.ContextView != nil) {
		return nil, unavailable()
	}
	var out any
	var e error
	if v.Kind == "context" && s.ContextView != nil {
		out, e = s.ContextView(ctx, tx, a, v, auth, kind)
	} else {
		out, e = reader(ctx, tx, a, v, kind)
	}
	if e != nil {
		switch fault.Status(e) {
		case 401, 403, 404, 409:
			return nil, fault.New("export_view_unavailable", 403)
		}
		return nil, e
	}
	return Object{"selection": v, "scope": scope, "checkedAt": s.now(), "authority": "current-read-access-only; no republishing or continuing authorization", "view": out}, nil
}
func exportDescribe(row Object, endpoint string) Object {
	views := []View{}
	_ = remarshal(row["views"], &views)
	ownership := "owner-copy"
	if len(views) > 0 {
		ownership = "mixed-authorized-copy"
	}
	return Object{"version": 1, "endpoint": endpoint, "id": row["id"], "subjectId": row["subject_id"], "datasets": row["datasets"], "bounds": row["bounds"], "selectionCutoff": row["selection_cutoff"], "expiresAt": stamp(row["expires_at"]).Unix(), "revoked": row["revoked_at"] != nil, "views": views, "ownership": ownership, "consistency": "bounded-live-pages; mutable status is re-read, not a database backup"}
}
func remarshal(v any, out any) error {
	raw, e := json.Marshal(v)
	if e != nil {
		return e
	}
	return json.Unmarshal(raw, out)
}
func (s *Service) ticket(ctx context.Context, tx pgx.Tx, a Actor, id string) (Object, error) {
	if e := s.download(); e != nil {
		return nil, e
	}
	row, e := one(ctx, tx, "SELECT * FROM data_exports WHERE id=$1 AND subject_id=$2 AND binding_id=$3 FOR SHARE", id, a.SubjectID, a.BindingID)
	if e != nil {
		return nil, notfound(e)
	}
	if row["revoked_at"] != nil || stamp(row["expires_at"]).Unix() <= s.now() {
		return nil, fault.New("export_expired", 410)
	}
	return row, nil
}
func (s *Service) Create(ctx context.Context, a Actor, input CreateInput) (any, error) {
	if e := s.validateCreate(&input); e != nil {
		return nil, e
	}
	if e := s.download(); e != nil {
		return nil, e
	}
	return s.run(ctx, a, "data-export", true, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", "data-export:"+a.BindingID); e != nil {
			return nil, e
		}
		var exists bool
		if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM data_exports WHERE id=$1)", input.ID).Scan(&exists); e != nil {
			return nil, e
		}
		if exists {
			row, e := s.ticket(ctx, tx, a, input.ID)
			if e != nil {
				return nil, e
			}
			var datasets []string
			var views []View
			_ = remarshal(row["datasets"], &datasets)
			_ = remarshal(row["views"], &views)
			left, _ := encoded(views)
			right, _ := encoded(input.Views)
			if !slices.Equal(datasets, input.Datasets) || string(left) != string(right) {
				return nil, fault.New("export_conflict", 409)
			}
			return exportDescribe(row, s.Endpoint), nil
		}
		for _, name := range input.Datasets {
			if e := s.sourceReady(name); e != nil {
				return nil, e
			}
		}
		var count int
		if e := tx.QueryRow(ctx, "SELECT count(*) FROM data_exports WHERE binding_id=$1 AND revoked_at IS NULL AND expires_at>$2", a.BindingID, time.Unix(s.now(), 0)).Scan(&count); e != nil {
			return nil, e
		}
		if count >= 3 {
			return nil, fault.New("export_limit", 429)
		}
		var cutoff time.Time
		if e := tx.QueryRow(ctx, "SELECT transaction_timestamp()").Scan(&cutoff); e != nil {
			return nil, e
		}
		cutoff = cutoff.UTC().Truncate(time.Millisecond)
		bounds := map[string]string{}
		for _, name := range input.Datasets {
			if name == "authorized-views" {
				for _, v := range input.Views {
					if _, e := s.view(ctx, tx, a, v, auth, "inspect"); e != nil {
						return nil, e
					}
				}
				bounds[name] = fmt.Sprintf("%08d", len(input.Views))
				continue
			}
			src := catalog.Sources[name]
			var last *string
			if e := tx.QueryRow(ctx, `SELECT max((`+src.Key+`) COLLATE "C") FROM `+src.From+` WHERE `+src.Owner+`=$1 AND `+src.Cutoff+`<=$2`, a.SubjectID, cutoff).Scan(&last); e != nil {
				return nil, e
			}
			if last != nil {
				bounds[name] = *last
			} else {
				bounds[name] = ""
			}
		}
		expiry := s.now() + 600
		if s.DownloadDeadline != nil {
			expiry = min(expiry, s.DownloadDeadline())
		}
		var bindingExpiry time.Time
		if e := tx.QueryRow(ctx, "SELECT expires_at FROM bindings WHERE id=$1", a.BindingID).Scan(&bindingExpiry); e != nil {
			return nil, e
		}
		expiry = min(expiry, bindingExpiry.Unix())
		datasets, _ := encoded(input.Datasets)
		boundRaw, _ := encoded(bounds)
		views, _ := encoded(input.Views)
		row, e := one(ctx, tx, `INSERT INTO data_exports(id,subject_id,binding_id,datasets,bounds,selection_cutoff,expires_at,views) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb) RETURNING *`, input.ID, a.SubjectID, a.BindingID, datasets, boundRaw, cutoff, time.Unix(expiry, 0), views)
		if e != nil {
			return nil, e
		}
		if e = audit(ctx, tx, a, auth, "data.export.create", input.ID, "data-export"); e != nil {
			return nil, e
		}
		return exportDescribe(row, s.Endpoint), nil
	})
}

type pageSnapshot struct {
	Version         int      `json:"version"`
	Endpoint        string   `json:"endpoint"`
	SubjectID       string   `json:"subjectId"`
	ExportID        string   `json:"exportId"`
	Dataset         string   `json:"dataset"`
	After           string   `json:"after"`
	Through         string   `json:"through"`
	ExpiresAt       int64    `json:"expiresAt"`
	SelectionCutoff any      `json:"selectionCutoff"`
	CheckedAt       int64    `json:"checkedAt"`
	Ownership       string   `json:"ownership"`
	Items           []Object `json:"items"`
	NextAfter       *string  `json:"nextAfter"`
	ProofValidity   string   `json:"proofValidity"`
}

func (s *Service) Page(ctx context.Context, a Actor, input PageInput) (any, error) {
	if input.Limit == 0 {
		input.Limit = 50
	}
	if !validID(input.ID) || input.Limit < 1 || input.Limit > 100 || !exportCursor.MatchString(input.After) || input.Dataset != "authorized-views" && !slices.Contains(catalog.Datasets, input.Dataset) {
		return nil, invalidExport()
	}
	return s.run(ctx, a, "data-export", false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		ticket, e := s.ticket(ctx, tx, a, input.ID)
		if e != nil {
			return nil, e
		}
		var datasets []string
		_ = remarshal(ticket["datasets"], &datasets)
		if !slices.Contains(datasets, input.Dataset) {
			return nil, fault.New("export_dataset_denied", 403)
		}
		var bounds map[string]string
		_ = remarshal(ticket["bounds"], &bounds)
		through := bounds[input.Dataset]
		if input.After > through {
			return nil, fault.New("invalid_export_cursor", 400)
		}
		projected := input.Dataset == "authorized-views"
		selected := []Object{}
		var views []View
		if projected {
			_ = remarshal(ticket["views"], &views)
			start := 0
			if input.After != "" {
				if len(input.After) != 8 || strings.IndexFunc(input.After, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
					return nil, fault.New("invalid_export_cursor", 400)
				}
				_, _ = fmt.Sscanf(input.After, "%d", &start)
			}
			if start > len(views) {
				return nil, fault.New("invalid_export_cursor", 400)
			}
			if start < len(views) {
				item, e := s.view(ctx, tx, a, views[start], auth, "export")
				if e != nil {
					return nil, e
				}
				item["export_cursor"] = fmt.Sprintf("%08d", start+1)
				selected = append(selected, item)
			}
		} else {
			if e := s.sourceReady(input.Dataset); e != nil {
				return nil, e
			}
			src := catalog.Sources[input.Dataset]
			reader := s.OwnerReaders[input.Dataset]
			if reader == nil && input.Dataset == "profile-statements" {
				reader = ProfileStatements
			}
			if reader == nil && (input.Dataset == "reading-bookmarks" || input.Dataset == "reading-bookmark-operations") {
				reader = ReadingBookmarks(input.Dataset)
			}
			if reader != nil {
				selected, e = reader(ctx, tx, a, input.After, through, stamp(ticket["selection_cutoff"]), input.Limit+1)
			} else {
				selected, e = rows(ctx, tx, `SELECT `+src.Key+` AS export_cursor,`+src.Fields+` FROM `+src.From+` WHERE `+src.Owner+`=$1 AND (`+src.Key+`) COLLATE "C">$2 AND (`+src.Key+`) COLLATE "C"<=$3 AND `+src.Cutoff+`<=$4 ORDER BY (`+src.Key+`) COLLATE "C" LIMIT $5`, a.SubjectID, input.After, through, stamp(ticket["selection_cutoff"]), input.Limit+1)
			}

			if e != nil {
				return nil, e
			}
		}
		items := []Object{}
		size := 0
		cursor := input.After
		for _, row := range selected[:min(len(selected), input.Limit)] {
			key := text(row["export_cursor"])
			delete(row, "export_cursor")
			item, e := s.transform(ctx, tx, a, input.Dataset, row)
			if e != nil {
				return nil, e
			}
			if input.Dataset == "outcome-materials-v2" && text(row["source_kind"]) == "attachment" {
				content, e := s.OutcomeMaterials(ctx, tx, a, text(row["id"]))
				if e != nil {
					return nil, e
				}
				if available, _ := content["contentAvailable"].(bool); available && text(content["bytesBase64"]) != "" {
					item["binaryContentAvailable"] = true
					item["contentBase64"] = content["bytesBase64"]
				} else {
					item["binaryContentAvailable"] = false
				}
			}
			raw, e := encoded(item)
			if e != nil {
				return nil, e
			}
			if len(raw) > 700000 {
				return nil, fault.New("export_record_too_large", 413)
			}
			if size+len(raw) > 700000 {
				break
			}
			size += len(raw)
			cursor = key
			items = append(items, item)
		}
		var next *string
		more := len(selected) > len(items)
		if projected {
			var n int
			_, _ = fmt.Sscanf(cursor, "%d", &n)
			more = n < len(views)
		}
		if more {
			next = &cursor
		}
		ownership := "owner-copy"
		if projected {
			ownership = "current-authorized-view"
		}
		snapshot := pageSnapshot{1, s.Endpoint, a.SubjectID, input.ID, input.Dataset, input.After, through, stamp(ticket["expires_at"]).Unix(), ticket["selection_cutoff"], s.now(), ownership, items, next, "historical-not-current-authorization"}
		raw, e := encoded(snapshot)
		if e != nil {
			return nil, e
		}
		hash := identity.Digest(raw)
		id := uuid.NewString()
		if _, e = tx.Exec(ctx, `INSERT INTO data_export_reads(id,export_id,subject_id,dataset,after_cursor,result_hash,result_count) VALUES($1,$2,$3,$4,$5,$6,$7)`, id, input.ID, a.SubjectID, input.Dataset, input.After, hash, len(items)); e != nil {
			return nil, e
		}
		if e = audit(ctx, tx, a, auth, "data.export.page", id, "data-export"); e != nil {
			return nil, e
		}
		return struct {
			pageSnapshot
			SHA256 string `json:"sha256"`
		}{snapshot, hash}, nil
	})
}
func (s *Service) Revoke(ctx context.Context, a Actor, id string) (any, error) {
	if !validID(id) {
		return nil, invalidExport()
	}
	return s.run(ctx, a, "data-export", false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		row, e := one(ctx, tx, "SELECT * FROM data_exports WHERE id=$1 AND subject_id=$2 FOR UPDATE", id, a.SubjectID)
		if e != nil {
			return nil, notfound(e)
		}
		if row["revoked_at"] == nil {
			if _, e = tx.Exec(ctx, "UPDATE data_exports SET revoked_at=$2 WHERE id=$1", id, time.Unix(s.now(), 0)); e != nil {
				return nil, e
			}
			if e = audit(ctx, tx, a, auth, "data.export.revoke", id, "data-export"); e != nil {
				return nil, e
			}
		}
		return Object{"id": id, "revoked": true}, nil
	})
}
func (s *Service) Binary(ctx context.Context, a Actor, input BinaryInput) (any, error) {
	if input.Length == 0 {
		input.Length = 524288
	}
	if !validID(input.ID) || !validID(input.RecordID) || input.Dataset != "outcome-materials-v2" || input.Offset < 0 || input.Length < 1 || input.Length > 524288 {
		return nil, invalidExport()
	}
	return s.run(ctx, a, "data-export", false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		ticket, e := s.ticket(ctx, tx, a, input.ID)
		if e != nil {
			return nil, e
		}
		var datasets []string
		_ = remarshal(ticket["datasets"], &datasets)
		if !slices.Contains(datasets, input.Dataset) {
			return nil, fault.New("export_dataset_denied", 403)
		}
		row, e := one(ctx, tx, "SELECT * FROM outcome_materials_v2 WHERE id=$1 AND subject_id=$2 AND created_at<=$3", input.RecordID, a.SubjectID, stamp(ticket["selection_cutoff"]))
		if e != nil {
			return nil, notfound(e)
		}
		if text(row["source_kind"]) != "attachment" {
			return nil, fault.New("export_binary_unavailable", 404)
		}
		if s.OutcomeMaterials == nil {
			return nil, fault.New("export_binary_unavailable", 503)
		}
		content, e := s.OutcomeMaterials(ctx, tx, a, input.RecordID)
		if e != nil {
			return nil, e
		}
		available, _ := content["contentAvailable"].(bool)
		result := Object{"version": 1, "endpoint": s.Endpoint, "subjectId": a.SubjectID, "exportId": input.ID, "dataset": input.Dataset, "recordId": input.RecordID, "offset": input.Offset, "sha256": row["sha256"]}
		if !available || text(content["bytesBase64"]) == "" {
			reason := text(content["reason"])
			if reason == "" {
				reason = "unavailable"
			}
			result["length"] = 0
			result["totalBytes"] = integer(row["byte_size"])
			result["nextOffset"] = nil
			result["complete"] = false
			result["binaryContentAvailable"] = false
			result["reason"] = reason
		} else {
			bytes, e := base64.StdEncoding.DecodeString(text(content["bytesBase64"]))
			if e != nil {
				return nil, e
			}
			if input.Offset > len(bytes) {
				return nil, fault.New("invalid_export_cursor", 400)
			}
			end := min(len(bytes), input.Offset+input.Length)
			chunk := bytes[input.Offset:end]
			var next *int
			if end < len(bytes) {
				next = &end
			}
			result["length"] = len(chunk)
			result["totalBytes"] = len(bytes)
			result["nextOffset"] = next
			result["complete"] = next == nil
			result["binaryContentAvailable"] = true
			result["contentBase64"] = base64.StdEncoding.EncodeToString(chunk)
		}
		if a.HTTPRequestID != nil {
			if e = audit(ctx, tx, a, auth, "data.export.binary", input.RecordID, "data-export"); e != nil {
				return nil, e
			}
		}
		return result, nil
	})
}
