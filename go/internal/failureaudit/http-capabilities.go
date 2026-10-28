package failureaudit

import (
	"io"
	"net/http"
)

// Preserve only the optional interfaces actually offered by the underlying
// writer. Unwrap remains available for ResponseController deadline operations.
func preserveResponseCapabilities(w *observedResponse) http.ResponseWriter {
	mask := 0
	if _, ok := w.underlying.(http.Flusher); ok {
		mask |= 1
	} else if _, ok := w.underlying.(interface{ FlushError() error }); ok {
		mask |= 1
	}
	if _, ok := w.underlying.(http.Hijacker); ok {
		mask |= 2
	}
	if _, ok := w.underlying.(io.ReaderFrom); ok {
		mask |= 4
	}
	if _, ok := w.underlying.(http.Pusher); ok {
		mask |= 8
	}
	if _, ok := w.underlying.(http.CloseNotifier); ok {
		mask |= 16
	}
	switch mask {
	case 1:
		return struct {
			*observedResponse
			responseFlush
		}{w, responseFlush{w}}
	case 2:
		return struct {
			*observedResponse
			responseHijack
		}{w, responseHijack{w}}
	case 3:
		return struct {
			*observedResponse
			responseFlush
			responseHijack
		}{w, responseFlush{w}, responseHijack{w}}
	case 4:
		return struct {
			*observedResponse
			responseReadFrom
		}{w, responseReadFrom{w}}
	case 5:
		return struct {
			*observedResponse
			responseFlush
			responseReadFrom
		}{w, responseFlush{w}, responseReadFrom{w}}
	case 6:
		return struct {
			*observedResponse
			responseHijack
			responseReadFrom
		}{w, responseHijack{w}, responseReadFrom{w}}
	case 7:
		return struct {
			*observedResponse
			responseFlush
			responseHijack
			responseReadFrom
		}{w, responseFlush{w}, responseHijack{w}, responseReadFrom{w}}
	case 8:
		return struct {
			*observedResponse
			responsePush
		}{w, responsePush{w}}
	case 9:
		return struct {
			*observedResponse
			responseFlush
			responsePush
		}{w, responseFlush{w}, responsePush{w}}
	case 10:
		return struct {
			*observedResponse
			responseHijack
			responsePush
		}{w, responseHijack{w}, responsePush{w}}
	case 11:
		return struct {
			*observedResponse
			responseFlush
			responseHijack
			responsePush
		}{w, responseFlush{w}, responseHijack{w}, responsePush{w}}
	case 12:
		return struct {
			*observedResponse
			responseReadFrom
			responsePush
		}{w, responseReadFrom{w}, responsePush{w}}
	case 13:
		return struct {
			*observedResponse
			responseFlush
			responseReadFrom
			responsePush
		}{w, responseFlush{w}, responseReadFrom{w}, responsePush{w}}
	case 14:
		return struct {
			*observedResponse
			responseHijack
			responseReadFrom
			responsePush
		}{w, responseHijack{w}, responseReadFrom{w}, responsePush{w}}
	case 15:
		return struct {
			*observedResponse
			responseFlush
			responseHijack
			responseReadFrom
			responsePush
		}{w, responseFlush{w}, responseHijack{w}, responseReadFrom{w}, responsePush{w}}
	case 16:
		return struct {
			*observedResponse
			responseCloseNotify
		}{w, responseCloseNotify{w}}
	case 17:
		return struct {
			*observedResponse
			responseFlush
			responseCloseNotify
		}{w, responseFlush{w}, responseCloseNotify{w}}
	case 18:
		return struct {
			*observedResponse
			responseHijack
			responseCloseNotify
		}{w, responseHijack{w}, responseCloseNotify{w}}
	case 19:
		return struct {
			*observedResponse
			responseFlush
			responseHijack
			responseCloseNotify
		}{w, responseFlush{w}, responseHijack{w}, responseCloseNotify{w}}
	case 20:
		return struct {
			*observedResponse
			responseReadFrom
			responseCloseNotify
		}{w, responseReadFrom{w}, responseCloseNotify{w}}
	case 21:
		return struct {
			*observedResponse
			responseFlush
			responseReadFrom
			responseCloseNotify
		}{w, responseFlush{w}, responseReadFrom{w}, responseCloseNotify{w}}
	case 22:
		return struct {
			*observedResponse
			responseHijack
			responseReadFrom
			responseCloseNotify
		}{w, responseHijack{w}, responseReadFrom{w}, responseCloseNotify{w}}
	case 23:
		return struct {
			*observedResponse
			responseFlush
			responseHijack
			responseReadFrom
			responseCloseNotify
		}{w, responseFlush{w}, responseHijack{w}, responseReadFrom{w}, responseCloseNotify{w}}
	case 24:
		return struct {
			*observedResponse
			responsePush
			responseCloseNotify
		}{w, responsePush{w}, responseCloseNotify{w}}
	case 25:
		return struct {
			*observedResponse
			responseFlush
			responsePush
			responseCloseNotify
		}{w, responseFlush{w}, responsePush{w}, responseCloseNotify{w}}
	case 26:
		return struct {
			*observedResponse
			responseHijack
			responsePush
			responseCloseNotify
		}{w, responseHijack{w}, responsePush{w}, responseCloseNotify{w}}
	case 27:
		return struct {
			*observedResponse
			responseFlush
			responseHijack
			responsePush
			responseCloseNotify
		}{w, responseFlush{w}, responseHijack{w}, responsePush{w}, responseCloseNotify{w}}
	case 28:
		return struct {
			*observedResponse
			responseReadFrom
			responsePush
			responseCloseNotify
		}{w, responseReadFrom{w}, responsePush{w}, responseCloseNotify{w}}
	case 29:
		return struct {
			*observedResponse
			responseFlush
			responseReadFrom
			responsePush
			responseCloseNotify
		}{w, responseFlush{w}, responseReadFrom{w}, responsePush{w}, responseCloseNotify{w}}
	case 30:
		return struct {
			*observedResponse
			responseHijack
			responseReadFrom
			responsePush
			responseCloseNotify
		}{w, responseHijack{w}, responseReadFrom{w}, responsePush{w}, responseCloseNotify{w}}
	case 31:
		return struct {
			*observedResponse
			responseFlush
			responseHijack
			responseReadFrom
			responsePush
			responseCloseNotify
		}{w, responseFlush{w}, responseHijack{w}, responseReadFrom{w}, responsePush{w}, responseCloseNotify{w}}
	}
	return w
}
