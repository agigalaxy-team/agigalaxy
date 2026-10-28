package cases

// ProjectReviews exposes the existing reported review projection to the
// Capsule consumer. It grants no source read or independent decision authority.
func ProjectReviews(rows []Object) []any { return reviews(rows) }
