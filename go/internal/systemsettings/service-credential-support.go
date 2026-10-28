package systemsettings

// ServiceCredentialsConfigured reuses the original credential schema for
// readback of already loaded clients. It neither provisions nor returns a key.
func ServiceCredentialsConfigured(kind string, credential Object) bool {
	var keys []string
	switch kind {
	case "analysis":
		keys = []string{"clientSecret", "readClientSecret"}
	case "recommendation", "search":
		keys = []string{"apiKey"}
	case "ai-execution":
		keys = []string{"signingKey", "serviceKey"}
	default:
		return false
	}
	if !closed(credential, keys, nil) {
		return false
	}
	for _, key := range keys {
		if !secret(credential[key], 32, 4096) {
			return false
		}
	}
	return true
}
