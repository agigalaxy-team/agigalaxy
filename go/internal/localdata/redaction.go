// Package localdata excludes credentials and inline binary from local work material.
package localdata

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const Excluded = "[excluded credential]"

type Exclusion struct {
	Path string `json:"path"`
	Kind string `json:"kind"`
}
type Result struct {
	Value      any         `json:"value"`
	Exclusions []Exclusion `json:"exclusions"`
}
type Field struct {
	Key   string
	Value any
}

// Object retains JSON insertion order, which is significant for existing SQLite deduplication.
type Object []Field

func (o Object) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, f := range o {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := encode(f.Key)
		v, e := encode(f.Value)
		if e != nil {
			return nil, e
		}
		b.Write(k)
		b.WriteByte(':')
		b.Write(v)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}
func encode(v any) ([]byte, error) {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		return nil, err
	}
	// JSON.stringify emits literal U+2028/U+2029; encoding/json escapes them.
	raw := bytes.TrimSuffix(b.Bytes(), []byte("\n"))
	out := make([]byte, 0, len(raw))
	for i := 0; i < len(raw); i++ {
		if raw[i] == '\\' && i+1 < len(raw) {
			if i+6 <= len(raw) && (string(raw[i:i+6]) == `\u2028` || string(raw[i:i+6]) == `\u2029`) {
				if raw[i+5] == '8' {
					out = append(out, []byte("\u2028")...)
				} else {
					out = append(out, []byte("\u2029")...)
				}
				i += 5
				continue
			}
			out = append(out, raw[i], raw[i+1])
			i++
			continue
		}
		out = append(out, raw[i])
	}
	return out, nil
}
func Encode(v any) ([]byte, error) { return encode(v) }
func read(d *json.Decoder) (any, error) {
	t, e := d.Token()
	if e != nil {
		return nil, e
	}
	switch t {
	case json.Delim('{'):
		o := Object{}
		positions := map[string]int{}
		for d.More() {
			k, e := d.Token()
			if e != nil {
				return nil, e
			}
			v, e := read(d)
			if e != nil {
				return nil, e
			}
			key := k.(string)
			if index, ok := positions[key]; ok {
				o[index].Value = v
			} else {
				positions[key] = len(o)
				o = append(o, Field{key, v})
			}
		}
		_, e = d.Token()
		sort.SliceStable(o, func(i, j int) bool {
			a, ea := arrayIndex(o[i].Key)
			b, eb := arrayIndex(o[j].Key)
			if ea && eb {
				return a < b
			}
			return ea && !eb
		})
		return o, e
	case json.Delim('['):
		a := []any{}
		for d.More() {
			v, e := read(d)
			if e != nil {
				return nil, e
			}
			a = append(a, v)
		}
		_, e = d.Token()
		return a, e
	}
	if n, ok := t.(json.Number); ok {
		f, e := n.Float64()
		if e != nil {
			return nil, e
		}
		if f == 0 {
			return json.Number("0"), nil
		}
		format := byte('e')
		if (f >= 1e-6 && f < 1e21) || (f <= -1e-6 && f > -1e21) {
			format = 'f'
		}
		s := strconv.FormatFloat(f, format, -1, 64)
		s = strings.Replace(s, "e-0", "e-", 1)
		s = strings.Replace(s, "e+0", "e+", 1)
		return json.Number(s), nil
	}
	return t, nil
}
func arrayIndex(key string) (uint64, bool) {
	n, e := strconv.ParseUint(key, 10, 32)
	return n, e == nil && n < 4294967295 && strconv.FormatUint(n, 10) == key
}
func Parse(raw []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	v, e := read(d)
	if e != nil {
		return nil, e
	}
	if _, e = d.Token(); e != io.EOF {
		return nil, fmt.Errorf("local_data_invalid_json")
	}
	return v, nil
}
func RedactJSON(raw []byte) (Result, error) {
	v, e := Parse(raw)
	if e != nil {
		return Result{}, e
	}
	r := Result{Exclusions: []Exclusion{}}
	r.Value = r.walk(v, "$", 0)
	return r, nil
}
func Redact(v any) (Result, error) {
	raw, e := encode(v)
	if e != nil {
		return Result{}, e
	}
	return RedactJSON(raw)
}

var safeField = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$`)
var credentialField = regexp.MustCompile(`(?i)^(?:password|passwd|pwd|passphrase|secret|clientsecret|apikey|accesskey|secretaccesskey|accesskeyid|accesstoken|refreshtoken|idtoken|token|authorization|proxyauthorization|cookie|setcookie|privatekey|privatekeypem|credentials|credential|env|processenv|environmentvariables)$`)

// ECMAScript \s includes Unicode whitespace that Go's RE2 \s does not.
const ws = `[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`
const nws = `[^\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff},;"']+`

var privateKey = regexp.MustCompile(`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)`)
var token = regexp.MustCompile(`\b(?:Bearer` + ws + `+[A-Za-z0-9_.~+/-]{8,}=*|Basic` + ws + `+[A-Za-z0-9+/]{8,}={0,2}|github_pat_[A-Za-z0-9_]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16})\b`)
var assignment = regexp.MustCompile(`(?i)(["']?(?:password|passwd|passphrase|api[_ -]?key|secret[_ -]?access[_ -]?key|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|密码|口令|私钥)["']?` + ws + `*(?:[:=：]|\bis\b)` + ws + `*)("[^"\r\n]*"|'[^'\r\n]*'|` + nws + `)`)

func notSpace(extra string) string { return "[^" + ws[1:len(ws)-1] + extra + "]" }

var urlAuth = regexp.MustCompile(`(?i)\b([a-z][a-z0-9+.-]*://)` + notSpace("/@:") + `+:` + notSpace("/@") + `+@`)
var flag = regexp.MustCompile(`(?i)(--(?:api-key|password|passwd|token|client-secret|private-key)(?:=|` + ws + `+))("[^"\r\n]*"|'[^'\r\n]*'|` + nws + `)`)
var query = regexp.MustCompile(`(?i)([?&](?:token|key|api[_-]?key|access[_-]?token|client[_-]?secret)=)(` + notSpace("&#") + `+)`)
var inline = regexp.MustCompile(`(?i)^data:[^,]*;base64,`)
var whitespace = regexp.MustCompile("^" + ws + "$")

func (r *Result) omit(path, kind string) string {
	r.Exclusions = append(r.Exclusions, Exclusion{path, kind})
	return "[excluded " + kind + "]"
}
func (r *Result) text(v, path string) string {
	changed := false
	remove := func(string) string { changed = true; return Excluded }
	v = privateKey.ReplaceAllStringFunc(v, remove)
	v = token.ReplaceAllStringFunc(v, remove)
	for _, re := range []*regexp.Regexp{assignment, urlAuth, flag, query} {
		var b strings.Builder
		last := 0
		for _, m := range re.FindAllStringSubmatchIndex(v, -1) {
			b.WriteString(v[last:m[0]])
			last = m[1]
			prefix := v[m[2]:m[3]]
			if re == urlAuth {
				changed = true
				b.WriteString(prefix + Excluded + "@")
				continue
			}
			tail := v[m[3]:m[1]]
			if strings.HasPrefix(v[m[3]:], Excluded) || strings.Trim(tail, "\"'") == Excluded {
				b.WriteString(v[m[0]:m[1]])
				continue
			}
			changed = true
			b.WriteString(prefix + Excluded)
		}
		b.WriteString(v[last:])
		v = b.String()
	}
	if changed {
		r.Exclusions = append(r.Exclusions, Exclusion{path, "credential"})
	}
	if inline.MatchString(v) {
		return r.omit(path, "inline-binary")
	}
	return v
}
func (r *Result) walk(v any, path string, depth int) any {
	if depth > 48 {
		return r.omit(path, "depth-limit")
	}
	switch x := v.(type) {
	case string:
		return r.text(x, path)
	case Object:
		hasKty, hasSecret := false, false
		for _, f := range x {
			if f.Key == "kty" && truthy(f.Value) {
				hasKty = true
			}
			if f.Key == "d" || f.Key == "k" {
				hasSecret = true
			}
		}
		if hasKty && hasSecret {
			return r.omit(path, "credential")
		}
		o := Object{}
		for _, f := range x {
			key := f.Key
			if !safeField.MatchString(key) {
				key = "[field]"
			}
			p := path + "." + key
			canonical := strings.Map(func(c rune) rune {
				if c == '-' || c == '_' || whitespace.MatchString(string(c)) {
					return -1
				}
				return c
			}, f.Key)
			if credentialField.MatchString(canonical) && f.Value != Excluded {
				o = append(o, Field{f.Key, r.omit(p, "credential")})
			} else {
				o = append(o, Field{f.Key, r.walk(f.Value, p, depth+1)})
			}
		}
		return o
	case []any:
		a := make([]any, len(x))
		for i, v := range x {
			a[i] = r.walk(v, fmt.Sprintf("%s[%d]", path, i), depth+1)
		}
		return a
	default:
		return v
	}
}
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case json.Number:
		return x != "0"
	}
	return true
}
