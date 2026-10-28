package taskmaterials

import (
	"context"
	"regexp"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
	whatwg "github.com/nlnwa/whatwg-url/url"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

var commentLinks = regexp.MustCompile(`https?://[^\s<>]+`)
var commentMentions = regexp.MustCompile(`@(?:guid[0-9a-z]{28}|[\p{L}\p{N}_-]{2,64})`)

func NormalizeCommentURL(raw string) (string, error) {
	parsed, e := whatwg.Parse(raw)
	if e != nil {
		return "", e
	}
	parsed.SetHash("")
	return parsed.String(), nil
}

func (c *CommentService) fingerprints(body jsText) (Object, error) {
	normal := cases.Lower(language.Und).String(norm.NFKC.String(body.decoded()))
	normal = strings.Map(func(r rune) rune {
		if r >= 0x200b && r <= 0x200f || r == 0xfeff {
			return -1
		}
		return r
	}, normal)
	var out strings.Builder
	space := false
	for _, r := range normal {
		if r <= 0xffff && jsUnitSpace(uint16(r)) {
			space = true
			continue
		}
		if space && out.Len() > 0 {
			out.WriteByte(' ')
		}
		space = false
		out.WriteRune(r)
	}
	normal = out.String()
	links := []string{}
	for _, raw := range commentLinks.FindAllString(normal, -1) {
		raw = strings.TrimRight(raw, ".,，。)）")
		normalize := c.NormalizeURL
		if normalize == nil {
			normalize = NormalizeCommentURL
		}
		normalized, e := normalize(raw)
		if e != nil {
			continue
		}
		hash := identity.Digest([]byte(normalized))
		if !contains(links, hash) {
			links = append(links, hash)
		}
	}
	return Object{"text": identity.Digest([]byte(normal)), "links": links, "mentions": len(commentMentions.FindAllString(normal, -1))}, nil
}
func (c *CommentService) inspectCommentRules(ctx context.Context, tx pgx.Tx, account, current Object, body jsText) (Object, error) {
	policy := c.rules()
	fp, e := c.fingerprints(body)
	if e != nil {
		return nil, e
	}
	prior, e := rows(ctx, tx, `SELECT jsonb_build_object('id',c.id,'task_id',c.task_id,'text_fingerprint',e.text_fingerprint,'link_fingerprints',e.link_fingerprints) FROM task_comments_v2 c JOIN task_comment_events_v2 e ON e.comment_id=c.id WHERE c.account_id=$1 AND c.id<>$2 AND e.created_at>$3 AND e.erased_at IS NULL AND e.text_fingerprint IS NOT NULL`, account["id"], current["id"], stamp(c.now()-policy.DuplicateWindowSeconds))
	if e != nil {
		return nil, e
	}
	reasons := []string{}
	same := map[string]bool{}
	for _, p := range prior {
		if p["text_fingerprint"] == fp["text"] {
			same[str(p, "id")] = true
		}
	}
	if int64(len(same)+1) >= policy.DuplicateThreshold {
		reasons = append(reasons, "repeated-normalized-content")
	}
	for _, link := range stringsOf(fp["links"]) {
		tasks := map[string]bool{str(current, "task_id"): true}
		for _, p := range prior {
			if contains(stringsOf(p["link_fingerprints"]), link) {
				tasks[str(p, "task_id")] = true
			}
		}
		if int64(len(tasks)) >= policy.LinkTaskThreshold {
			reasons = append(reasons, "repeated-link-across-tasks")
			break
		}
	}
	if num(fp["mentions"]) > policy.MaxMentions {
		reasons = append(reasons, "bulk-mentions")
	}
	if num(current["revision"]) != 0 {
		held, e := c.heldWithin(ctx, tx, str(current, "id"), num(current["revision"]))
		if e != nil {
			return nil, e
		}
		if current["review_state"] == "rejected" || len(held) > 0 {
			reasons = append(reasons, "changed-after-moderation")
		}
	}
	state := "clear"
	if len(reasons) > 0 {
		state = "pending-review"
	}
	return Object{"fingerprints": fp, "reasons": reasons, "state": state}, nil
}
