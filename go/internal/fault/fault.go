package fault

import "errors"

type Error struct {
	Code   string
	Status int
}

func (e *Error) Error() string          { return e.Code }
func New(code string, status int) error { return &Error{code, status} }
func Code(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return "internal_error"
}
func Status(err error) int {
	var e *Error
	if errors.As(err, &e) {
		return e.Status
	}
	return 503
}
