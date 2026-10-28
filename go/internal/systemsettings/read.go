package systemsettings

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (s *Service) nativeOverview(ctx context.Context, section string) Object {
	if s.Native == nil {
		return unavailableOverview(false)
	}
	raw, e := s.Native.Call(ctx, Object{"kind": "settings-overview", "section": section})
	if e != nil {
		return unavailableOverview(true)
	}
	value, e := ParseOverview(raw)
	if e != nil {
		return unavailableOverview(true)
	}
	if value["observedConfiguration"] != nil {
		value["observedConfiguration"], e = ParseConfiguration(section, obj(value["observedConfiguration"]))
		if e != nil {
			return unavailableOverview(true)
		}
	}
	return value
}
func (s *Service) Read(ctx context.Context, a Actor, section string) (Object, error) {
	if !includes(sections, section) {
		return nil, invalid()
	}
	if _, e := s.current(ctx, a, "system.settings.read"); e != nil {
		return nil, e
	}
	head, e := s.head(ctx, s.Pool, section)
	if e != nil {
		return nil, e
	}
	if head["pending_operation"] != nil {
		if _, e = s.reconcile(ctx, str(head["pending_operation"]), a.ID); e != nil {
			return nil, e
		}
	}
	native := s.nativeOverview(ctx, section)
	head, e = s.head(ctx, s.Pool, section)
	if e != nil {
		return nil, e
	}
	version, e := s.version(ctx, s.Pool, head["version_id"], section)
	if e != nil {
		return nil, e
	}
	actor, e := s.current(ctx, a, "system.settings.read")
	if e != nil {
		return nil, e
	}
	configuration, basis := native["observedConfiguration"], "observed-current"
	if version != nil {
		configuration, basis = version["configuration"], "saved-version"
	} else if configuration == nil {
		configuration, basis = EmptyConfiguration(section), "empty"
	}
	var pending any
	if head["pending_operation"] != nil {
		r, e := s.row(ctx, s.Pool, str(head["pending_operation"]))
		if e != nil {
			return nil, e
		}
		pending, e = OperationView(r)
		if e != nil {
			return nil, e
		}
	}
	caps := obj(native["capabilities"])
	return s.stamp(Object{"section": section, "revision": head["revision"], "version": VersionView(version), "configuration": configuration, "configurationBasis": basis, "availability": native["availability"], "current": native["current"], "credentials": native["credentials"], "pending": pending, "capabilities": Object{"canRead": true, "canSave": includes(actor.Permissions, "system.settings.configure") && head["pending_operation"] == nil, "canTest": includes(actor.Permissions, "system.settings.test") && caps["canTest"] == true && version != nil, "canApply": includes(actor.Permissions, "system.settings.apply") && caps["canApply"] == true && head["pending_operation"] == nil, "canWriteCredential": includes(actor.Permissions, "system.settings.credentials.write") && caps["canWriteCredential"] == true}}), nil
}
func (s *Service) Overview(ctx context.Context, a Actor) (Object, error) {
	if _, e := s.current(ctx, a, "system.settings.read"); e != nil {
		return nil, e
	}
	result := Object{}
	for _, section := range sections {
		r, e := s.Read(ctx, a, section)
		if e != nil {
			return nil, e
		}
		result[section] = r
	}
	if _, e := s.current(ctx, a, "system.settings.read"); e != nil {
		return nil, e
	}
	return s.stamp(Object{"sections": result}), nil
}
func (s *Service) Advanced(ctx context.Context, a Actor) (Object, error) {
	mail, e := s.Read(ctx, a, "mail")
	if e != nil {
		return nil, e
	}
	connections := []any{}
	for _, v := range list(obj(mail["configuration"])["connections"]) {
		r := obj(v)
		o := Object{}
		for _, k := range []string{"id", "name", "connectionTimeoutMs", "greetingTimeoutMs", "socketTimeoutMs", "maxConnections", "rateLimit", "rateWindowSeconds", "dkimSelector"} {
			o[k] = r[k]
		}
		connections = append(connections, o)
	}
	var id any
	if version := obj(mail["version"]); version != nil {
		id = version["id"]
	}
	return s.stamp(Object{"section": "advanced", "revision": mail["revision"], "versionId": id, "connections": connections, "source": "mail-configuration", "limitsScope": "per-worker-process", "current": mail["current"], "capabilities": mail["capabilities"]}), nil
}
func (s *Service) Operation(ctx context.Context, a Actor, id string) (Object, error) {
	id, ok := parseUUID(id, true)
	if !ok {
		return nil, invalid()
	}
	if _, e := s.current(ctx, a, "system.settings.read"); e != nil {
		return nil, e
	}
	row, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := s.operationLock(ctx, tx, id); e != nil {
			return nil, e
		}
		return s.row(ctx, tx, id)
	})
	if e != nil {
		return nil, e
	}
	if row != nil && row["operator_id"] != a.ID {
		return nil, fail("system_settings_permission_denied", 403)
	}
	if row != nil && pendingState(row) {
		row, e = s.reconcile(ctx, id, a.ID)
		if e != nil {
			return nil, e
		}
	}
	if _, e = s.current(ctx, a, "system.settings.read"); e != nil {
		return nil, e
	}
	view, e := OperationView(row)
	if e != nil {
		return nil, e
	}
	state := "not-recorded"
	if row != nil {
		state = "recorded"
	}
	return s.stamp(Object{"state": state, "operationId": id, "operation": view, "basis": "same-database-observation"}), nil
}
func (s *Service) History(ctx context.Context, a Actor, section string, input Object) (Object, error) {
	if !includes(sections, section) {
		return nil, invalid()
	}
	x, e := ParseHistory(input)
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, a, "system.settings.read"); e != nil {
		return nil, e
	}
	rows, e := s.Pool.Query(ctx, `SELECT to_jsonb(c)||jsonb_build_object('sequence',c.sequence::text,'operator_display_name',p.display_name) FROM operations_system_settings_commands_v1 c LEFT JOIN operations_operator_principals_v1 p ON p.endpoint=c.endpoint AND p.operator_id=c.operator_id WHERE c.endpoint=$1 AND c.section=$2 AND ($3::bigint IS NULL OR c.sequence<$3) ORDER BY c.sequence DESC LIMIT $4`, s.Endpoint, section, x["after"], num(x["limit"])+1)
	if e != nil {
		return nil, e
	}
	all := []Object{}
	for rows.Next() {
		var b []byte
		if e = rows.Scan(&b); e != nil {
			rows.Close()
			return nil, e
		}
		var r Object
		if e = json.Unmarshal(b, &r); e != nil {
			rows.Close()
			return nil, e
		}
		all = append(all, r)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, a, "system.settings.read"); e != nil {
		return nil, e
	}
	limit := int(num(x["limit"]))
	var next any
	if len(all) > limit {
		next = numberText(all[limit-1]["sequence"])
		all = all[:limit]
	}
	items := []any{}
	for _, r := range all {
		view, e := OperationView(r)
		if e != nil {
			return nil, e
		}
		o := obj(view)
		o["sequence"], o["operatorDisplayName"] = numberText(r["sequence"]), r["operator_display_name"]
		items = append(items, o)
	}
	return s.stamp(Object{"items": items, "nextAfter": next}), nil
}
func numberText(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	b, _ := json.Marshal(v)
	return string(b)
}
