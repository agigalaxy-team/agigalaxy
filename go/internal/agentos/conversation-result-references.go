package agentos

// Receipt references let the model continue with real objects without copying
// command bodies into its context. They are identifiers, never authorization.
func resultReferences(value any) []Object {
	out := []Object{}
	appendReference := func(ref Object) {
		kind, id := text(ref, "kind"), text(ref, "id")
		if len(ref) == 2 && toolRoute.MatchString(kind) && validOperationID(id) {
			out = append(out, Object{"kind": kind, "id": id})
		}
	}
	switch refs := value.(type) {
	case []any:
		for _, ref := range refs {
			appendReference(object(ref))
		}
	case []Object:
		for _, ref := range refs {
			appendReference(ref)
		}
	}
	return out
}
