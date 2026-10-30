package discovery

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Source interface {
	Load(context.Context, Reference) (*Document, error)
	Candidates(context.Context, string, int) ([]Reference, error)
}
type CommunitySource struct {
	Pool     *pgxpool.Pool
	Forum    *community.Service
	Endpoint string
	Worker   bool
}

func (s *CommunitySource) Load(ctx context.Context, r Reference) (*Document, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	d, e := s.LoadWithin(ctx, tx, r)
	if e != nil {
		return nil, e
	}
	return d, tx.Commit(ctx)
}
func (s *CommunitySource) LoadWithin(ctx context.Context, tx pgx.Tx, r Reference) (*Document, error) {
	key, e := ItemKey(r)
	if e != nil {
		return nil, e
	}
	view, e := s.Forum.ReadPublicDiscoveryWithin(ctx, tx, r.Kind, r.ID, s.Worker)
	if e != nil {
		switch fault.Status(e) {
		case 401, 403, 404, 409, 410, 422:
			return nil, nil
		}
		return nil, e
	}
	if str(view, "availability") != "available" || r.Kind == "reply" && str(view, "parentAvailability") != "available" {
		return nil, nil
	}
	var author *string
	if id := str(view, "authorAccountId"); id != "" {
		var exists bool
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM community_accounts WHERE id=$1 AND endpoint=$2)", id, s.Endpoint).Scan(&exists); e != nil {
			return nil, e
		}
		if !exists {
			return nil, nil
		}
		author = &id
	}
	return documentFromView(key, r, view, author)
}
func documentFromView(key string, r Reference, view Object, author *string) (*Document, error) {
	payload := object(view["payload"])
	curation := object(view["operatorCuration"])
	version := str(view, "currentVersionId")
	post := r.ID
	title := str(payload, "title")
	if r.Kind == "reply" {
		revision, ok := integer(view["revision"])
		if !ok {
			return nil, fail("discovery_source_invalid")
		}
		version = strconv.FormatInt(revision, 10)
		post = str(object(view["locator"]), "postId")
		title = ""
	}
	body, ok := payload["body"].(string)
	if !ok {
		return nil, fail("discovery_source_invalid")
	}
	tags := []string{}
	ids := []string{}
	switch values := curation["tags"].(type) {
	case []any:
		for _, tag := range values {
			if text, ok := tag.(string); ok {
				tags = append(tags, text)
			} else if v := object(tag); v != nil {
				if text, ok := v["name"].(string); ok {
					tags = append(tags, text)
				}
				if id, ok := v["id"].(string); ok {
					ids = append(ids, id)
				}
			}
		}
	case []string:
		tags = append(tags, values...)
	}
	if values, ok := curation["tagIds"].([]any); ok {
		ids = []string{}
		for _, value := range values {
			if id, ok := value.(string); ok {
				ids = append(ids, id)
			}
		}
	} else if values, ok := curation["tagIds"].([]string); ok {
		ids = append([]string{}, values...)
	}
	published, _ := integer(view["createdAt"])
	until, _ := integer(view["publishedUntil"])
	topic := str(view, "topic")
	if topic == "" {
		topic = "unclassified"
	}
	d := &Document{ID: key, Kind: r.Kind, SourceID: r.ID, Version: version, PostID: post, AuthorAccountID: author, Title: title, Body: body, Topic: topic, Tags: tags, TagIDs: ids, PublishedAt: published, PublishedUntil: until}
	projection := protocol.NewOrderedObject()
	for _, entry := range []struct {
		k string
		v any
	}{{"version", version}, {"title", title}, {"body", body}, {"topic", topic}, {"tags", tags}, {"publishedUntil", until}} {
		projection.Set(entry.k, entry.v)
	}
	raw, e := protocol.EncodeJS(projection)
	if e != nil {
		return nil, e
	}
	digest := sha256.Sum256(raw)
	d.IndexVersion = hex.EncodeToString(digest[:])
	return d, nil
}
func (s *CommunitySource) Candidates(ctx context.Context, after string, limit int) ([]Reference, error) {
	return sourceCandidates(ctx, s.Pool, after, limit)
}

type candidateReader interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func sourceCandidates(ctx context.Context, db candidateReader, after string, limit int) ([]Reference, error) {
	if limit < 1 || limit > 200 {
		return nil, invalid()
	}
	kind := ""
	var id any
	if after != "" {
		parts := strings.Split(after, ":")
		if len(parts) != 2 || (parts[0] != "post" && parts[0] != "reply") || len(parts[1]) != 36 {
			return nil, invalid()
		}
		kind = parts[0]
		id = parts[1]
	}
	rows, e := db.Query(ctx, `SELECT kind,id::text FROM (SELECT 'post' AS kind,id FROM forum_posts_v1 UNION ALL SELECT 'reply',id FROM forum_replies_v1) s WHERE kind>$1 OR kind=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY kind,id LIMIT $3`, kind, id, limit)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Reference{}
	for rows.Next() {
		var r Reference
		if e = rows.Scan(&r.Kind, &r.ID); e != nil {
			return nil, e
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

type Snapshot struct {
	Documents   []*Document `json:"documents"`
	Complete    bool        `json:"complete"`
	Scanned     int         `json:"scanned"`
	StartedAt   int64       `json:"startedAt"`
	CompletedAt int64       `json:"completedAt"`
}

func (s *CommunitySource) QualifiedSnapshot(ctx context.Context) (Snapshot, error) {
	tx, e := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if e != nil {
		return Snapshot{}, e
	}
	defer tx.Rollback(context.Background())
	clock := func() int64 {
		if s.Forum.Now != nil {
			return s.Forum.Now().Unix()
		}
		return time.Now().Unix()
	}
	result := Snapshot{Documents: []*Document{}, Complete: true, StartedAt: clock()}
	after := ""
	for {
		refs, err := sourceCandidates(ctx, tx, after, 100)
		if err != nil {
			return Snapshot{}, err
		}
		if len(refs) == 0 {
			break
		}
		inputs := make([]community.DiscoveryReference, 0, len(refs))
		for _, ref := range refs {
			inputs = append(inputs, community.DiscoveryReference{Kind: ref.Kind, ID: ref.ID})
		}
		views, err := s.Forum.ReadPublicDiscoveryBatchWithin(ctx, tx, inputs)
		if err != nil {
			return Snapshot{}, err
		}
		if len(views) != len(refs) {
			return Snapshot{}, fail("discovery_source_invalid")
		}
		for i, view := range views {
			if view == nil {
				continue
			}
			ref := refs[i]
			key, e := ItemKey(ref)
			if e != nil {
				return Snapshot{}, e
			}
			var author *string
			if id := str(view, "authorAccountId"); id != "" {
				author = &id
			}
			document, e := documentFromView(key, ref, view, author)
			if e != nil {
				return Snapshot{}, e
			}
			if document != nil {
				result.Documents = append(result.Documents, document)
			}
		}
		result.Scanned += len(refs)
		last := refs[len(refs)-1]
		after = last.Kind + ":" + last.ID
		if len(refs) < 100 {
			break
		}
	}
	result.CompletedAt = clock()
	return result, tx.Commit(ctx)
}

var fenceOpen = regexp.MustCompile("^[\\t ]{0,3}```([A-Za-z0-9_+#.-]{1,32})?[\\t ]*$")
var fenceClose = regexp.MustCompile("^[\\t ]{0,3}```[\\t ]*$")

func bodyExcerpt(body string) string {
	lines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(body, "\r\n", "\n"), "\r", "\n"), "\n")
	for i := 0; i < len(lines); i++ {
		if !fenceOpen.MatchString(lines[i]) {
			continue
		}
		end := i + 1
		for end < len(lines) && !fenceClose.MatchString(lines[end]) {
			end++
		}
		if end == len(lines) {
			break
		}
		lines[i] = ""
		lines[end] = ""
		i = end
	}
	return strings.Join(strings.FieldsFunc(strings.Join(lines, "\n"), jsSpace), " ")
}
func View(d *Document) Object {
	excerpt := []rune(bodyExcerpt(d.Body))
	if len(excerpt) > 220 {
		excerpt = excerpt[:220]
	}
	path := "posts/"
	if d.Kind == "reply" {
		path = "replies/"
	}
	return Object{"kind": d.Kind, "id": d.SourceID, "postId": d.PostID, "version": d.Version, "title": d.Title, "excerpt": string(excerpt), "topic": d.Topic, "publishedUntil": d.PublishedUntil, "href": "/app/community/" + path + url.PathEscape(d.SourceID), "source": "current-public-community"}
}
