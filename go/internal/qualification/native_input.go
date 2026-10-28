package qualification

// ParsePlan is the same existing pure request-plan parser used by the owning
// service. Native does not infer source permissions from a syntactic selection.
func ParsePlan(input Object) (Object, error) { return parsePlan(input) }
