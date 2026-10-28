package feedback

import (
	"context"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

const source = `operations_feedback_v1 f JOIN community_accounts a ON a.id=f.account_id AND a.endpoint=f.endpoint
 LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id`
const columns = `f.id::text,f.sequence,f.account_id::text,a.uid,p.display_name,f.title,f.body,f.category,f.module,f.state,
 f.revision,f.created_at,f.updated_at,f.submitted_category,f.submitted_module,
 (SELECT count(*)::int FROM feedback_attachments_v1 files WHERE files.endpoint=f.endpoint AND files.feedback_id=f.id)`
const matching = `f.endpoint=$1 AND f.owner_deleted_at IS NULL AND ($2::text='' OR position(lower($2::text) in lower(f.title))>0
 OR position(lower($2::text) in lower(f.body))>0 OR position(upper($2::text) in a.uid)>0
 OR position(lower($2::text) in lower(coalesce(p.display_name,'')))>0)
 AND ($3::text IS NULL OR f.module=$3) AND ($4::timestamptz IS NULL OR f.created_at>=$4)
 AND f.created_at<=$5`

type row struct {
	id, account, uid, title, body, module, state, submittedModule string
	displayName, category, submittedCategory                      *string
	sequence                                                      int64
	revision, attachmentCount                                     int
	created, updated                                              time.Time
}

func scan(r pgx.Row) (x row, e error) {
	e = r.Scan(&x.id, &x.sequence, &x.account, &x.uid, &x.displayName, &x.title, &x.body, &x.category, &x.module, &x.state, &x.revision, &x.created, &x.updated, &x.submittedCategory, &x.submittedModule, &x.attachmentCount)
	return
}
func (r row) item() Object {
	return Object{"id": r.id, "account": Object{"accountId": r.account, "uid": r.uid, "displayName": r.displayName}, "title": r.title,
		"excerpt": prefix(r.body, 160), "category": r.category, "module": r.module, "state": r.state, "revision": r.revision,
		"createdAt": iso(r.created), "updatedAt": iso(r.updated), "attachmentCount": r.attachmentCount}
}
func (s *Service) head(ctx context.Context, tx pgx.Tx, id string, lock bool) (row, error) {
	query := "SELECT " + columns + " FROM " + source + " WHERE f.id=$1 AND f.endpoint=$2 AND f.owner_deleted_at IS NULL"
	if lock {
		query += " FOR UPDATE OF f"
	}
	r, e := scan(tx.QueryRow(ctx, query, id, s.Endpoint))
	if errors.Is(e, pgx.ErrNoRows) {
		return r, fault.New("not_found", 404)
	}
	return r, e
}

type Query struct {
	Query, Category, Module, State, After string
	Days                                  string
	Limit                                 int
}

func sequenceValid(s string) bool {
	if s == "" {
		return true
	}
	n, e := strconv.ParseInt(s, 10, 64)
	return e == nil && n > 0 && strconv.FormatInt(n, 10) == s
}
func (q *Query) normalize() error {
	q.Query = feedbackTrim(q.Query)
	if utf8.RuneCountInString(q.Query) > 200 {
		return invalid()
	}
	if q.Days == "" {
		q.Days = "7"
	}
	if q.Limit == 0 {
		q.Limit = 30
	}
	if q.Days != "7" && q.Days != "28" && q.Days != "all" || q.Limit < 1 || q.Limit > 100 || !sequenceValid(q.After) {
		return invalid()
	}
	if q.Category != "" && q.Category != "unclassified" && q.Category != "problem" && q.Category != "suggestion" || q.Module != "" && !modules[q.Module] || q.State != "" && !states[q.State] {
		return invalid()
	}
	return nil
}
func period(now time.Time, days string) any {
	if days == "all" {
		return nil
	}
	n, _ := strconv.Atoi(days)
	start := int64(math.Floor(float64(now.Unix()+28800)/86400))*86400 - 28800 - int64(n-1)*86400
	return time.Unix(start, 0).UTC()
}
func (s *Service) List(ctx context.Context, operator string, q Query) (Object, error) {
	if e := q.normalize(); e != nil {
		return nil, e
	}
	return s.read(ctx, operator, "feedback-query", Object{"hasQuery": q.Query != "", "module": nullable(q.Module), "days": daysValue(q.Days), "category": nullable(q.Category), "state": nullable(q.State), "after": nullable(q.After), "limit": q.Limit}, func(tx pgx.Tx, a Operator) (Object, error) {
		now := s.now()
		args := []any{s.Endpoint, q.Query, nullable(q.Module), period(now, q.Days), now}
		var total, unclassified, pending, closed, problem, suggestion int
		e := tx.QueryRow(ctx, `SELECT count(*)::int,count(*) FILTER(WHERE f.category IS NULL)::int,
		 count(*) FILTER(WHERE f.state='pending')::int,count(*) FILTER(WHERE f.state='closed')::int,
		 count(*) FILTER(WHERE f.category='problem')::int,count(*) FILTER(WHERE f.category='suggestion')::int FROM `+source+` WHERE `+matching, args...).Scan(&total, &unclassified, &pending, &closed, &problem, &suggestion)
		if e != nil {
			return nil, e
		}
		args = append(args, nullable(q.Category), nullable(q.State), nullable(q.After), q.Limit+1)
		rows, e := tx.Query(ctx, `SELECT `+columns+` FROM `+source+` WHERE `+matching+`
		 AND ($6::text IS NULL OR CASE WHEN $6='unclassified' THEN f.category IS NULL ELSE f.category=$6 END)
		 AND ($7::text IS NULL OR f.state=$7) AND ($8::bigint IS NULL OR f.sequence<$8)
		 ORDER BY f.sequence DESC LIMIT $9`, args...)
		if e != nil {
			return nil, e
		}
		items := []Object{}
		var last int64
		var after any
		for rows.Next() {
			r, e := scan(rows)
			if e != nil {
				rows.Close()
				return nil, e
			}
			if len(items) == q.Limit {
				after = strconv.FormatInt(last, 10)
				break
			}
			items = append(items, r.item())
			last = r.sequence
		}
		rows.Close()
		if e = rows.Err(); e != nil {
			return nil, e
		}
		return Object{"items": items, "nextAfter": after, "summary": Object{"total": total, "unclassified": unclassified, "pending": pending, "closed": closed, "byCategory": []Object{{"category": nil, "count": unclassified}, {"category": "problem", "count": problem}, {"category": "suggestion", "count": suggestion}}}, "permissions": Object{"canManage": a.CanManage}, "checkedAt": now.Unix()}, nil
	})
}
func daysValue(s string) any {
	if s == "all" {
		return s
	}
	n, _ := strconv.Atoi(s)
	return n
}
func (s *Service) Get(ctx context.Context, operator, id, after string) (Object, error) {
	if !uuidPattern.MatchString(id) || !sequenceValid(after) {
		return nil, invalid()
	}
	return s.read(ctx, operator, "feedback-read", Object{"id": id, "resourceId": id, "historyAfter": nullable(after)}, func(tx pgx.Tx, a Operator) (Object, error) { return s.detail(ctx, tx, a, id, after) })
}
func (s *Service) detail(ctx context.Context, tx pgx.Tx, a Operator, id, after string) (Object, error) {
	r, e := s.head(ctx, tx, id, false)
	if e != nil {
		return nil, e
	}
	rows, e := tx.Query(ctx, `SELECT e.id::text,e.sequence,e.kind,e.operator_id,p.display_name,e.category,e.module,e.state,e.note,e.created_at
	 FROM operations_feedback_events_v1 e LEFT JOIN operations_operator_principals_v1 p ON p.endpoint=e.endpoint AND p.operator_id=e.operator_id
	 WHERE e.endpoint=$1 AND e.feedback_id=$2 AND ($3::bigint IS NULL OR e.sequence<$3) ORDER BY e.sequence DESC LIMIT 51`, s.Endpoint, id, nullable(after))
	if e != nil {
		return nil, e
	}
	history := []Object{}
	var last int64
	var next any
	for rows.Next() {
		var event, kind, module, state string
		var operator, name, category, note *string
		var seq int64
		var at time.Time
		if e = rows.Scan(&event, &seq, &kind, &operator, &name, &category, &module, &state, &note, &at); e != nil {
			rows.Close()
			return nil, e
		}
		if operator == nil || protocol.TextLength(*operator) > 256 || strings.HasPrefix(*operator, "executor:") {
			name = nil
		} else if name != nil {
			current := feedbackTrim(*name)
			name = &current
			if current == "" {
				name = nil
			}
		}
		if len(history) == 50 {
			next = strconv.FormatInt(last, 10)
			break
		}
		history = append(history, Object{"id": event, "sequence": strconv.FormatInt(seq, 10), "kind": kind, "operatorId": operator, "operatorDisplayName": name, "category": category, "module": module, "state": state, "note": note, "createdAt": iso(at)})
		last = seq
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return nil, e
	}
	attachments := []Object{}
	if r.attachmentCount > 0 {
		if s.Attachments == nil {
			return nil, fault.New("attachment_service_unavailable", 503)
		}
		attachments, e = s.Attachments.List(ctx, tx, id)
		if e != nil {
			return nil, e
		}
	}
	f := r.item()
	f["body"] = r.body
	f["submittedCategory"] = r.submittedCategory
	f["submittedModule"] = r.submittedModule
	f["attachments"] = attachments
	return Object{"feedback": f, "history": Object{"items": history, "nextAfter": next}, "permissions": Object{"canManage": a.CanManage}, "checkedAt": s.now().Unix()}, nil
}
