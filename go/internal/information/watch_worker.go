package information

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func parseJob(input Object) error {
	if !exact(input, []string{"watchId", "subjectId", "revision", "checkRevision"}, nil) || !uuidPattern.MatchString(text(input, "watchId")) || !subjectPattern.MatchString(text(input, "subjectId")) || !integer(input["revision"], 1, 2147483647) || !integer(input["checkRevision"], 0, 2147483647) {
		return fault.New("operations_job_payload_invalid", 400)
	}
	return nil
}

// ProcessJob is one explicitly dispatched original check identity. It neither
// starts a production loop nor constructs an ordinary actor without credentials.
func (s *Watches) ProcessJob(ctx context.Context, input Object) (Object, error) {
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	if e := parseJob(input); e != nil {
		return nil, e
	}
	if s.Pool == nil || s.Devices == nil {
		return nil, fault.New("information_watch_unavailable", 503)
	}
	capture, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		rows, e := query(ctx, tx, `SELECT `+watchColumns+` FROM information_watches_v2 WHERE id=$1 AND subject_id=$2`, input["watchId"], input["subjectId"])
		if e != nil || len(rows) == 0 {
			return nil, e
		}
		return decodeWatch(rows[0])
	})
	if e != nil {
		return nil, e
	}
	if capture == nil || capture["state"] != "active" || number(capture, "revision") != number(input, "revision") || number(capture, "check_revision") != number(input, "checkRevision") || seconds(capture["expires_at"]) <= s.now() {
		return Object{"state": "superseded"}, nil
	}
	if s.CanProcessEvidence != nil && !s.CanProcessEvidence() || s.CanProcessBackground != nil && !s.CanProcessBackground() {
		_, e := s.Pool.Exec(ctx, `UPDATE information_watches_v2 SET next_check_at=$3,background_state='service-paused' WHERE id=$1 AND revision=$2`, capture["id"], number(capture, "revision"), s.at(s.now()+60))
		if e != nil {
			return nil, e
		}
		return Object{"state": "service-paused"}, nil
	}
	actor, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (deviceauth.Actor, error) {
		return s.Devices.NewInformationWatchActor(ctx, tx, text(capture, "id"), text(capture, "subject_id"), number(capture, "revision"))
	})
	var result Object
	if e == nil {
		result, e = s.Check(ctx, actor, encode(Object{"watchId": capture["id"], "expectedRevision": capture["revision"]}))
	}
	if e == nil {
		return Object{"state": result["state"], "changed": result["changed"] == true}, nil
	}
	latest, readErr := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		rows, e := query(ctx, tx, `SELECT revision,state,expires_at FROM information_watches_v2 WHERE id=$1`, capture["id"])
		if e != nil || len(rows) == 0 {
			return nil, e
		}
		return rows[0], nil
	})
	if readErr != nil {
		return nil, readErr
	}
	if latest == nil || number(latest, "revision") != number(capture, "revision") || latest["state"] != "active" || seconds(latest["expires_at"]) <= s.now() {
		return Object{"state": "superseded"}, nil
	}
	var serviceError *fault.Error
	denied := errors.As(e, &serviceError) && (serviceError.Status == 401 || serviceError.Status == 403 || serviceError.Status == 404 || serviceError.Status == 410)
	state, code := "temporarily-unavailable", "information_watch_check_unavailable"
	if denied {
		state, code = "authorization-required", "information_watch_authorization_required"
	}
	if _, updateErr := s.Pool.Exec(ctx, `UPDATE information_watches_v2 SET background_state=$3,background_error=$4,next_check_at=$5 WHERE id=$1 AND revision=$2 AND state='active'`, capture["id"], number(capture, "revision"), state, code, s.at(s.now()+300)); updateErr != nil {
		return nil, updateErr
	}
	if denied {
		return Object{"state": "authorization-required"}, nil
	}
	return nil, fault.New("information_watch_check_unavailable", 503)
}

// Reconcile uses the shared scheduler's real active-work lookup and producer.
// Scheduler adoption/old Node shutdown belong to the root runtime cutover.
func (s *Watches) Reconcile(ctx context.Context) (Object, error) {
	if s.Tasks == nil {
		return Object{"queued": 0}, nil
	}
	if s.HasOutstanding == nil {
		return nil, fault.New("information_watch_queue_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		queued := 0
		at := s.at(s.now())
		var afterID, afterAt any
		for queued < 100 {
			rows, e := query(ctx, tx, `SELECT `+watchColumns+` FROM information_watches_v2 WHERE state='active' AND expires_at>$1 AND background_authority IS NOT NULL AND background_state<>'authorization-required' AND (next_check_at IS NULL OR next_check_at<=$1)
 AND ($2::uuid IS NULL OR ($3::timestamptz IS NULL AND (next_check_at IS NOT NULL OR next_check_at IS NULL AND id>$2)) OR ($3::timestamptz IS NOT NULL AND (next_check_at>$3 OR next_check_at=$3 AND id>$2)))
 ORDER BY next_check_at NULLS FIRST,id LIMIT 100 FOR UPDATE SKIP LOCKED`, at, afterID, afterAt)
			if e != nil {
				return nil, e
			}
			for _, value := range rows {
				r, e := decodeWatch(value)
				if e != nil {
					return nil, e
				}
				outstanding, e := s.HasOutstanding(ctx, tx, text(r, "id"), number(r, "revision"), number(r, "check_revision"))
				if e != nil {
					return nil, e
				}
				if outstanding {
					continue
				}
				if e = s.queueWithin(ctx, tx, r); e != nil {
					return nil, e
				}
				queued++
				if queued == 100 {
					break
				}
			}
			if len(rows) < 100 {
				break
			}
			afterID, afterAt = rows[len(rows)-1]["id"], rows[len(rows)-1]["next_check_at"]
		}
		return Object{"queued": queued}, nil
	})
}
func (s *Watches) CancelJobWithin(ctx context.Context, tx pgx.Tx, input Object) error {
	if e := parseJob(input); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, `UPDATE information_watches_v2 SET state='paused',revision=revision+1,background_state='paused',updated_at=$4 WHERE id=$1 AND subject_id=$2 AND revision=$3 AND state='active'`, input["watchId"], input["subjectId"], number(input, "revision"), s.at(s.now()))
	return e
}
