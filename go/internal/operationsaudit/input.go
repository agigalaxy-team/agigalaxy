package operationsaudit

import (
	"math"
	"slices"
	"strconv"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func fail(code string, status int) error { return fault.New(code, status) }
func invalid() error                     { return fail("invalid_business_admin_request", 400) }

// Parse preserves the two original, mutually exclusive pagination contracts.
func Parse(input Object) (Object, error) {
	if input == nil {
		input = Object{}
	}
	q := Object{}
	for key, value := range input {
		if !slices.Contains([]string{"accountId", "resourceId", "after", "action", "kind", "day", "query", "limit", "page", "pageSize", "snapshot", "sort"}, key) {
			return nil, invalid()
		}
		q[key] = value
	}
	for _, key := range []string{"accountId", "resourceId", "snapshot"} {
		if v, present := q[key]; present && !validFormat(v, "uuid") {
			return nil, invalid()
		}
	}
	if value, present := q["after"]; present {
		if !matchPattern(`^[1-9][0-9]{0,18}$`, str(value)) {
			return nil, invalid()
		}
		if _, e := strconv.ParseInt(str(value), 10, 64); e != nil {
			return nil, invalid()
		}
	}
	if value, present := q["action"]; present {
		if !matchPattern(`^[a-z][a-z0-9-]{0,79}$`, str(value)) && !slices.Contains([]string{"recommendations.configure", "search-quality.configure", "search-quality.publish", "search-quality.restore", "models.configure", "models.apply", "strategies.configure", "strategies.publish", "strategies.control", "strategies.run", "strategies.ordinary.configure", "strategies.ordinary.publish"}, str(value)) {
			return nil, invalid()
		}
	}
	if value, present := q["kind"]; present {
		if !slices.Contains([]string{"all", "business", "reads"}, str(value)) {
			return nil, invalid()
		}
	} else {
		q["kind"] = "all"
	}
	if value, present := q["day"]; present {
		v, ok := value.(string)
		if !ok || !validDay(v) || len(v) != 10 || v[:4] == "0000" {
			return nil, invalid()
		}
	}
	if value, present := q["query"]; present {
		v, ok := value.(string)
		if !ok {
			return nil, invalid()
		}
		v = trim(v)
		if utf8.RuneCountInString(v) > 160 {
			return nil, invalid()
		}
		q["query"] = v
	} else {
		q["query"] = ""
	}
	for _, entry := range []struct {
		key string
		max float64
	}{{"limit", 100}, {"page", 1000000}, {"pageSize", 100}} {
		if value, present := q[entry.key]; present {
			n, ok := numeric(value)
			if !ok || n < 1 || n > entry.max || math.Trunc(n) != n {
				return nil, invalid()
			}
			if entry.key == "pageSize" && !slices.Contains([]float64{20, 30, 50, 100}, n) {
				return nil, invalid()
			}
			q[entry.key] = int(n)
		}
	}
	if value, present := q["sort"]; present {
		if !slices.Contains([]string{"newest", "oldest"}, str(value)) {
			return nil, invalid()
		}
	}
	page := false
	for _, key := range []string{"page", "pageSize", "snapshot", "sort"} {
		if _, present := q[key]; present {
			page = true
		}
	}
	if page {
		if _, present := q["after"]; present {
			return nil, invalid()
		}
		if _, present := q["limit"]; present {
			return nil, invalid()
		}
	}
	return q, nil
}
