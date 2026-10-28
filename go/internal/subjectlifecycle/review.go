package subjectlifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	whatwg "github.com/nlnwa/whatwg-url/url"
	"strings"
	"unicode"
)

type ReviewCommand struct {
	Version          int           `json:"version"`
	ID               string        `json:"id"`
	RequestID        string        `json:"requestId"`
	Endpoint         string        `json:"endpoint"`
	ExpectedRevision int64         `json:"expectedRevision"`
	ReviewerRef      string        `json:"reviewerRef"`
	Decision         string        `json:"decision"`
	Explanation      string        `json:"explanation"`
	Plan             *DeletionPlan `json:"plan,omitempty"`
}

func parseReview(raw []byte) (ReviewCommand, error) {
	var c ReviewCommand
	if protocol.Decode(raw, &c) != nil {
		return c, errors.New("invalid deletion review")
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return c, errors.New("invalid deletion review")
	}
	_, hasPlan := fields["plan"]
	if c.Version != 1 || !validID(c.ID) || !validID(c.RequestID) || c.ExpectedRevision < 1 || c.ExpectedRevision > 9007199254740991 || !operatorRef.MatchString(c.ReviewerRef) || !contains([]string{"needs-information", "approve", "reject"}, c.Decision) || !validBasis(c.Explanation, 2000) || (c.Decision == "approve") != (c.Plan != nil) || hasPlan != (c.Plan != nil) {
		return c, errors.New("invalid deletion review")
	}
	if c.Plan != nil && (!validPlan(*c.Plan) || !validReviewFields(raw)) {
		return c, errors.New("invalid deletion review plan")
	}
	c.Endpoint = strings.TrimFunc(c.Endpoint, func(r rune) bool {
		return r == '\ufeff' || unicode.Is(unicode.Zs, r) || r == '\t' || r == '\n' || r == '\r' || r == '\v' || r == '\f' || r == '\u2028' || r == '\u2029'
	})
	if _, e := whatwg.Parse(c.Endpoint); e != nil {
		return c, errors.New("invalid deletion review endpoint")
	}
	c.Endpoint = strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(c.Endpoint)
	return c, nil
}

// ReviewDeletionWithin is the original maintenance/review-connection consumer.
// It is never exposed as an end-user route or an actor supplied by headers.
func ReviewDeletionWithin(ctx context.Context, tx pgx.Tx, raw []byte) (Object, error) {
	c, e := parseReview(raw)
	if e != nil {
		return nil, e
	}
	payload, e := protocol.EncodeJS(c)
	if e != nil {
		return nil, e
	}
	hash := identity.Digest(payload)
	row, e := one(ctx, tx, `SELECT * FROM deletion_requests WHERE id=$1 FOR UPDATE`, c.RequestID)
	if e != nil {
		return nil, e
	}
	var intent Object
	if json.Unmarshal([]byte(text(row["payload_text"])), &intent) != nil || intent["endpoint"] != c.Endpoint {
		return nil, errors.New("deletion review target mismatch")
	}
	prior, e := one(ctx, tx, `SELECT request_id,payload_hash FROM deletion_events WHERE id=$1`, c.ID)
	if e == nil {
		if prior["request_id"] != row["id"] || prior["payload_hash"] != hash {
			return nil, errors.New("deletion review conflict")
		}
		return deletionReceipt(row, c.Endpoint), nil
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return nil, e
	}
	if integer(row["revision"]) != c.ExpectedRevision || !contains([]string{"requested", "review-needed"}, text(row["state"])) {
		return nil, errors.New("deletion request changed")
	}
	state := map[string]string{"needs-information": "review-needed", "approve": "approved", "reject": "rejected"}[c.Decision]
	updated, e := one(ctx, tx, `UPDATE deletion_requests SET state=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`, row["id"], state)
	if e != nil {
		return nil, e
	}
	if _, e = tx.Exec(ctx, `INSERT INTO deletion_events(id,request_id,revision,actor_kind,actor_ref,kind,payload_text,payload_hash) VALUES($1,$2,$3,'operator',$4,$5,$6,$7)`, c.ID, row["id"], updated["revision"], c.ReviewerRef, c.Decision, string(payload), hash); e != nil {
		return nil, e
	}
	return deletionReceipt(updated, c.Endpoint), nil
}
