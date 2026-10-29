package businessadmin

import (
	"strings"
	"unicode"
)

// TrimActionText preserves the existing action request whitespace contract.
func TrimActionText(v string) string {
	return strings.TrimFunc(v, func(r rune) bool { return r == '\ufeff' || unicode.IsSpace(r) && r != 0x85 })
}
