package native

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"unicode/utf8"
)

func hostWithoutComments(text string) (string, error) {
	raw := []byte(text)
	clean := append([]byte{}, raw...)
	quoted, escaped := false, false
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if quoted {
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				quoted = false
			}
			continue
		}
		if c == '"' {
			quoted = true
			continue
		}
		if c != '/' || i+1 == len(raw) {
			continue
		}
		if raw[i+1] == '/' {
			clean[i], clean[i+1] = ' ', ' '
			i += 2
			for i < len(raw) && raw[i] != '\n' {
				clean[i] = ' '
				i++
			}
			i--
			continue
		}
		if raw[i+1] == '*' {
			clean[i], clean[i+1] = ' ', ' '
			i += 2
			for i+1 < len(raw) && (raw[i] != '*' || raw[i+1] != '/') {
				if raw[i] != '\n' && raw[i] != '\r' {
					clean[i] = ' '
				}
				i++
			}
			if i+1 >= len(raw) {
				return "", hostConfigurationFailure("setup_opencode_config_invalid")
			}
			clean[i], clean[i+1] = ' ', ' '
			i++
		}
	}
	if quoted {
		return "", hostConfigurationFailure("setup_opencode_config_invalid")
	}
	return string(clean), nil
}
func hostSpace(raw string, index int) int {
	if index >= len(raw) {
		return 0
	}
	r, size := utf8.DecodeRuneInString(raw[index:])
	if uploadTrim(string(r)) == "" {
		return size
	}
	return 0
}
func hostSkip(raw string, index int) int {
	for index < len(raw) {
		n := hostSpace(raw, index)
		if n == 0 {
			break
		}
		index += n
	}
	return index
}
func hostConfigurationObject(text string) (map[string]any, error) {
	clean, e := hostWithoutComments(text)
	if e != nil {
		return nil, e
	}
	raw := []byte(clean)
	quoted, escaped := false, false
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if quoted {
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				quoted = false
			}
			continue
		}
		if c == '"' {
			quoted = true
			continue
		}
		if c == ',' {
			next := hostSkip(clean, i+1)
			if next < len(raw) && (raw[next] == '}' || raw[next] == ']') {
				raw[i] = ' '
			}
		}
	}
	// JSONC permits the source's JS whitespace/BOM around tokens. Replace only
	// whitespace outside quoted JSON, retaining offsets for surgical edits.
	quoted, escaped = false, false
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if quoted {
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				quoted = false
			}
			continue
		}
		if c == '"' {
			quoted = true
			continue
		}
		if n := hostSpace(string(raw), i); n > 0 {
			for j := 0; j < n; j++ {
				raw[i+j] = ' '
			}
			i += n - 1
		}
	}
	var result map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&result) != nil || result == nil {
		return nil, hostConfigurationFailure("setup_opencode_config_invalid")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, hostConfigurationFailure("setup_opencode_config_invalid")
	}
	return result, nil
}

type hostConfigMember struct {
	key        string
	begin, end int
}

func hostValueEnd(text string, start int) int {
	quoted, escaped := false, false
	depth := 0
	for i := start; i < len(text); i++ {
		c := text[i]
		if quoted {
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				quoted = false
			}
			continue
		}
		if c == '"' {
			quoted = true
			continue
		}
		if c == '{' || c == '[' {
			depth++
			continue
		}
		if c == '}' || c == ']' {
			if depth == 0 {
				return i
			}
			depth--
			if depth == 0 {
				return i + 1
			}
			continue
		}
		if depth == 0 && (c == ',' || hostSpace(text, i) > 0) {
			return i
		}
	}
	return len(text)
}
func hostMembers(clean string, start int) ([]hostConfigMember, int, error) {
	found := []hostConfigMember{}
	for index := start + 1; index < len(clean); {
		index = hostSkip(clean, index)
		for index < len(clean) && clean[index] == ',' {
			index = hostSkip(clean, index+1)
		}
		if index < len(clean) && clean[index] == '}' {
			return found, index, nil
		}
		keyStart := index
		if index >= len(clean) || clean[index] != '"' {
			break
		}
		index++
		for index < len(clean) {
			if clean[index] == '\\' {
				index += 2
				continue
			}
			if clean[index] == '"' {
				index++
				break
			}
			index++
		}
		var key string
		if json.Unmarshal([]byte(clean[keyStart:index]), &key) != nil {
			break
		}
		index = hostSkip(clean, index)
		if index >= len(clean) || clean[index] != ':' {
			break
		}
		index = hostSkip(clean, index+1)
		end := hostValueEnd(clean, index)
		found = append(found, hostConfigMember{key, index, end})
		index = end
	}
	return nil, 0, hostConfigurationFailure("setup_opencode_config_invalid")
}
func hostSetConfiguration(text string, path []string, value any) (string, error) {
	clean, e := hostWithoutComments(text)
	if e != nil {
		return "", e
	}
	return hostSetAt(text, clean, path, value, strings.Index(clean, "{"))
}
func hostSetAt(text, clean string, path []string, value any, start int) (string, error) {
	if start < 0 || len(path) == 0 {
		return "", hostConfigurationFailure("setup_opencode_config_invalid")
	}
	members, end, e := hostMembers(clean, start)
	if e != nil {
		return "", e
	}
	var member *hostConfigMember
	for i := range members {
		if members[i].key == path[0] {
			member = &members[i]
		}
	}
	if member != nil && len(path) > 1 {
		if text[member.begin] != '{' {
			return "", hostConfigurationFailure("setup_opencode_config_conflict")
		}
		return hostSetAt(text, clean, path[1:], value, member.begin)
	}
	nested := value
	for i := len(path) - 1; i >= 1; i-- {
		nested = map[string]any{path[i]: nested}
	}
	pretty, e := hostJSON(nested)
	if e != nil {
		return "", e
	}
	encoded := strings.TrimSuffix(string(pretty), "\n")
	if member != nil {
		return text[:member.begin] + encoded + text[member.end:], nil
	}
	head := text[:end]
	if len(members) > 0 {
		last := members[len(members)-1]
		if !strings.Contains(clean[last.end:end], ",") {
			head = head[:last.end] + "," + head[last.end:]
		}
	}
	line := strings.LastIndex(text[:end], "\n") + 1
	indent := text[line:end]
	if uploadTrim(indent) != "" {
		indent = ""
	}
	if !strings.HasSuffix(head, "\n") {
		head += "\n"
	}
	return head + indent + "  " + hostJSONString(path[0]) + ": " + strings.ReplaceAll(encoded, "\n", "\n"+indent+"  ") + "\n" + indent + text[end:], nil
}
