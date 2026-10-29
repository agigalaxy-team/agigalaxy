package operationscommunity

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

func trim(s string) string {
	return strings.Trim(s, "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
}
func parseContentWrite(input Object, kind string) (Object, error) {
	x := copyObject(input)
	keys := []string{"operationId", "expectedVersion", "expectedRevision", "reason"}
	switch kind {
	case "curation":
		keys = append(keys, "topic", "pinned", "featured", "tagIds")
	case "visibility":
		keys = append(keys, "kind", "until")
	}
	if !strict(x, keys...) || !validID(str(x, "operationId")) || !integer(x["expectedVersion"], 0, 2147483646) || !integer(x["expectedRevision"], 0, 2147483646) {
		return nil, invalid()
	}
	reason, ok := text(x["reason"])
	if !ok {
		return nil, invalid()
	}
	x["reason"] = reason
	if kind == "visibility" {
		hide := str(x, "kind") == "hide"
		if !hide && str(x, "kind") != "restore" {
			return nil, invalid()
		}
		_, until := x["until"]
		if hide != until || until && !integer(x["until"], 1, 9007199254740991) {
			return nil, invalid()
		}
		return x, nil
	}
	present := false
	for _, k := range []string{"topic", "pinned", "featured", "tagIds"} {
		v, ok := x[k]
		if !ok {
			continue
		}
		present = true
		switch k {
		case "topic":
			if v != nil && !has(categories, str(x, k)) {
				return nil, invalid()
			}
		case "pinned", "featured":
			if _, ok := v.(bool); !ok {
				return nil, invalid()
			}
		case "tagIds":
			ids, ok := v.([]any)
			if !ok || len(ids) > 8 {
				return nil, invalid()
			}
			seen := map[string]bool{}
			for _, v := range ids {
				id, ok := v.(string)
				if !ok || !validID(id) || seen[id] {
					return nil, invalid()
				}
				seen[id] = true
			}
		}
	}
	if !present {
		return nil, invalid()
	}
	return x, nil
}
func parseTag(input Object, creating bool) (Object, error) {
	x := copyObject(input)
	keys := []string{"operationId", "name"}
	if !creating {
		keys = append(keys, "expectedVersion", "enabled")
	}
	if !strict(x, keys...) || !validID(str(x, "operationId")) || !creating && !integer(x["expectedVersion"], 0, 2147483646) {
		return nil, invalid()
	}
	if v, ok := x["name"]; ok {
		s, ok := v.(string)
		if !ok {
			return nil, invalid()
		}
		s = trim(s)
		if utf8.RuneCountInString(s) < 1 || utf8.RuneCountInString(s) > 40 || strings.IndexFunc(s, unicode.IsControl) >= 0 {
			return nil, invalid()
		}
		x["name"] = s
	} else if creating {
		return nil, invalid()
	}
	if v, ok := x["enabled"]; ok {
		if _, ok := v.(bool); !ok {
			return nil, invalid()
		}
	}
	if !creating {
		_, name := x["name"]
		_, enabled := x["enabled"]
		if !name && !enabled {
			return nil, invalid()
		}
	}
	return x, nil
}
func parseBatch(input Object, preview bool) (Object, error) {
	x := copyObject(input)
	keys := []string{"kind", "until", "items"}
	if !preview {
		keys = append(keys, "operationId", "reason")
	}
	if !strict(x, keys...) || !has([]string{"hide", "restore"}, str(x, "kind")) {
		return nil, invalid()
	}
	_, until := x["until"]
	if (str(x, "kind") == "hide") != until || until && !integer(x["until"], 1, 9007199254740991) {
		return nil, invalid()
	}
	a, ok := x["items"].([]any)
	if !ok || len(a) < 1 || len(a) > 25 {
		return nil, invalid()
	}
	seen := map[string]bool{}
	for _, v := range a {
		item, ok := v.(map[string]any)
		if !ok || !strict(item, "kind", "id", "expectedVersion", "expectedRevision") || !has([]string{"post", "reply"}, str(item, "kind")) || !validID(str(item, "id")) || !integer(item["expectedVersion"], 0, 2147483646) || !integer(item["expectedRevision"], 0, 2147483646) {
			return nil, invalid()
		}
		key := str(item, "kind") + ":" + str(item, "id")
		if seen[key] {
			return nil, invalid()
		}
		seen[key] = true
	}
	if !preview {
		reason, ok := text(x["reason"])
		if !ok || !validID(str(x, "operationId")) {
			return nil, invalid()
		}
		x["reason"] = reason
	}
	return x, nil
}

// ParseTagCommand retains the owner's exact create/update validation.
func ParseTagCommand(input Object, creating bool) (Object, error) { return parseTag(input, creating) }
