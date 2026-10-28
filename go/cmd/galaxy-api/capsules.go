package main

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/capsules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/configurations"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/jackc/pgx/v5"
)

func capsuleService(source *cases.Service, records *verificationrecords.Service, proofs *evidence.ProofService, configs *configurations.Service, rooms *chat.Service, outcome *taskmaterials.OutcomeService) *capsules.Service {
	s := &capsules.Service{Pool: source.Pool, Endpoint: source.Endpoint, Devices: source.Devices, Cases: source, Records: records, Proofs: proofs,
		Configurations: configs, ResourceWrite: capsules.ResourceWrite(source.ResourceWrite), Materials: outcome.ReadCapsuleWithin}
	s.Selected = func(ctx context.Context, tx pgx.Tx, actor *deviceauth.Actor, ref capsules.Object) (capsules.Object, error) {
		if actor == nil {
			return nil, fault.New("access_denied", 403)
		}
		raw, err := protocol.Encode(ref)
		if err != nil {
			return nil, err
		}
		var selected struct {
			MessageID string `json:"messageId"`
			Revision  int64  `json:"revision"`
		}
		if err = protocol.Decode(raw, &selected); err != nil {
			return nil, err
		}
		viewer := chat.Actor{Device: actor}
		body, err := rooms.ReadSelectedWithin(ctx, tx, viewer, selected.MessageID, selected.Revision)
		if err != nil {
			return nil, err
		}
		room, _ := body["roomId"].(string)
		if _, err = rooms.RequireSelectedWithin(ctx, tx, viewer, room, selected.MessageID, selected.Revision); err != nil {
			return nil, err
		}
		return body, nil
	}
	source.CapsuleUses = func(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor, caseID string) (capsules.Object, error) {
		return s.UsesWithin(ctx, tx, &actor, capsules.Object{"caseId": caseID, "limit": int64(20)})
	}
	return s
}
