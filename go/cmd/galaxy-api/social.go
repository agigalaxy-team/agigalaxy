package main

import (
	"net/http"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountsocial"
	"github.com/agigalaxy-team/agigalaxy/go/internal/httpboundary"
)

func socialHandler(service *accountsocial.Service, identity accounts.HTTPIdentity, next http.Handler) http.Handler {
	handler := accountsocial.Handler{Service: service, Identity: identity, Next: next,
		ConsumeSearchPage: func(r *http.Request, actor accountsocial.Actor, after any) error {
			// The dispatcher calls only for a present field; explicit null also
			// consumes the original pagination quota before payload validation.
			position, _ := after.(string)
			kind, id := "", ""
			if actor.Official {
				kind, id = "account", actor.AccountID
			} else if actor.Device.SubjectID != "" {
				kind, id = "subject", actor.Device.SubjectID
			}
			return httpboundary.ConsumeSearchPage(r.Context(), &position, kind, id)
		}}
	if service.Devices != nil {
		handler.Devices = service.Devices
	}
	return handler
}
