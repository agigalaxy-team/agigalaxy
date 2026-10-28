package discovery

import "unicode/utf8"

// The installed Zod v4 min/max checks count code points. Explicit JavaScript
// .length limits and UTF-16 sorting retain their separate original semantics.
func codePointLength(value string) int { return utf8.RuneCountInString(value) }
