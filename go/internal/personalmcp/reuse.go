package personalmcp

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/builders"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/hubs"
)

func (s Services) reuseConsumers(out map[string]Consumer) {
	if p := s.Capsules; p != nil {
		for name, fn := range map[string]func(context.Context, *deviceauth.Actor, []byte) (Object, error){"galaxy_capsules_query": p.Query, "galaxy_capsule_get": p.Get, "galaxy_capsule_v2_versions": p.Versions, "galaxy_capsule_v2_read": p.GetV2, "galaxy_capsule_v2_query": p.QueryV2, "galaxy_capsule_v2_uses": p.UsesV2} {
			pointerRead(out, name, fn)
		}
		for name, fn := range map[string]func(context.Context, deviceauth.Actor, []byte) (Object, error){"galaxy_capsule_v2_receipt": p.Receipt, "galaxy_capsule_v2_permissions": p.Permissions, "galaxy_capsule_v2_preview": p.Preview, "galaxy_capsule_v2_permission_read": p.GetPermission} {
			rawRead(out, name, fn)
		}
		rawWrite(out, "galaxy_capsule_v2_publish", p.PublishV2)
		rawWrite(out, "galaxy_capsule_v2_use", p.RecordUseV2)
		rawWrite(out, "galaxy_capsule_v2_permission", p.Permission)
	}
	if p := s.Builders; p != nil {
		pointerRead(out, "galaxy_builder_support_read", p.Support)
		rawWrite(out, "galaxy_builder_support_publish", p.Publish)
		pointerRead(out, "galaxy_builder_pack_export", p.ExportPack)
		pointerRead(out, "galaxy_builder_read", p.Get)
		rawRead(out, "galaxy_builder_owned", p.Owned)
		rawRead(out, "galaxy_builder_receipt", p.Receipt)
		pointerRead(out, "galaxy_builder_notices", p.Notices)
		pointerRead(out, "galaxy_worker_pack_manifest", p.Manifest)
		out["galaxy_builders_query"] = func(ctx context.Context, a deviceauth.Actor, q Object, _ *string) (any, error) {
			raw, e := rawInput(q)
			if e != nil {
				return nil, e
			}
			return p.Query(ctx, &a, raw, builders.QueryOptions{})
		}
	}
	if p := s.Hubs; p != nil {
		out["galaxy_hub_status"] = func(context.Context, deviceauth.Actor, Object, *string) (any, error) {
			return hubs.Specification(), nil
		}
		pointerRead(out, "galaxy_hub_query", p.Query)
		pointerRead(out, "galaxy_hub_read", p.Get)
		for name, fn := range map[string]func(context.Context, deviceauth.Actor, []byte) (Object, error){"galaxy_hub_manage": p.Manage, "galaxy_hub_memberships": p.Members, "galaxy_hub_intake": p.Intake, "galaxy_hub_receipt": p.Receipt} {
			rawRead(out, name, fn)
		}
		out["galaxy_hub_events"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.Submit(ctx, a, q, requestID(id))
		}
	}
	if p := s.Peering; p != nil {
		for name, fn := range map[string]func(context.Context, deviceauth.Actor, []byte) (Object, error){"galaxy_hub_peering_party": p.Party, "galaxy_hub_peering_connections": p.Connections, "galaxy_hub_peering_sources": p.Sources, "galaxy_hub_peering_read": p.Read, "galaxy_hub_peering_list": p.List, "galaxy_hub_peering_preview": p.Preview, "galaxy_hub_peering_query": p.Query, "galaxy_hub_peering_receipt": p.Receipt} {
			rawRead(out, name, fn)
		}
		out["galaxy_hub_peering_events"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.Submit(ctx, a, q, requestID(id))
		}
	}
	if p := s.Information; p != nil {
		pointerRead(out, "galaxy_information_query", p.Query)
	}
	if p := s.InformationWatches; p != nil {
		rawWrite(out, "galaxy_information_watch_change", p.Command)
		rawRead(out, "galaxy_information_watches", p.List)
		rawRead(out, "galaxy_information_watch_receipt", p.Receipt)
		rawRead(out, "galaxy_information_watch_check", p.Check)
		rawRead(out, "galaxy_information_watch_events", p.Events)
	}
}
