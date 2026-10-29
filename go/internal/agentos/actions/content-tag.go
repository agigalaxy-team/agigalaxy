package actions

import (
	"context"
	"fmt"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
)

func contentTagKind(kind string) bool {
	return kind == "content-tag-create" || kind == "content-tag-update"
}
func parseContentTagRequest(x Object) (Object, error) {
	creating := x["kind"] == "content-tag-create"
	required := []string{"kind", "name"}
	optional := []string{}
	if !creating {
		required = []string{"kind", "targetId", "expectedVersion"}
		optional = []string{"name", "enabled"}
		if !validID(x["targetId"]) {
			return nil, invalid()
		}
	}
	if !exact(x, required, optional) {
		return nil, invalid()
	}
	command := pick(x, "name", "enabled", "expectedVersion")
	command["operationId"] = "00000000-0000-0000-0000-000000000000"
	parsed, e := operationscommunity.ParseTagCommand(command, creating)
	if e != nil {
		return nil, e
	}
	for _, k := range []string{"name", "enabled", "expectedVersion"} {
		if v, ok := parsed[k]; ok {
			x[k] = v
		}
	}
	return x, nil
}
func (s *Service) prepareContentTag(ctx context.Context, a Actor, x Object, p *preparation) error {
	service, e := s.content(a)
	if e != nil {
		return e
	}
	creating := x["kind"] == "content-tag-create"
	p.command = pick(x, "name", "enabled", "expectedVersion")
	p.basis = []any{basis("影响范围", "现有标签词表；提交时再次检查规范化重名")}
	if creating {
		p.title = "创建已明确命名的内容标签"
		p.target = Object{"kind": "tag-creation", "label": "新内容标签", "href": "/admin/operations/content"}
		p.impact = []any{"拟创建标签名称：" + str(x["name"]), "新标签默认启用；实际标签编号在创建完成后由原回执给出。", "名称按 Unicode 规范化、空白归一和大小写规则检查重名；存在重名时不会保存。"}
		return nil
	}
	value, e := service.TagByID(ctx, a, str(x["targetId"]))
	if e != nil {
		return e
	}
	tag := obj(value["tag"])
	if num(tag["version"]) != num(x["expectedVersion"]) {
		return fail("operations_tag_changed", 409)
	}
	name := tag["name"]
	enabled := tag["enabled"]
	if x["name"] != nil {
		name = x["name"]
	}
	if x["enabled"] != nil {
		enabled = x["enabled"]
	}
	p.title = "调整已有内容标签"
	p.target = Object{"kind": "content-tag", "id": x["targetId"], "label": label(tag["name"], "内容标签"), "href": "/admin/operations/content"}
	p.basis = append(p.basis, basis("当前版本", fmt.Sprint(tag["version"])))
	p.impact = []any{fmt.Sprintf("名称：%s → %s", str(tag["name"]), str(name)), fmt.Sprintf("启用状态：%t → %t", tag["enabled"] == true, enabled == true), "更名后，已有引用按同一标签编号显示当前名称。", "停用不会直接删除数据库原引用，但公开读取会过滤；重新启用后符合条件的原引用可再次出现。", "内容编排保存所选标签必须启用；推荐主题中已存在的停用标签可保留，新增关联须启用。", "重名按 Unicode 规范化、空白归一和大小写规则在提交时再次检查。"}
	return nil
}
func normalizeContentTagCommand(x, command, proposal Object) (Object, error) {
	creating := x["kind"] == "content-tag-create"
	expected := pick(x, "name", "enabled", "expectedVersion")
	expected["operationId"] = command["operationId"]
	parsed, e := operationscommunity.ParseTagCommand(command, creating)
	if e != nil || !same(parsed, expected) {
		return nil, invalid()
	}
	if !creating && obj(proposal["target"])["id"] != x["targetId"] {
		return nil, invalid()
	}
	if creating && (obj(proposal["target"])["kind"] != "tag-creation" || obj(proposal["target"])["id"] != nil) {
		return nil, invalid()
	}
	return parsed, nil
}
func (s *Service) executeContentTag(ctx context.Context, a Actor, x, command Object) (Object, error) {
	service, e := s.content(a)
	if e != nil {
		return nil, e
	}
	return service.Tag(ctx, a, str(x["targetId"]), command)
}
func (s *Service) recoverContentTag(ctx context.Context, a Actor, x, command Object, operationID string) (Object, error) {
	service, e := s.content(a)
	if e != nil {
		return nil, e
	}
	saved, e := service.ContentCommandResult(ctx, a, "tag", "", "", operationID)
	if e != nil {
		return nil, e
	}
	if saved["state"] == "not-recorded" {
		return nil, nil
	}
	if saved["state"] != "recorded" {
		return unknown(operationID), nil
	}
	action := "community-tag-create"
	selection := Object{"operationId": operationID, "expectedVersion": command["expectedVersion"], "nameDigest": nil, "enabled": command["enabled"]}
	if name, ok := command["name"].(string); ok {
		selection["nameDigest"] = identity.Digest([]byte(name))
	}
	if x["kind"] == "content-tag-update" {
		action = "community-tag-update"
		selection["id"], selection["resourceId"] = x["targetId"], x["targetId"]
	}
	raw, e := identity.Canonical(Object{"action": action, "selection": selection})
	if e != nil {
		return nil, e
	}
	receipt := obj(saved["result"])
	if saved["kind"] != action || receipt["intentHash"] != identity.Digest(raw) {
		return nil, fail("operations_agentos_operation_conflict", 409)
	}
	return Object{"operationId": operationID, "tag": receipt["tag"], "replayed": true}, nil
}
func contentTagResult(kind string, result Object, operationID string, x Object) (Object, error) {
	if result["state"] == "unknown" {
		return unknown(operationID), nil
	}
	tag := obj(result["tag"])
	if result["operationId"] != operationID || !validID(tag["id"]) || num(tag["version"]) != num(x["expectedVersion"])+1 || kind == "content-tag-update" && tag["id"] != x["targetId"] || x["enabled"] != nil && tag["enabled"] != x["enabled"] || kind == "content-tag-create" && tag["enabled"] != true {
		return nil, fail("operations_agentos_operation_conflict", 409)
	}
	return Object{"operationId": operationID, "state": "completed", "summary": "内容标签已保存。", "receipt": Object{"tagId": tag["id"], "version": tag["version"], "enabled": tag["enabled"], "replayed": result["replayed"] == true}}, nil
}
