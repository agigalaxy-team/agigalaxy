package businessrules

import "unicode/utf8"

// ContentConditionFacts uses the same bounded text/link derivation as the
// production P14 evaluator. Missing inputs remain unknown, never synthetic 0.
func ContentConditionFacts(text *string, links []any, attachmentCount *int64) Object {
	out := Object{"textLength": nil, "linkCount": nil, "attachmentCount": nil}
	body := ""
	if text != nil {
		body = *text
		out["textLength"] = int64(utf8.RuneCountInString(body))
	}
	_, count := linkFacts(body, links)
	if text != nil || links != nil {
		if count != nil {
			out["linkCount"] = *count
		}
	}
	if attachmentCount != nil {
		out["attachmentCount"] = *attachmentCount
	}
	return out
}
