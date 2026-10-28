// Package selectedtext implements the existing selected excerpt schema shared
// by Context and reported Configuration. It rejects known credential formats;
// it never silently redacts or discovers any material.
package selectedtext

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

const whitespaceBody = `\x09-\x0d\x20\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

var secret = regexp.MustCompile(strings.ReplaceAll(strings.ReplaceAll(`-----begin (?:[a-z]+ )?private key-----|\b(?:bearer\s+[a-z0-9_.~-]{16,}|github_pat_[a-z0-9_]+|gh[pousr]_[a-z0-9]{20,}|sk-(?:proj-)?[a-z0-9_-]{20,})|(?:password|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s]{8,}`, `[^\s]`, `[^`+whitespaceBody+`]`), `\s`, `[`+whitespaceBody+`]`))

// regexUnits retains the original non-u JavaScript regexp's ASCII ignore-case
// and UTF-16 repetition semantics. Astral characters are two nonmatching,
// non-whitespace units; their actual contents are never emitted or persisted.
func regexUnits(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r > 0xffff {
			b.WriteRune(0xe000)
			b.WriteRune(0xe000)
		} else {
			if r >= 'A' && r <= 'Z' {
				r += 32
			}
			b.WriteRune(r)
		}
	}
	return b.String()
}
func Valid(s string) bool {
	return utf8.RuneCountInString(s) <= 4000 && !secret.MatchString(regexUnits(s))
}
