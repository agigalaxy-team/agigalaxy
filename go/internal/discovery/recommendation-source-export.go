package discovery

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// CatalogWithin and ThemeMatches expose the same actual recommendation source
// for the original account-profile analysis consumer.
func (s *Recommendations) CatalogWithin(ctx context.Context, tx pgx.Tx) ([]Object, error) {
	return s.catalog(ctx, tx)
}
func ThemeMatches(theme Object, document *Document) bool {
	return document != nil && themeMatches(theme, document)
}
func QueryMatches(theme Object, query string) bool {
	if theme["enabled"] != true {
		return false
	}
	terms, _ := stringArray(object(theme["mapping"])["queryTerms"])
	for _, term := range terms {
		if normalizeTerm(term) == normalizeTerm(query) {
			return true
		}
	}
	return false
}
func ParseUsageEvent(input Object) (Object, error) { return parseEvent(input) }
