package publication

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"regexp"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/feedback"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Commands struct {
	Pool      *pgxpool.Pool
	Endpoint  string
	Queue     *jobs.Queue
	Authority feedback.Authorization
	RequestID string
	Now       func() time.Time
}

func (c *Commands) now() time.Time {
	if c.Now != nil {
		return c.Now().UTC().Truncate(time.Second)
	}
	return time.Now().UTC().Truncate(time.Second)
}
func (c *Commands) authorize(ctx context.Context, tx pgx.Tx, operator, permission string) (feedback.Operator, error) {
	if c.Authority == nil {
		return feedback.Operator{}, fault.New("operations_authorization_unavailable", 503)
	}
	return c.Authority.Operator(ctx, tx, c.Endpoint, operator, permission)
}

var pageAfter = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)
var routeUUID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func requestUUID(value string) bool {
	return routeUUID.MatchString(value) || value == "00000000-0000-0000-0000-000000000000" || strings.EqualFold(value, "ffffffff-ffff-ffff-ffff-ffffffffffff")
}
func isoPointer(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
func publicationView(row pgx.Row) (Object, error) {
	var id, state, operator string
	var created, updated time.Time
	var published *time.Time
	var result, errValue Object
	e := row.Scan(&id, &state, &created, &updated, &published, &operator, &result, &errValue)
	if e != nil {
		return nil, e
	}
	return Object{"id": id, "state": state, "createdAt": created.UTC().Format("2006-01-02T15:04:05.000Z"), "updatedAt": updated.UTC().Format("2006-01-02T15:04:05.000Z"), "publishedAt": isoPointer(published), "requestedBy": operator, "result": nilObject(result), "error": nilObject(errValue)}, nil
}
func nilObject(v Object) any {
	if v == nil {
		return nil
	}
	return v
}

const viewColumns = "id::text,state,created_at,updated_at,published_at,requested_by,result,error"

type publicationRequest struct {
	OperationID string
	compact     []byte
	snapshot    Snapshot
}

func parsePublicationRequest(raw []byte) (publicationRequest, error) {
	var fields map[string]json.RawMessage
	var input struct {
		OperationID string          `json:"operationId"`
		Snapshot    json.RawMessage `json:"snapshot"`
	}
	if protocol.Decode(raw, &fields) != nil || len(fields) != 2 || protocol.Decode(raw, &input) != nil || !requestUUID(input.OperationID) {
		return publicationRequest{}, fault.New("invalid_site_publication", 400)
	}
	var value Object
	if protocol.Decode(input.Snapshot, &value) != nil {
		return publicationRequest{}, fault.New("invalid_site_publication", 400)
	}
	compact, e := json.Marshal(value)
	if e != nil {
		return publicationRequest{}, fault.New("invalid_site_publication", 400)
	}
	snapshot, e := ParseSnapshot(compact)
	if e != nil {
		return publicationRequest{}, e
	}
	return publicationRequest{OperationID: input.OperationID, compact: compact, snapshot: snapshot}, nil
}
func (c *Commands) Request(ctx context.Context, operator string, raw []byte) (Object, error) {
	input, e := parsePublicationRequest(raw)
	if e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, c.Pool, func(tx pgx.Tx) (Object, error) { return c.requestWithin(ctx, tx, operator, input) })
}

// RequestWithin uses the caller's already pinned publication transaction. The
// existing authority, operation ledger and queue remain the same implementation.
func (c *Commands) RequestWithin(ctx context.Context, tx pgx.Tx, operator string, raw []byte) (Object, error) {
	input, e := parsePublicationRequest(raw)
	if e != nil {
		return nil, e
	}
	return c.requestWithin(ctx, tx, operator, input)
}
func (c *Commands) requestWithin(ctx context.Context, tx pgx.Tx, operator string, input publicationRequest) (Object, error) {
	if _, e := c.authorize(ctx, tx, operator, "cms.publish"); e != nil {
		return nil, e
	}
	if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(734912340)"); e != nil {
		return nil, e
	}
	var endpoint, owner string
	var prior []byte
	e := tx.QueryRow(ctx, "SELECT endpoint,requested_by,snapshot FROM site_publications_v1 WHERE id=$1", input.OperationID).Scan(&endpoint, &owner, &prior)
	if e == nil {
		var left, right any
		json.Unmarshal(prior, &left)
		json.Unmarshal(input.compact, &right)
		if endpoint != c.Endpoint || owner != operator || !reflect.DeepEqual(left, right) {
			return nil, fault.New("site_publication_operation_changed", 409)
		}
		view, e := publicationView(tx.QueryRow(ctx, "SELECT "+viewColumns+" FROM site_publications_v1 WHERE id=$1", input.OperationID))
		return Object{"publication": view, "replayed": true}, e
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return nil, e
	}
	at := c.now()
	body, _ := json.Marshal(input.snapshot)
	view, e := publicationView(tx.QueryRow(ctx, "INSERT INTO site_publications_v1(id,endpoint,requested_by,snapshot,state,created_at,updated_at) VALUES($1,$2,$3,$4,'queued',$5,$5) RETURNING "+viewColumns, input.OperationID, c.Endpoint, operator, body, at))
	if e != nil {
		return nil, e
	}
	if c.Queue == nil {
		return nil, fault.New("site_publication_queue_unavailable", 503)
	}
	task := jobs.Task{ID: input.OperationID, Endpoint: c.Endpoint, Action: jobs.ContentPublication, SourceID: input.OperationID, OperationID: input.OperationID}
	job, e := c.Queue.EnqueueWithin(ctx, tx, task, time.Time{})
	if e != nil {
		return nil, e
	}
	if job == "" {
		return nil, fault.New("site_publication_queue_unavailable", 503)
	}
	if _, e = tx.Exec(ctx, "UPDATE site_publications_v1 SET job_id=$2 WHERE id=$1", input.OperationID, job); e != nil {
		return nil, e
	}
	return Object{"publication": view, "replayed": false}, nil
}
func (c *Commands) Get(ctx context.Context, operator, id string) (Object, error) {
	if !requestUUID(id) {
		return nil, fault.New("invalid_site_publication", 400)
	}
	return postgres.InTx(ctx, c.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := c.authorize(ctx, tx, operator, "cms.read"); e != nil {
			return nil, e
		}
		view, e := publicationView(tx.QueryRow(ctx, "SELECT "+viewColumns+" FROM site_publications_v1 WHERE id=$1 AND endpoint=$2", id, c.Endpoint))
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, fault.New("site_publication_not_found", 404)
		}
		return Object{"publication": view}, e
	})
}
func (c *Commands) List(ctx context.Context, operator string, after *string, limit int) (Object, error) {
	if limit < 1 || limit > 100 || after != nil && !pageAfter.MatchString(*after) {
		return nil, fault.New("invalid_operations_query", 400)
	}
	return postgres.InTx(ctx, c.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := c.authorize(ctx, tx, operator, "cms.read"); e != nil {
			return nil, e
		}
		rows, e := tx.Query(ctx, "SELECT sequence::text,"+viewColumns+" FROM site_publications_v1 WHERE endpoint=$1 AND ($2::bigint IS NULL OR sequence<$2) ORDER BY sequence DESC LIMIT $3", c.Endpoint, after, limit+1)
		if e != nil {
			return nil, e
		}
		defer rows.Close()
		items := []Object{}
		var next any
		last := ""
		for rows.Next() {
			var sequence, id, state, owner string
			var created, updated time.Time
			var published *time.Time
			var result, failure Object
			if e = rows.Scan(&sequence, &id, &state, &created, &updated, &published, &owner, &result, &failure); e != nil {
				return nil, e
			}
			if len(items) == limit {
				next = last
				break
			}
			last = sequence
			items = append(items, Object{"id": id, "state": state, "createdAt": created.UTC().Format("2006-01-02T15:04:05.000Z"), "updatedAt": updated.UTC().Format("2006-01-02T15:04:05.000Z"), "publishedAt": isoPointer(published), "requestedBy": owner, "result": nilObject(result), "error": nilObject(failure)})
		}
		if e = rows.Err(); e != nil {
			return nil, e
		}
		return Object{"items": items, "nextAfter": next}, nil
	})
}
