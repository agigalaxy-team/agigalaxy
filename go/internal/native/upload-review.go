package native

import (
	"context"
	"fmt"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

// uploadReviewMessage describes the same selected inputs for native and Apps
// choices. It reads current names only; the original input remains authoritative.
func uploadReviewSupported(name string) bool {
	return isOne(name, "galaxy_local_upload_privacy_set", "galaxy_local_settings_save", "galaxy_work_sync_choice", "galaxy_archive_sync_choice", "galaxy_work_cloud_delete", "galaxy_archive_cloud_delete")
}
func uploadReviewMessage(ctx context.Context, r *Runtime, name string, input any, status map[string]any, expected *ChoiceScope) (string, bool, error) {
	if !uploadReviewSupported(name) {
		return "", false, nil
	}
	raw, err := protocol.Encode(input)
	if err != nil {
		return "", true, err
	}
	var data map[string]any
	if err = protocol.Decode(raw, &data); err != nil {
		return "", true, err
	}
	scope, err := uploadChoiceScope(ctx, r.store)
	if err != nil {
		return "", true, err
	}
	if expected != nil && scope != *expected {
		return "", true, connectionFailure("native_connection_selection_changed")
	}
	if owner := text(data["galaxyId"]); owner != "" && owner != scope.Owner {
		return "", true, connectionFailure("local_identity_changed")
	}
	if name == "galaxy_local_upload_privacy_set" {
		selected := map[string]any{}
		for _, key := range []string{"level", "includeFullConversations", "sessionIds"} {
			if value, ok := data[key]; ok {
				selected[key] = value
			}
		}
		selectionJSON, encodeErr := protocol.Encode(selected)
		if encodeErr != nil {
			return "", true, encodeErr
		}
		var selection UploadPrivacySelection
		if err = protocol.Decode(selectionJSON, &selection); err != nil {
			return "", true, err
		}
		current, owner, readErr := r.ReadUploadPrivacy(ctx, &scope)
		if readErr != nil {
			return "", true, readErr
		}
		if owner != scope.Owner {
			return "", true, connectionFailure("local_identity_changed")
		}
		effective, selectErr := SelectUploadPrivacy(current, selection, "")
		if selectErr != nil {
			return "", true, selectErr
		}
		data["level"] = effective.Level
		data["includeFullConversations"] = effective.IncludeFullConversations
		sessions := make([]any, 0, len(effective.SessionIDs))
		for _, id := range effective.SessionIDs {
			sessions = append(sessions, id)
		}
		data["sessionIds"] = sessions
	}
	var lines []string
	add := func(s string) {
		if s != "" {
			lines = append(lines, s)
		}
	}
	level := map[string]string{"local-only": "仅本机，不允许上传", "history-overview": "履历概况：上传概况与主要环境，不上传工作正文", "work-content": "工作内容：可上传所选工作的正文及概况", "conversation-archive": "原会话：可另选允许上传的完整会话"}
	if v := text(data["level"]); v != "" {
		add("允许上传的类型：" + level[v])
	}
	account := text(data["targetAccountId"])
	if account != "" {
		label := "账户标识：" + account
		targets, e := r.Call(ctx, "/v2/account-archives/accounts", map[string]any{}, ConnectionCallOptions{ExpectedScope: &scope})
		if e == nil && targets["subjectId"] == scope.Owner {
			for _, entry := range uploadRows(targets["accounts"]) {
				v := uploadObject(entry)
				if v["accountId"] == account && v["endpoint"] == r.config.Endpoint {
					display, uid := text(v["displayName"]), text(v["uid"])
					if display != "" && uid != "" {
						label = display + "（" + uid + "）"
					} else if display != "" {
						label = display + "（账户标识：" + account + "）"
					} else if uid != "" {
						label = uid
					}
					break
				}
			}
		}
		add("目标账户：" + label)
	} else if name == "galaxy_work_sync_choice" || name == "galaxy_archive_sync_choice" || name == "galaxy_local_settings_save" && data["conversationMode"] == "cloud" {
		add("目标账户：未选择")
	}
	workNames := func(ids []string) []string {
		out := []string{}
		for i, id := range ids {
			label := fmt.Sprintf("第 %d 项工作（当前无法读取标题）", i+1)
			value, e := r.store.WorkGet(ctx, WorkQuery{GalaxyID: scope.Owner, WorkID: id, Limit: 1})
			if e == nil {
				work := uploadObject(uploadObject(value)["work"])
				if title := text(work["title"]); title != "" {
					label = title
					if host := text(work["host"]); host != "" {
						label += " · " + host
					}
					if at := text(work["updatedAt"]); at != "" {
						label += " · " + at
					}
				}
			}
			out = append(out, "• "+label+" · 工作标识："+id)
		}
		return out
	}
	archiveNames := func(ids []string) []string {
		out := []string{}
		for i, id := range ids {
			label := fmt.Sprintf("第 %d 份原会话（当前无法读取摘要）", i+1)
			value, e := r.store.ArchiveDescribe(ctx, ArchiveQuery{GalaxyID: scope.Owner, ArchiveSessionID: id})
			if e == nil {
				v := uploadObject(value)
				if v != nil {
					label = text(v["host"]) + " · " + fmt.Sprint(integer(v["messageCount"])) + " 条消息"
					work, workErr := r.store.WorkGet(ctx, WorkQuery{GalaxyID: scope.Owner, Host: text(v["host"]), SessionID: text(v["sessionId"]), Limit: 1})
					if workErr == nil {
						if title := text(uploadObject(uploadObject(work)["work"])["title"]); title != "" {
							label = title + " · " + label
						}
					}
					if at := text(v["updatedAt"]); at != "" {
						label += " · " + at
					}
				}
			}
			out = append(out, "• "+label+" · 原件标识："+id)
		}
		return out
	}
	addList := func(title string, items []string) {
		if len(items) > 0 {
			add(title + "：\n" + strings.Join(items, "\n"))
		}
	}
	switch name {
	case "galaxy_local_upload_privacy_set":
		if data["includeFullConversations"] == true {
			add("完整会话：仅允许上传以下所选会话")
			ids, _ := connectionStrings(data["sessionIds"])
			if len(ids) == 0 {
				add("没有选定原会话。")
			}
			addList("所选会话", archiveNames(ids))
		} else {
			add("完整会话：不允许上传")
		}
		add("这里只保存允许上传的类型和范围，不启动上传；不改变公开查询。")
	case "galaxy_work_sync_choice":
		if data["enabled"] == true {
			add("履历保存到账户：开启")
		} else {
			add("履历保存到账户：关闭")
		}
		ids, _ := connectionStrings(data["workIds"])
		if len(ids) == 0 {
			add("没有选定现有工作。")
		}
		addList("所选工作", workNames(ids))
		if data["includeExisting"] == true {
			add("包含所选工作的已有记录。")
		} else {
			add("不选择已有记录。")
		}
		if data["includeFutureWork"] == true {
			add("也包括之后产生的工作。")
		}
		restore, _ := connectionStrings(data["restoreWorkIds"])
		addList("重新保存此前删除的云端工作", workNames(restore))
		add("只保存到上述本人账户；不改变公开查询。")
	case "galaxy_archive_sync_choice":
		if data["enabled"] == true {
			add("原会话保存到账户：开启")
		} else {
			add("原会话保存到账户：关闭")
		}
		ids, _ := connectionStrings(data["archiveSessionIds"])
		if len(ids) == 0 {
			add("没有选定原会话。")
		}
		addList("所选原会话", archiveNames(ids))
		restore, _ := connectionStrings(data["restoreArchiveSessionIds"])
		addList("重新保存此前删除的云端原会话", archiveNames(restore))
		add("只保存明确选中的原会话到上述本人账户；不改变公开查询。")
	case "galaxy_local_settings_save":
		mode := map[string]string{"off": "不另存后续原会话", "local": "仅保存在本机", "cloud": "保存在本机与所选本人账户"}
		add("原会话保存：" + mode[text(data["conversationMode"])])
		entries := uploadRows(data["sessions"])
		names := []string{}
		for i, entry := range entries {
			v := uploadObject(entry)
			host := text(v["host"])
			label := fmt.Sprintf("第 %d 项会话（%s）", i+1, host)
			w, e := r.store.WorkGet(ctx, WorkQuery{GalaxyID: scope.Owner, Host: host, SessionID: text(v["sessionId"]), Limit: 1})
			if e == nil {
				if title := text(uploadObject(uploadObject(w)["work"])["title"]); title != "" {
					label = title + " · " + host
				}
			}
			names = append(names, "• "+label+" · 会话标识："+text(v["sessionId"]))
		}
		if len(names) == 0 {
			add("没有选定原会话。")
		}
		addList("所选会话", names)
		if days := data["autoCleanAfterDays"]; days != nil {
			add(fmt.Sprintf("自动清理：超过 %v 天的本机捕获原件；保存时会执行到期清理。", days))
		} else {
			add("自动清理：不启用。")
		}
		restore, _ := connectionStrings(data["restoreArchiveSessionIds"])
		addList("重新保存此前删除的云端原会话", archiveNames(restore))
		add("宿主自己的原会话不因这项选择被删除。")
	case "galaxy_work_cloud_delete":
		addList("删除这份云端工作", workNames([]string{text(data["workId"])}))
		add("本机工作和宿主原件保留；删除后该来源不会自动重新上传。")
	case "galaxy_archive_cloud_delete":
		archive := uploadObject(status["archive"])
		title := text(archive["title"])
		if title == "" {
			title = "所选云端原会话（当前未取得名称）"
		}
		add("删除这份云端原会话：" + title + " · 原件标识：" + text(data["id"]))
		if at := text(archive["updatedAt"]); at != "" {
			add("云端副本更新时间：" + at)
		}
		add("本机和宿主原件保留；删除后该来源不会自动重新上传。")
	}
	if status != nil {
		states := map[string]string{"stored": "已保存", "ready": "已保存", "uploading": "保存中", "deleted": "已删除", "absent": "未找到", "expired": "已到期"}
		if state := text(status["state"]); state != "" {
			label := states[state]
			if label == "" {
				label = "暂不可确定"
			}
			add("当前云端状态：" + label)
		}
	}
	current, err := uploadChoiceScope(ctx, r.store)
	if err != nil {
		return "", true, err
	}
	if current != scope {
		return "", true, connectionFailure("native_connection_selection_changed")
	}
	return strings.Join(lines, "\n\n"), true, nil
}
