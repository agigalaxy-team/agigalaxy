package operationsrules

import (
	"encoding/json"
	"strconv"
)

// P14 names, list entries and reasons reject Unicode Cs in the original
// schema. Inspect those encoded strings before encoding/json replaces a lone
// surrogate; sample text has a different original contract and is untouched.
func rawTextValid(raw json.RawMessage) bool {
	for i := 0; i < len(raw); i++ {
		if raw[i] != '\\' {
			continue
		}
		i++
		if i >= len(raw) {
			return false
		}
		if raw[i] != 'u' {
			continue
		}
		if i+4 >= len(raw) {
			return false
		}
		n, e := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		if e != nil {
			return false
		}
		i += 4
		if n >= 0xdc00 && n <= 0xdfff {
			return false
		}
		if n < 0xd800 || n > 0xdbff {
			continue
		}
		if i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
			return false
		}
		low, e := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
		if e != nil || low < 0xdc00 || low > 0xdfff {
			return false
		}
		i += 6
	}
	return true
}
func requestTextBytesValid(raw []byte, business bool) bool {
	var input map[string]json.RawMessage
	if json.Unmarshal(raw, &input) != nil {
		return false
	}
	if reason, exists := input["reason"]; exists && !rawTextValid(reason) {
		return false
	}
	if !business {
		return true
	}
	var policy map[string]json.RawMessage
	if json.Unmarshal(input["policy"], &policy) != nil {
		return true
	}
	var lists, rules []map[string]json.RawMessage
	_ = json.Unmarshal(policy["lists"], &lists)
	_ = json.Unmarshal(policy["rules"], &rules)
	for _, l := range lists {
		if !rawTextValid(l["name"]) {
			return false
		}
		var entries []json.RawMessage
		_ = json.Unmarshal(l["entries"], &entries)
		for _, entry := range entries {
			if !rawTextValid(entry) {
				return false
			}
		}
	}
	for _, r := range rules {
		if !rawTextValid(r["name"]) {
			return false
		}
		var exceptions []map[string]json.RawMessage
		_ = json.Unmarshal(r["exceptions"], &exceptions)
		for _, e := range exceptions {
			if !rawTextValid(e["name"]) {
				return false
			}
		}
	}
	return true
}
