package accounts

// ValidAvatarKey exposes the original nullable avatar enum to the existing
// management schema; it does not write presets or alter profile validation.
func ValidAvatarKey(v any) bool {
	if v == nil {
		return true
	}
	key, ok := v.(string)
	return ok && avatars[key]
}
