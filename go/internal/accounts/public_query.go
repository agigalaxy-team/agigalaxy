package accounts

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

type Provider struct{ Issuer, ClientID string }

// PublicPageConsumer is the existing domain's publicForAccount contract. The
// credential consumer must reverify signature/binding/current status and never
// return raw credentials; the forum consumer owns source audience and cursors.
type PublicPageConsumer func(context.Context, pgx.Tx, string, []byte) (Object, error)
type PublicQueries struct {
	Service            *Service
	Providers          []Provider
	CurrentProviders   func() []Provider
	Credentials, Posts PublicPageConsumer
}
type publicPage struct {
	After *string `json:"after,omitempty"`
	Limit int     `json:"limit"`
}

var subjectPattern = regexp.MustCompile(`^GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$`)
var postsCursorPattern = regexp.MustCompile(`^fp1\.[A-Za-z0-9_-]+$`)

func queryInvalid() error { return fault.New("invalid_account_query", 400) }
func parsePublicPage(raw []byte, kind string) (publicPage, error) {
	var wire struct {
		After *string         `json:"after"`
		Limit json.RawMessage `json:"limit"`
	}
	var fields map[string]json.RawMessage
	if protocol.Decode(raw, &fields) != nil || fields == nil || protocol.Decode(raw, &wire) != nil || !nonnull(fields, "after", "limit") {
		return publicPage{}, queryInvalid()
	}
	page := publicPage{After: wire.After, Limit: 20}
	if _, ok := fields["limit"]; ok {
		n, e := integer(wire.Limit, 1, 50)
		if e != nil {
			return page, queryInvalid()
		}
		page.Limit = int(n)
	}
	if page.After != nil {
		valid := false
		switch kind {
		case "ids":
			valid = subjectPattern.MatchString(*page.After)
		case "posts":
			valid = len(*page.After) <= 512 && postsCursorPattern.MatchString(*page.After)
		default:
			valid = uuidPattern.MatchString(*page.After)
		}
		if !valid {
			return page, queryInvalid()
		}
	}
	return page, nil
}
func (q *PublicQueries) providersJSON() []byte {
	providers := q.Providers
	if q.CurrentProviders != nil {
		providers = q.CurrentProviders()
	}
	pairs := make([][2]string, 0, len(providers))
	for _, provider := range providers {
		pairs = append(pairs, [2]string{provider.Issuer, provider.ClientID})
	}
	raw, _ := json.Marshal(pairs)
	return raw
}
func (q *PublicQueries) enabledWithin(ctx context.Context, tx pgx.Tx, id, kind string) error {
	if !uuidPattern.MatchString(id) {
		return queryInvalid()
	}
	row, e := q.Service.readProfile(ctx, tx, id)
	if errors.Is(e, pgx.ErrNoRows) || e == nil && (!row.QueryEnabled || kind == "ids" && !row.ShowLinkedIDs || kind == "credentials" && !row.ShowExternalCredentials) {
		return fault.New("not_found", 404)
	}
	return e
}
func (q *PublicQueries) LinkedIDsWithin(ctx context.Context, tx pgx.Tx, account string, raw []byte) (Object, error) {
	page, e := parsePublicPage(raw, "ids")
	if e != nil {
		return nil, e
	}
	if e = q.enabledWithin(ctx, tx, account, "ids"); e != nil {
		return nil, e
	}
	rows, e := tx.Query(ctx, `SELECT l.subject_id,MIN(l.created_at) FROM community_account_links g JOIN community_accounts a ON a.id=g.account_id JOIN external_identity_links l ON l.id=g.identity_link_id AND l.subject_id=g.subject_id WHERE a.id=$1 AND a.endpoint=$2 AND l.endpoint=$2 AND l.issuer=a.issuer AND l.external_subject=a.external_subject AND l.revoked_at IS NULL AND ($3::text IS NULL OR l.subject_id>$3) AND EXISTS(SELECT 1 FROM jsonb_array_elements($4::jsonb) provider WHERE provider->>0=l.issuer AND provider->>1=l.client_id) GROUP BY l.subject_id ORDER BY l.subject_id LIMIT $5`, account, q.Service.Endpoint, page.After, q.providersJSON(), page.Limit+1)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	items := []Object{}
	var next any
	for rows.Next() {
		var id string
		var at time.Time
		if e = rows.Scan(&id, &at); e != nil {
			return nil, e
		}
		if len(items) == page.Limit {
			next = items[len(items)-1]["subjectId"]
			break
		}
		items = append(items, Object{"subjectId": id, "linkedAt": iso(at)})
	}
	if e = rows.Err(); e != nil {
		return nil, e
	}
	return Object{"accountId": account, "items": items, "nextAfter": next, "checkedAt": q.Service.now().Unix()}, nil
}
func (q *PublicQueries) AccountsForIDWithin(ctx context.Context, tx pgx.Tx, subject string, raw []byte) (Object, error) {
	if !subjectPattern.MatchString(subject) {
		return nil, queryInvalid()
	}
	page, e := parsePublicPage(raw, "accounts")
	if e != nil {
		return nil, e
	}
	rows, e := tx.Query(ctx, `SELECT a.id::text,a.uid,p.display_name,p.subject_type,p.query_scope,p.query_linked_ids,p.query_external_credentials,MIN(l.created_at),(SELECT h.actor_kind FROM official_account_type_history_v1 h WHERE h.account_id=a.id ORDER BY h.revision DESC LIMIT 1) FROM community_account_links g JOIN community_accounts a ON a.id=g.account_id JOIN official_account_profiles_v1 p ON p.account_id=a.id AND p.query_enabled=true AND p.query_linked_ids=true JOIN external_identity_links l ON l.id=g.identity_link_id AND l.subject_id=g.subject_id WHERE g.subject_id=$1 AND a.endpoint=$2 AND l.endpoint=$2 AND l.issuer=a.issuer AND l.external_subject=a.external_subject AND l.revoked_at IS NULL AND ($3::uuid IS NULL OR a.id>$3) AND EXISTS(SELECT 1 FROM jsonb_array_elements($4::jsonb) provider WHERE provider->>0=l.issuer AND provider->>1=l.client_id) GROUP BY a.id,p.account_id ORDER BY a.id LIMIT $5`, subject, q.Service.Endpoint, page.After, q.providersJSON(), page.Limit+1)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	items := []Object{}
	var next any
	for rows.Next() {
		var id, uid, scope string
		var name, kind, actor *string
		var linked, credentials bool
		var at time.Time
		if e = rows.Scan(&id, &uid, &name, &kind, &scope, &linked, &credentials, &at, &actor); e != nil {
			return nil, e
		}
		if len(items) == page.Limit {
			next = items[len(items)-1]["accountId"]
			break
		}
		source := "account-owner-statement"
		if actor != nil && *actor == "business-operator" {
			source = "operator-recorded-statement"
		}
		items = append(items, Object{"accountId": id, "uid": uid, "displayName": name, "subjectType": kind, "typeSource": source, "linkedAt": iso(at), "publicQuery": Object{"scope": scope, "showLinkedIds": linked, "showExternalCredentials": credentials}})
	}
	if e = rows.Err(); e != nil {
		return nil, e
	}
	return Object{"subjectId": subject, "items": items, "nextAfter": next, "checkedAt": q.Service.now().Unix()}, nil
}
func (q *PublicQueries) CredentialsWithin(ctx context.Context, tx pgx.Tx, account string, raw []byte) (Object, error) {
	page, e := parsePublicPage(raw, "credentials")
	if e != nil {
		return nil, e
	}
	if e = q.enabledWithin(ctx, tx, account, "credentials"); e != nil {
		return nil, e
	}
	if q.Credentials == nil {
		return nil, fault.New("external_credentials_unavailable", 503)
	}
	normalized, _ := json.Marshal(page)
	return q.Credentials(ctx, tx, account, normalized)
}
func (q *PublicQueries) PostsWithin(ctx context.Context, tx pgx.Tx, account string, raw []byte) (Object, error) {
	page, e := parsePublicPage(raw, "posts")
	if e != nil {
		return nil, e
	}
	profile, e := q.Service.PublicProfileWithin(ctx, tx, account, nil)
	if e != nil {
		return nil, e
	}
	if profile["publicQuery"].(Object)["scope"] != "profile-and-public-posts" {
		return nil, fault.New("not_found", 404)
	}
	if q.Posts == nil {
		return nil, fault.New("forum_unavailable", 503)
	}
	normalized, _ := json.Marshal(page)
	return q.Posts(ctx, tx, account, normalized)
}
