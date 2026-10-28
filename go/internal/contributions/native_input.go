package contributions

// ValidatePreview shares the existing exact selected-fields and purposes
// parser with the Native transport. It authorizes or publishes no source.
func ValidatePreview(input Object) error {
	if !closed(input, []string{"sourceRefs", "purposes"}, nil) || !parseRefsAndPurposes(input) {
		return fail("invalid_contribution_preview", 400)
	}
	return nil
}
