package agentos

import (
	"unicode"
	"unicode/utf8"
)

// ConnectionObservation describes the already loaded process instance for the
// original service-adoption reporter. It never returns either credential.
type ConnectionObservation struct {
	URL               string
	SigningConfigured bool
	ServiceConfigured bool
}

func (c *Client) ConnectionObservation() ConnectionObservation {
	if c == nil {
		return ConnectionObservation{}
	}
	valid := func(value string) bool {
		n := utf8.RuneCountInString(value)
		if n < 32 || n > 4096 {
			return false
		}
		for _, r := range value {
			if unicode.IsControl(r) {
				return false
			}
		}
		return true
	}
	return ConnectionObservation{URL: c.configuration.URL, SigningConfigured: valid(c.configuration.SigningKey), ServiceConfigured: valid(c.configuration.ServiceKey)}
}
