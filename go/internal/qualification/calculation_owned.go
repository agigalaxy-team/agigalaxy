package qualification

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Service) OwnedCalculations(ctx context.Context, a Actor, input Object) (any, error) {
	if !queryClosed(input, nil, []string{"taskId", "after", "limit"}) {
		return nil, fail("invalid_qualification_grant_query", 400)
	}
	var taskID, after any
	for _, key := range []string{"taskId", "after"} {
		if v, ok := input[key]; ok {
			if !uuidPattern.MatchString(text(v)) {
				return nil, fail("invalid_qualification_grant_query", 400)
			}
			if key == "taskId" {
				taskID = v
			} else {
				after = v
			}
		}
	}
	limit := int64(12)
	if v, ok := input["limit"]; ok {
		if !positiveInteger(v) || number(v) > 30 {
			return nil, fail("invalid_qualification_grant_query", 400)
		}
		limit = number(v)
	}
	return s.run(ctx, a, func(tx pgx.Tx) (any, error) {
		rows, e := tx.Query(ctx, "SELECT to_jsonb(g) FROM qualification_calculation_grants g WHERE subject_id=$1 AND ($2::uuid IS NULL OR task_id=$2) AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4", a.SubjectID, taskID, after, limit+1)
		if e != nil {
			return nil, e
		}
		retained := []Object{}
		for rows.Next() {
			var row Object
			if e = rows.Scan(&row); e != nil {
				rows.Close()
				return nil, e
			}
			retained = append(retained, row)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
		items := []any{}
		for _, r := range retained[:min(len(retained), int(limit))] {
			var payload Object
			state := "source-erased"
			if str(r, "payload_text") != "" {
				state = "permission-unavailable"
			}
			read, e := s.readCalculationWithin(ctx, tx, a.Actor, str(r, "id"))
			if e != nil {
				if !unavailable(e) {
					return nil, e
				}
			} else {
				payload = read.Payload
				state = "recorded-current-intent"
			}
			if r["revoked_at"] != nil {
				state = "revoked"
			}
			created, e := time.Parse(time.RFC3339Nano, str(r, "created_at"))
			if e != nil {
				return nil, e
			}
			items = append(items, Object{"id": r["id"], "taskId": r["task_id"], "state": state, "kind": payload["kind"], "expiresAt": payload["expiresAt"], "createdAt": created.UTC().Format("2006-01-02T15:04:05.000Z"), "payload": payload, "sourceReadGranted": false, "qualificationGranted": false})
		}
		var next any
		if int64(len(retained)) > limit {
			next = object(items[len(items)-1])["id"]
		}
		return Object{"items": items, "nextAfter": next}, nil
	})
}
