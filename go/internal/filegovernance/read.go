package filegovernance

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
)

const fileCTE = `WITH raw_files AS (
 SELECT a.id,'chat'::text AS kind,a.name,a.state,a.created_at,a.uploaded_at,a.expires_at,a.prepare_expires_at,a.revoked_at,a.purged_at,a.purge_pending,a.byte_size,a.subject_id,NULL::uuid AS account_id,a.scan_attempts,a.scan_result,a.lease_id,a.lease_until,a.last_error,a.operations_retry_revision FROM chat_attachments a WHERE a.subject_id NOT LIKE 'account:%' OR EXISTS(SELECT 1 FROM community_accounts o WHERE 'account:'||o.id::text=a.subject_id AND o.endpoint=$1)
 UNION ALL SELECT a.id,'forum'::text AS kind,a.name,a.state,a.created_at,a.uploaded_at,a.expires_at,a.prepare_expires_at,a.revoked_at,a.purged_at,a.purge_pending,a.byte_size,a.subject_id,a.account_id,a.scan_attempts,a.scan_result,a.lease_id,a.lease_until,a.last_error,a.operations_retry_revision FROM forum_attachments_v1 a JOIN community_accounts o ON o.id=a.account_id AND o.endpoint=$1
) , removal_files AS (
 SELECT f.*,r.state AS removal_state FROM raw_files f LEFT JOIN galaxy_go_storage.object_removals_v1 r ON r.endpoint=$1 AND r.domain=f.kind AND r.object_id=f.id
), files AS (
 SELECT *,CASE WHEN purged_at IS NOT NULL THEN 'erased' WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN COALESCE(expires_at,prepare_expires_at)<=$6 THEN 'expired' ELSE state END AS effective_state,
 purged_at IS NULL AND (purge_pending OR revoked_at IS NOT NULL OR COALESCE(expires_at,prepare_expires_at)<=$6) AS needs_cleanup,
 purged_at IS NULL AND (removal_state IN ('reserved','result-unknown','legacy-unknown') OR purge_pending AND last_error='attachment_cleanup_failed' AND removal_state IS NULL) AS cleanup_unknown,
 purged_at IS NULL AND state IN ('scan-pending','scanning') AND scan_attempts>0 AND last_error IS NOT NULL AND last_error<>'attachment_cleanup_failed' AS scan_failed FROM removal_files
), selected_files AS (
 SELECT * FROM files WHERE ($2::text IS NULL OR kind=$2) AND ($3::text IS NULL OR effective_state=$3)
 AND ($4::text IS NULL OR $4='scan' AND state IN ('scan-pending','scanning') AND NOT purge_pending AND purged_at IS NULL OR $4='cleanup' AND needs_cleanup)
 AND ($5::text IS NULL OR $5='scan' AND scan_failed OR $5='cleanup' AND cleanup_unknown OR $5='any' AND purged_at IS NULL AND (last_error IS NOT NULL OR cleanup_unknown))
)`

func safeSize(v any) any {
	n, e := strconv.ParseFloat(fmt.Sprint(v), 64)
	if e != nil || n < 0 || n > 9007199254740991 || n != float64(int64(n)) {
		return nil
	}
	return int64(n)
}
func safeName(v any) any {
	return displayName(v, false)
}
func cleanupName(v any) any { return displayName(v, true) }
func displayName(v any, asciiOnly bool) any {
	s, ok := v.(string)
	if !ok {
		return nil
	}
	r := []rune(s)
	for i, c := range r {
		if asciiOnly && (c <= 31 || c == 127) || !asciiOnly && unicode.Is(unicode.Cc, c) {
			r[i] = ' '
		}
	}
	s = trim(string(r))
	if s == "" {
		return nil
	}
	units := utf16.Encode([]rune(s))
	if len(units) <= 180 {
		return s
	}
	units = units[:180]
	if last := units[len(units)-1]; last >= 0xd800 && last <= 0xdbff {
		var b strings.Builder
		b.WriteByte('"')
		for _, u := range units {
			fmt.Fprintf(&b, `\u%04x`, u)
		}
		b.WriteByte('"')
		return json.RawMessage(b.String())
	}
	return string(utf16.Decode(units))
}
func (s *Service) readMeta() Object {
	return Object{"checkedAt": s.now(), "readExpiresAt": s.now() + 30, "metadataOnly": true}
}
func (s *Service) blocked(ctx context.Context, tx pgx.Tx, kind string, r Object) (*string, error) {
	a, e := s.adapter(kind, false)
	if e != nil {
		return nil, e
	}
	if a != nil && a.RestoreBlocked != nil {
		return a.RestoreBlocked(ctx, tx, r, s.now())
	}
	return RestorationBlockedWithin(ctx, tx, kind, r, a, s.now())
}
func (s *Service) view(ctx context.Context, tx pgx.Tx, kind string, r Object, a Actor, detail bool) (Object, error) {
	service, e := s.adapter(kind, false)
	if e != nil {
		return nil, e
	}
	retry, facts := RetryState(r, s.now()), ProcessingFacts(r, s.now())
	removal, e := (&objectremoval.Service{Endpoint: s.Endpoint}).ReadStateWithin(ctx, tx, kind, str(r, "id"))
	if e != nil {
		return nil, e
	}
	if removal != nil {
		cleanup := obj(facts, "cleanup")
		cleanup["state"] = objectremoval.CleanupState(removal)
		cleanup["objectRemoved"] = removal["objectRemoved"]
		facts["cleanupUnknown"] = cleanup["state"] == "result-unknown"
	}

	var used int64
	e = tx.QueryRow(ctx, "SELECT count(*) FROM business_admin_audit_v1 WHERE endpoint=$1 AND action='file-retry' AND selection->>'kind'=$2 AND selection->>'id'=$3 AND created_at>$4", s.Endpoint, kind, r["id"], s.stamp().Add(-24*time.Hour)).Scan(&used)
	if e != nil {
		return nil, e
	}
	available := service != nil && service.Available != nil && service.Available()
	authorUnavailable := false
	if truth(retry, "scan") && service != nil {
		authorUnavailable, e = s.authorPending(ctx, tx, kind, r)
		if e != nil {
			return nil, e
		}
	}
	version := ProcessingVersion(r)
	access, e := AccessWithin(ctx, tx, s.Endpoint, kind, str(r, "id"), s.now(), true)
	if e != nil {
		return nil, e
	}
	names, e := s.NamesWithin(ctx, tx, []string{str(access, "operatorId")})
	if e != nil {
		return nil, e
	}
	var restore *string
	if truth(access, "stopped") {
		restore, e = s.blocked(ctx, tx, kind, r)
		if e != nil {
			return nil, e
		}
	}
	pending, e := s.authorPending(ctx, tx, kind, r)
	if e != nil {
		return nil, e
	}
	stoppable := r["purged_at"] == nil && r["revoked_at"] == nil && !truth(r, "purge_pending") && !truth(facts, "expired") && !pending
	remaining := int64(3) - used
	if remaining < 0 {
		remaining = 0
	}
	account := r["account_id"]
	var subject any = r["subject_id"]
	if strings.HasPrefix(str(r, "subject_id"), "account:") {
		subject = nil
		if account == nil {
			account = str(r, "subject_id")[8:]
		}
	}
	var lastError any
	if processingError.MatchString(str(r, "last_error")) {
		lastError = r["last_error"]
	}
	access["operatorDisplayName"] = names[str(access, "operatorId")]
	direct := a.AIProof == nil && !s.isDuty(a) && !s.domain().IsExecution(a)
	access["canStop"] = direct && has(a.Permissions, "files.access.stop") && stoppable && !truth(access, "stopped")
	access["canRestore"] = direct && has(a.Permissions, "files.access.restore") && truth(access, "stopped") && restore == nil
	basis := "not-checked"
	if operationspermissions.FileAccessPreparationReaderMatches(s.Authority, a) {
		basis = "human-confirmation-preparation"
	} else if s.isDuty(a) && s.duty() != nil {
		metadata, err := s.duty().DutyMetadata(a)
		if err != nil {
			return nil, err
		}
		if metadata["accessPurpose"] == "prepare" {
			basis = "duty-operation-preparation"
		}
	}
	eligibility := Object{"stop": nil, "restore": nil, "basis": basis, "executionAuthorized": false, "recheckedWhenPreparing": true}
	if basis != "not-checked" {
		if _, e = s.ScopeFileAccessWithin(ctx, tx, kind, str(r, "id"), false); e != nil {
			if fault.Code(e) != "source_unavailable" {
				return nil, e
			}
			eligibility["basis"] = "not-checked"
		} else {
			eligibility["stop"] = has(a.Permissions, "files.access.stop") && stoppable && !truth(access, "stopped")
			eligibility["restore"] = has(a.Permissions, "files.access.restore") && truth(access, "stopped") && restore == nil
		}
	}
	access["preparationEligibility"] = eligibility
	access["restoreBlockedReason"] = restore
	reserved := safeSize(r["byte_size"])
	if r["purged_at"] != nil {
		reserved = int64(0)
	}
	readUntil := s.now() + 30
	if truth(access, "stopped") && num(access, "until") < readUntil {
		readUntil = num(access, "until")
	}
	out := Object{"id": r["id"], "kind": kind, "name": safeName(r["name"]), "scope": "existing-managed-file", "state": facts["state"], "processingState": r["state"], "version": version, "processingVersion": version, "size": safeSize(r["byte_size"]), "ownerAccountId": account, "originSubjectId": subject, "createdAt": iso(r["created_at"]), "uploadedAt": iso(r["uploaded_at"]), "expiresAt": iso(expiry(r)), "scanAttempts": r["scan_attempts"], "scanState": nil, "cleanupPending": r["purge_pending"], "removedAt": iso(r["purged_at"]), "revokedAt": iso(r["revoked_at"]), "retryAfter": iso(r["lease_until"]), "lastError": lastError, "activeLease": retry["activeLease"], "retriesRemaining": remaining, "processingAvailable": available, "canRetryScan": has(a.Permissions, "files.scan.retry") && available && used < 3 && truth(retry, "scan") && !authorUnavailable, "canRetryCleanup": false, "accounting": Object{"reservedBytes": reserved, "actualStoredBytes": nil}, "scan": facts["scan"], "cleanup": facts["cleanup"], "access": access, "contentAvailable": false, "checkedAt": s.now(), "readExpiresAt": readUntil}
	if scan := str(obj(r, "scan_result"), "state"); has([]string{"clean", "blocked"}, scan) {
		out["scanState"] = scan
	}
	if detail {
		out["history"], e = s.history(ctx, tx, kind, r)
		if e != nil {
			return nil, e
		}
	}
	return out, nil
}
func (s *Service) history(ctx context.Context, tx pgx.Tx, kind string, r Object) (Object, error) {
	history := []Object{}
	add := func(kind string, at any, extra Object) {
		if at == nil {
			return
		}
		item := Object{"kind": kind, "at": iso(at)}
		for k, v := range extra {
			item[k] = v
		}
		history = append(history, item)
	}
	add("prepared", r["created_at"], nil)
	add("upload-started", r["uploaded_at"], nil)
	add("revoked", r["revoked_at"], nil)
	add("object-removal-recorded", r["purged_at"], nil)
	if result := obj(r, "scan_result"); checkedISO(result["checkedAt"]) != nil && has([]string{"clean", "blocked"}, str(result, "state")) {
		add("scan-result", checkedISO(result["checkedAt"]), Object{"scanState": result["state"]})
	}
	events, e := rows(ctx, tx, `SELECT to_jsonb(q) FROM (SELECT operation_id,operator_id,created_at,selection->'command'->>'kind' AS retry_kind FROM business_admin_audit_v1 WHERE endpoint=$1 AND action='file-retry' AND selection->>'kind'=$2 AND selection->>'id'=$3 ORDER BY sequence DESC LIMIT 21)q`, s.Endpoint, kind, r["id"])
	if e != nil {
		return nil, e
	}
	ids := []string{}
	for _, event := range events {
		ids = append(ids, str(event, "operator_id"))
	}
	names, e := s.NamesWithin(ctx, tx, ids)
	if e != nil {
		return nil, e
	}
	for i, event := range events {
		if i >= 20 {
			break
		}
		if has([]string{"scan", "cleanup"}, str(event, "retry_kind")) {
			add(str(event, "retry_kind")+"-retry", event["created_at"], Object{"operationId": event["operation_id"], "operatorId": event["operator_id"], "operatorDisplayName": names[str(event, "operator_id")]})
		}
	}
	access, e := rows(ctx, tx, "SELECT to_jsonb(q) FROM (SELECT action,created_at,operation_id,operator_id,stopped_until,reason FROM operations_file_access_events_v1 WHERE endpoint=$1 AND kind=$2 AND file_id=$3 ORDER BY revision DESC LIMIT 21)q", s.Endpoint, kind, r["id"])
	if e != nil {
		return nil, e
	}
	ids = []string{}
	for _, event := range access {
		ids = append(ids, str(event, "operator_id"))
	}
	names, e = s.NamesWithin(ctx, tx, ids)
	if e != nil {
		return nil, e
	}
	for i, event := range access {
		if i >= 20 {
			break
		}
		var until any
		if event["stopped_until"] != nil {
			until = timestamp(event["stopped_until"]).Unix()
		}
		add("access-"+str(event, "action"), event["created_at"], Object{"operationId": event["operation_id"], "operatorId": event["operator_id"], "operatorDisplayName": names[str(event, "operator_id")], "until": until, "reason": event["reason"]})
	}
	sort.SliceStable(history, func(i, j int) bool { return str(history[i], "at") < str(history[j], "at") })
	return Object{"items": history, "truncated": len(events) > 20 || len(access) > 20, "fullProcessingHistoryAvailable": false}, nil
}
func (s *Service) Get(ctx context.Context, a Actor, kind, id string) (Object, error) {
	if !fileUUID.MatchString(id) {
		return nil, invalid()
	}
	if _, e := s.adapter(kind, false); e != nil {
		return nil, e
	}
	return s.run(ctx, a, "file-read", Object{"kind": kind, "id": id}, func(tx pgx.Tx, current Actor) (Object, error) {
		r, e := s.scopedRow(ctx, tx, kind, id, false)
		if e != nil {
			return nil, e
		}
		return s.view(ctx, tx, kind, r, current, true)
	})
}
