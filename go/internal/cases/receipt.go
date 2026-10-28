package cases

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *Service) Receipt(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	return s.operationReceipt(ctx, a, raw, false)
}
func (s *Service) TaskLinkReceipt(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	return s.operationReceipt(ctx, a, raw, true)
}
func (s *Service) operationReceipt(ctx context.Context, a deviceauth.Actor, raw []byte, task bool) (Object, error) {
	var q Object
	ids := []string{"caseId", "eventId"}
	if task {
		ids = []string{"taskId", "operationId"}
	}
	if protocol.Decode(raw, &q) != nil || !shape(q, append(append([]string{}, ids...), "payloadHash"), nil) || !uuidField(q, ids[0]) || !uuidField(q, ids[1]) || !hashPattern.MatchString(text(q, "payloadHash")) {
		return nil, fault.New("invalid_case_receipt", 400)
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		var row Object
		var e error
		if task {
			row, e = queryOne(ctx, tx, `SELECT task_id::text,case_id::text,payload_hash,receipt FROM case_task_links WHERE operation_id=$1 AND subject_id=$2`, q[ids[1]], a.SubjectID)
		} else {
			row, e = queryOne(ctx, tx, `SELECT id::text,case_id::text,payload_hash,version FROM case_events WHERE id=$1 AND subject_id=$2`, q[ids[1]], a.SubjectID)
		}
		if e != nil {
			return nil, e
		}
		state := "absent"
		if row != nil {
			state = "conflict"
			key := "case_id"
			if task {
				key = "task_id"
			}
			if row[key] == q[ids[0]] && row["payload_hash"] == q["payloadHash"] {
				state = "acknowledged"
			}
		}
		out := copyObject(q)
		out["state"] = state
		out["checkedAt"] = time.Unix(s.now(), 0).UTC().Format("2006-01-02T15:04:05.000Z")
		out["authority"] = "accepted-operation-only"
		out["currentAccessGranted"] = false
		if state == "acknowledged" {
			if task {
				prior := object(row["receipt"])
				out["caseId"] = row["case_id"]
				for _, k := range []string{"caseVersion", "taskVersion", "taskCaseLinkVersion"} {
					if v, ok := prior[k]; ok {
						out[k] = v
					}
				}
			} else {
				out["caseVersion"] = row["version"]
				out["verification"] = "not-provided"
				out["acceptance"] = "not-provided"
				out["resolution"] = "separate"
			}
		}
		return out, nil
	})
}
