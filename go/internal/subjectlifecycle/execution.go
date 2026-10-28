package subjectlifecycle

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"strings"
	"time"
)

type DeletionInfo struct {
	SubjectID, RequestID string
	At, RetainedUntil    int64
}
type ProductDeletionConsumer interface {
	PrepareWithin(context.Context, pgx.Tx, DeletionInfo) (Object, error)
	MinimizeWithin(context.Context, pgx.Tx, DeletionInfo) (Object, error)
}
type ExecutionOptions struct {
	Product         ProductDeletionConsumer
	RecoveryContext Object
}

var targetOrder []string

func init() {
	value, e := protocol.DecodeOrdered(maintenanceData)
	if e != nil {
		panic(e)
	}
	root, ok := value.(*protocol.OrderedObject)
	if !ok {
		panic("invalid maintenance catalog")
	}
	targets, ok := root.Values()["targets"].(*protocol.OrderedObject)
	if !ok {
		panic("invalid maintenance targets")
	}
	targetOrder = targets.Keys()
}
func counts(value any) Object {
	out := Object{}
	source, _ := value.(Object)
	for _, name := range targetOrder {
		out[name] = integer(source[name])
	}
	return out
}
func countSum(value Object) int64 {
	var total int64
	for _, v := range value {
		total += integer(v)
	}
	return total
}
func fieldObject(kv ...any) *protocol.OrderedObject {
	o := protocol.NewOrderedObject()
	for i := 0; i < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}
func countWire(values Object) *protocol.OrderedObject {
	o := protocol.NewOrderedObject()
	for _, key := range targetOrder {
		if v, ok := values[key]; ok {
			o.Set(key, v)
		}
	}
	return o
}
func revokeOwnedWithin(ctx context.Context, tx pgx.Tx, subject string, at int64) (Object, error) {
	out := Object{}
	for _, entry := range []struct{ name, where string }{{"bindings", "subject_id=$1"}, {"access_credentials", "binding_id IN(SELECT id FROM bindings WHERE subject_id=$1)"}, {"consents", "subject_id=$1"}, {"proofs", "subject_id=$1"}, {"context_grants", "subject_id=$1"}, {"audit_access_grants", "reviewer_id=$1"}, {"data_exports", "subject_id=$1"}, {"external_identity_links", "subject_id=$1"}} {
		tag, e := tx.Exec(ctx, `UPDATE "`+entry.name+`" SET revoked_at=$2 WHERE `+entry.where+` AND revoked_at IS NULL`, subject, time.Unix(at, 0))
		if e != nil {
			return nil, e
		}
		out[entry.name] = tag.RowsAffected()
	}
	if _, e := tx.Exec(ctx, `UPDATE evidence_submissions SET state='revoked' WHERE subject_id=$1`, subject); e != nil {
		return nil, e
	}
	for _, entry := range []struct{ name, where string }{{"binding_challenges", "subject_id=$1"}, {"session_challenges", "binding_id IN(SELECT id FROM bindings WHERE subject_id=$1)"}} {
		if _, e := tx.Exec(ctx, `UPDATE "`+entry.name+`" SET expires_at=LEAST(expires_at,$2::timestamptz) WHERE `+entry.where, subject, time.Unix(at, 0)); e != nil {
			return nil, e
		}
	}
	return out, nil
}

// ExecuteWithin is the original reviewed maintenance transaction, not a public
// user route. It validates the complete inventory, original signed request and
// exact approval before any revocation or erase. External stores remain a
// separate explicitly configured stage; this result never certifies them.
func ExecuteWithin(ctx context.Context, tx pgx.Tx, c ExecutionCommand, at int64, options ExecutionOptions) (Object, error) {
	p, e := PrepareExecutionWithin(ctx, tx, c, at)
	if e != nil {
		return nil, e
	}
	if p.PriorResult != nil {
		return p.PriorResult, nil
	}
	if options.Product == nil {
		return nil, errors.New("deletion product consumers unavailable")
	}
	if _, e = tx.Exec(ctx, `SELECT set_config('galaxy.deletion_subject',$1,true)`, p.SubjectID); e != nil {
		return nil, e
	}
	revoked, e := revokeOwnedWithin(ctx, tx, p.SubjectID, at)
	if e != nil {
		return nil, e
	}
	info := DeletionInfo{SubjectID: p.SubjectID, RequestID: c.RequestID, At: at, RetainedUntil: max(at, p.Plan.Audit.Until)}
	product, e := options.Product.PrepareWithin(ctx, tx, info)
	if e != nil {
		return nil, e
	}
	if _, e = tx.Exec(ctx, `CREATE TEMP TABLE galaxy_deletion_candidates(table_name text NOT NULL,key_data jsonb NOT NULL) ON COMMIT DROP`); e != nil {
		return nil, e
	}
	selected, removed := counts(nil), counts(nil)
	joins := map[string]string{}
	for _, table := range targetOrder {
		keys := p.Inventory.Keys[table]
		if len(keys) == 0 {
			return nil, errors.New("deletion primary key missing")
		}
		parts, match := []string{}, []string{}
		for _, key := range keys {
			column, e := quote(key.Column)
			if e != nil {
				return nil, e
			}
			parts = append(parts, "'"+key.Column+"',t."+column)
			match = append(match, "t."+column+"=(c.key_data->>'"+key.Column+"')::"+key.Type)
		}
		joins[table] = strings.Join(match, " AND ")
		where := maintenanceCatalog.Targets[table]
		if where == "false" {
			continue
		}
		name, e := quote(table)
		if e != nil {
			return nil, e
		}
		tag, e := tx.Exec(ctx, `INSERT INTO galaxy_deletion_candidates SELECT $2,jsonb_build_object(`+strings.Join(parts, ",")+`) FROM `+name+` t WHERE `+where, p.SubjectID, table)
		if e != nil {
			return nil, e
		}
		selected[table] = tag.RowsAffected()
	}
	auditTables := []string{"audit_events", "audit_access_grants", "audit_reads", "data_export_reads"}
	passes := 0
	for {
		passes++
		var changed int64
		for _, table := range targetOrder {
			if at < p.Plan.Audit.Until && (contains(auditTables, table) || contains(maintenanceCatalog.ControlHistory, table)) {
				continue
			}
			blockers := []string{}
			for _, ref := range p.Inventory.References {
				if ref.Target != table || ref.Action == "n" {
					continue
				}
				source, e := quote(ref.Source)
				if e != nil {
					return nil, e
				}
				equal := []string{}
				for _, col := range ref.Columns {
					src, e := quote(col.Source)
					if e != nil {
						return nil, e
					}
					target, e := quote(col.Target)
					if e != nil {
						return nil, e
					}
					equal = append(equal, "r."+src+"=t."+target)
				}
				blockers = append(blockers, "NOT EXISTS(SELECT 1 FROM "+source+" r WHERE "+strings.Join(equal, " AND ")+")")
			}
			if table == "bindings" {
				blockers = append(blockers, "NOT EXISTS(SELECT 1 FROM audit_events r WHERE r.binding_id=t.id)")
			}
			if contains(maintenanceCatalog.ControlHistory, table) {
				for _, ref := range p.Inventory.References {
					if ref.Target != "subjects" || contains(maintenanceCatalog.ControlHistory, ref.Source) {
						continue
					}
					source, e := quote(ref.Source)
					if e != nil {
						return nil, e
					}
					equal := []string{}
					for _, col := range ref.Columns {
						column, e := quote(col.Source)
						if e != nil {
							return nil, e
						}
						equal = append(equal, "r."+column+"=t.subject_id")
					}
					blockers = append(blockers, "NOT EXISTS(SELECT 1 FROM "+source+" r WHERE "+strings.Join(equal, " AND ")+")")
				}
			}
			suffix := ""
			if len(blockers) > 0 {
				suffix = " AND " + strings.Join(blockers, " AND ")
			}
			name, e := quote(table)
			if e != nil {
				return nil, e
			}
			tag, e := tx.Exec(ctx, `DELETE FROM `+name+` t USING galaxy_deletion_candidates c WHERE c.table_name=$1 AND `+joins[table]+suffix, table)
			if e != nil {
				return nil, e
			}
			removed[table] = integer(removed[table]) + tag.RowsAffected()
			changed += tag.RowsAffected()
		}
		if changed == 0 || passes >= 256 {
			break
		}
	}
	minimized, e := options.Product.MinimizeWithin(ctx, tx, info)
	if e != nil {
		return nil, e
	}
	product["retainedBodiesMinimized"] = minimized
	remaining := counts(nil)
	for _, table := range targetOrder {
		remaining[table] = integer(selected[table]) - integer(removed[table])
	}
	previous, _ := p.request["execution_result"].(Object)
	var cumulative Object
	oldRecovery, _ := previous["recoveryContext"].(Object)
	if options.RecoveryContext != nil && oldRecovery["recoveryId"] != options.RecoveryContext["recoveryId"] {
		cumulative = counts(nil)
	} else {
		cumulative = counts(previous["totalDeletedCounts"])
	}
	for _, table := range targetOrder {
		cumulative[table] = integer(cumulative[table]) + integer(removed[table])
	}
	primary, auditRemaining := Object{}, Object{}
	for _, table := range targetOrder {
		if contains(auditTables, table) {
			auditRemaining[table] = remaining[table]
		} else {
			primary[table] = remaining[table]
		}
	}
	var honorRules int64
	if e = tx.QueryRow(ctx, `SELECT count(*) FROM honor_rule_versions WHERE endpoint=$1 AND definition->'members' ? $2`, c.Endpoint, p.SubjectID).Scan(&honorRules); e != nil {
		return nil, e
	}
	state, primaryState := "primary-erased", "erased"
	if countSum(primary) > 0 {
		state = "partial"
		primaryState = "references-remain"
	}
	auditState := "erased"
	if countSum(auditRemaining) > 0 {
		auditState = "references-remain"
		if at < p.Plan.Audit.Until {
			auditState = "retained-until-policy"
		}
	}
	policyState := "no-honor-membership-references"
	if honorRules > 0 {
		policyState = "retained-honor-membership-references"
	}
	product["controlHistory"] = "retained-while-audit-or-independent-subject-references-exist"
	product["contentErasureReceipts"] = fieldObject("state", "minimal-metadata-only", "until", info.RetainedUntil, "cleanupImplemented", true)
	result := fieldObject("version", 1, "id", c.ID, "requestId", c.RequestID, "subjectId", p.SubjectID, "endpoint", c.Endpoint, "approvalId", c.ApprovalID, "executedAt", time.Unix(at, 0).UTC().Format("2006-01-02T15:04:05.000Z"), "revision", integer(p.request["revision"])+1, "state", state, "physicalDeletionPerformed", countSum(cumulative) > 0, "primary", fieldObject("state", primaryState, "remaining", countWire(primary)), "audit", fieldObject("state", auditState, "until", p.Plan.Audit.Until, "remaining", countWire(auditRemaining)), "backups", fieldObject("state", "deletion-and-expiry-unverified", "until", p.Plan.Backups.Until), "externalCopies", fieldObject("state", "outside-service-control"), "receiptLedger", fieldObject("state", "retained-pending-minimization", "cleanupImplemented", true), "productV2", product, "delegatedStores", fieldObject("chat", fieldObject("state", "separate-transport-erasure-required", "primaryReferenceDeletionIsBodyDeletion", false)), "operatorPolicies", fieldObject("state", policyState, "honorRuleVersions", honorRules, "cleanupImplemented", false), "selectedCounts", countWire(selected), "deletedCounts", countWire(removed), "totalDeletedCounts", countWire(cumulative), "remainingCounts", countWire(remaining), "revoked", revoked, "passes", passes, "serviceWideDeletionComplete", false, "storageMediaErasureVerified", false, "restoredSnapshotDeletionReplay", options.RecoveryContext != nil)
	if options.RecoveryContext != nil {
		result.Set("recoveryContext", options.RecoveryContext)
	}
	raw, e := protocol.EncodeJS(result)
	if e != nil {
		return nil, e
	}
	if _, e = tx.Exec(ctx, `UPDATE deletion_requests SET state=$2,revision=$3,execution_result=$4::jsonb,updated_at=$5 WHERE id=$1`, c.RequestID, state, integer(p.request["revision"])+1, string(raw), time.Unix(at, 0)); e != nil {
		return nil, e
	}
	if _, e = tx.Exec(ctx, `INSERT INTO deletion_events(id,request_id,revision,actor_kind,actor_ref,kind,payload_text,payload_hash) VALUES($1,$2,$3,'operator',$4,'execute',$5,$6)`, c.ID, c.RequestID, integer(p.request["revision"])+1, c.ExecutorRef, string(raw), identity.Digest(raw)); e != nil {
		return nil, e
	}
	if _, e = tx.Exec(ctx, `INSERT INTO deletion_executions(id,request_id,subject_id,command_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)`, c.ID, c.RequestID, p.SubjectID, p.CommandHash, string(raw)); e != nil {
		return nil, e
	}
	if _, e = tx.Exec(ctx, `DROP TABLE galaxy_deletion_candidates`); e != nil {
		return nil, e
	}
	return result.Values(), nil
}
