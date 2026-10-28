package businessadmin

import (
	"context"
	"github.com/jackc/pgx/v5"
	"strings"
)

// NamesWithin resolves labels for already-authorized immutable actor IDs. It
// is neither a directory query nor a substitute for current principal proof.
func (d *Domain) NamesWithin(ctx context.Context, tx pgx.Tx, ids []string) (map[string]any, error) {
	filtered := []string{}
	for _, id := range ids {
		if id == "" || len(id) > 256 || strings.HasPrefix(id, "executor:") {
			continue
		}
		found := false
		for _, v := range filtered {
			found = found || v == id
		}
		if !found {
			filtered = append(filtered, id)
		}
	}
	out := map[string]any{}
	if len(filtered) == 0 {
		return out, nil
	}
	rr, e := tx.Query(ctx, "SELECT operator_id,display_name FROM operations_operator_principals_v1 WHERE endpoint=$1 AND operator_id=ANY($2::text[])", d.Endpoint, filtered)
	if e != nil {
		return nil, e
	}
	defer rr.Close()
	for rr.Next() {
		var id string
		var name *string
		if e = rr.Scan(&id, &name); e != nil {
			return nil, e
		}
		var value any
		if name != nil {
			label := strings.TrimFunc(*name, func(r rune) bool {
				return r >= 9 && r <= 13 || r == 32 || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
			})
			if label != "" {
				value = label
			}
		}
		out[id] = value
	}
	return out, rr.Err()
}
