package native

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func TestExperienceBasisPreservesLegacyDataAndRevisionContext(t *testing.T) {
	ctx := context.Background()
	store, expected := fixture(t)
	work := text(uploadObject(uploadObject(expected["get"])["work"])["workId"])
	id := "8bea6000-0f13-4000-8000-000000000001"
	legacy := map[string]any{"id": id, "revision": 1, "title": "可选的迁移方案", "conditions": "比较迁移方案", "method": "考虑离线迁移", "limitations": "尚未执行"}
	if err := store.historyWrite(ctx, "", nil, func(db *sql.DB, owner string) error {
		// The installed 0.1.13 schema has no basis column. Preserve that record
		// and its revision when a newer writer adds context.
		ddl := strings.Replace(workLearningDDL, ",basis TEXT NOT NULL DEFAULT ''", "", 1)
		if _, err := db.ExecContext(ctx, ddl); err != nil {
			return err
		}
		if _, err := db.ExecContext(ctx, "INSERT INTO work_experience(id,owner_id,revision,title,conditions,method,limitations,outcome,source_work_id,through_sequence,updated_at) VALUES(?,?,1,?,?,?,'尚未执行','',?,2,?)", id, owner, legacy["title"], legacy["conditions"], legacy["method"], work, localNow()); err != nil {
			return err
		}
		_, err := db.ExecContext(ctx, "INSERT INTO work_experience_revision(id,revision,owner_id,source_work_id,through_sequence,value_json,created_at) VALUES(?,1,?,?,2,?,?)", id, owner, work, jsJSON(legacy), localNow())
		return err
	}); err != nil {
		t.Fatal(err)
	}
	old, err := store.GetWorkExperience(ctx, WorkExperienceQuery{ID: id})
	if err != nil || uploadObject(old)["basis"] != "" {
		t.Fatal("legacy record was annotated without evidence", old, err)
	}
	basis := "模型提出的可选方案，用户尚未采纳；未执行迁移。"
	revision := int64(1)
	input := WorkExperienceInput{ID: id, ExpectedRevision: &revision, WorkID: work, Title: "可选的迁移方案", Conditions: "比较迁移方案", Method: "可考虑离线迁移", Basis: &basis}
	if _, err = store.UpsertWorkExperience(ctx, input); err != nil {
		t.Fatal(err)
	}
	found, err := store.SearchWorkExperience(ctx, WorkExperienceQuery{Query: "迁移方案"})
	if err != nil {
		t.Fatal(err)
	}
	items := uploadRows(uploadObject(found)["items"])
	if len(items) != 1 || uploadObject(items[0])["basis"] != basis || uploadObject(items[0])["method"] != nil {
		t.Fatal("candidate lost context or eagerly exposed the method", found)
	}
	revision = 2
	input.Basis = nil // An unchanged older-client round trip keeps its context.
	if _, err = store.UpsertWorkExperience(ctx, input); err != nil {
		t.Fatal(err)
	}
	current, err := store.GetWorkExperience(ctx, WorkExperienceQuery{ID: id})
	if err != nil || uploadObject(current)["basis"] != basis || integer(uploadObject(current)["revision"]) != 3 {
		t.Fatal(current, err)
	}
	revision = 3
	input.Method = "考虑另外一种尚未选择的迁移方式"
	if _, err = store.UpsertWorkExperience(ctx, input); err != nil {
		t.Fatal(err)
	}
	current, err = store.GetWorkExperience(ctx, WorkExperienceQuery{ID: id})
	if err != nil || uploadObject(current)["basis"] != "" {
		t.Fatal("old context endorsed changed content", current, err)
	}
	if err = store.history(ctx, "", func(db *sql.DB, owner string) error {
		row, e := oneMap(ctx, db, "SELECT value_json FROM work_experience_revision WHERE id=? AND revision=1", id)
		if e == nil && text(row["value_json"]) != jsJSON(legacy) {
			t.Fatal("old revision was rewritten")
		}
		return e
	}); err != nil {
		t.Fatal(err)
	}
	if _, err = store.DeleteWork(ctx, WorkQuery{WorkID: work}); err != nil {
		t.Fatal(err)
	}
	if err = store.history(ctx, "", func(db *sql.DB, owner string) error {
		row, e := oneMap(ctx, db, "SELECT basis FROM work_experience WHERE id=?", id)
		if e == nil && text(row["basis"]) != "" {
			t.Fatal("deleted source retained private context")
		}
		return e
	}); err != nil {
		t.Fatal(err)
	}
}

func TestWorkReviewLeaseAndExperienceLifecycle(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "galaxy-id.json"), []byte(`{"id":"isolated-owner"}`), 0600); err != nil {
		t.Fatal(err)
	}
	store, err := NewStore(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	obs := WorkObservationInput{Host: "opencode", SessionID: "session-a", SourceID: "observation-1", Kind: "message", Source: WorkSource{Kind: "user-statement"}, Content: &WorkContent{Excerpt: "数据库连接失败", Retained: "excerpt"}, Details: json.RawMessage(`{}`)}
	if _, err = store.ObserveWork(ctx, obs); err != nil {
		t.Fatal(err)
	}
	request := WorkReviewRequest{Host: "opencode", SessionID: "session-a"}
	first, err := store.PrepareWorkReview(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := first.(map[string]any)
	if snapshot["status"] != "ready" {
		t.Fatal(snapshot)
	}
	busy, err := store.PrepareWorkReview(ctx, request)
	if err != nil || busy.(map[string]any)["status"] != "busy" {
		t.Fatal(busy, err)
	}
	request.ReviewID = text(snapshot["reviewId"])
	result, err := store.ApplyWorkReview(ctx, WorkReviewApply{WorkReviewRequest: request, Summary: &WorkReviewSummary{Title: "排查连接", Summary: "检查数据库连接", Outcome: "partial"}, Experiences: []WorkExperienceInput{{Title: "数据库连接检查", Conditions: "数据库连接超时", Method: "检查网络和端口", Limitations: "实际权限未知"}}})
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]any)["summarySaved"] != true {
		t.Fatal(result)
	}
	empty, err := store.PrepareWorkReview(ctx, WorkReviewRequest{Host: "opencode", SessionID: "session-a"})
	if err != nil || empty.(map[string]any)["status"] != "empty" {
		t.Fatal(empty, err)
	}
	found, err := store.SearchWorkExperience(ctx, WorkExperienceQuery{Query: "数据库连接"})
	if err != nil {
		t.Fatal(err)
	}
	items := found.(map[string]any)["items"].([]any)
	if len(items) != 1 {
		t.Fatal(found)
	}
	item := items[0].(map[string]any)
	if item["method"] != nil {
		t.Fatal("search returned full method")
	}
	id := text(item["id"])
	detail, err := store.GetWorkExperience(ctx, WorkExperienceQuery{ID: id})
	if err != nil || detail.(map[string]any)["method"] != "检查网络和端口" {
		t.Fatal(detail, err)
	}
	obs.SourceID = "observation-2"
	if _, err = store.ObserveWork(ctx, obs); err != nil {
		t.Fatal(err)
	}
	next, err := store.PrepareWorkReview(ctx, WorkReviewRequest{Host: "opencode", SessionID: "session-a"})
	if err != nil {
		t.Fatal(err)
	}
	request.ReviewID = text(next.(map[string]any)["reviewId"])
	bad := int64(0)
	_, err = store.ApplyWorkReview(ctx, WorkReviewApply{WorkReviewRequest: request, Experiences: []WorkExperienceInput{{ID: id, ExpectedRevision: &bad, Title: "修正", Conditions: "数据库连接超时", Method: "读取真实错误"}}})
	if fault.Code(err) != "local_work_review_conflict" {
		t.Fatal(err)
	}
	request.Reason = "local_work_model_rate_limit"
	if _, err = store.ReleaseWorkReview(ctx, request); err != nil {
		t.Fatal(err)
	}
	pending, err := store.WorkPending(ctx, WorkQuery{WorkID: text(snapshot["workId"])})
	if err != nil || uploadObject(uploadObject(pending)["processing"])["code"] != request.Reason || len(uploadRows(uploadObject(pending)["observations"])) == 0 {
		t.Fatal(pending, err)
	}
	request.Reason = ""
	again, err := store.PrepareWorkReview(ctx, WorkReviewRequest{Host: "opencode", SessionID: "session-a"})
	if err != nil || again.(map[string]any)["status"] != "ready" {
		t.Fatal(again, err)
	}
	request.ReviewID = text(again.(map[string]any)["reviewId"])
	if _, err = store.ApplyWorkReview(ctx, WorkReviewApply{WorkReviewRequest: request}); err != nil {
		t.Fatal(err)
	}
	if _, err = store.DeleteWork(ctx, WorkQuery{WorkID: text(snapshot["workId"])}); err != nil {
		t.Fatal(err)
	}
	retired, err := store.GetWorkExperience(ctx, WorkExperienceQuery{ID: id})
	if err != nil || retired.(map[string]any)["state"] != "retired" {
		t.Fatal(retired, err)
	}
}
func TestExperienceSourceDeletionRetainsIndependentEarlierRevision(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	if e := os.WriteFile(filepath.Join(dir, "galaxy-id.json"), []byte(`{"id":"isolated-owner"}`), 0600); e != nil {
		t.Fatal(e)
	}
	store, e := NewStore(dir, "")
	if e != nil {
		t.Fatal(e)
	}
	add := func(session, source string) string {
		t.Helper()
		result, e := store.ObserveWork(ctx, WorkObservationInput{Host: "opencode", SessionID: session, SourceID: source, Kind: "message", Source: WorkSource{Kind: "user-statement"}, Details: json.RawMessage(`{}`)})
		if e != nil {
			t.Fatal(e)
		}
		return text(result.(map[string]any)["workId"])
	}
	first, second := add("session-a", "a"), add("session-b", "b")
	created, e := store.UpsertWorkExperience(ctx, WorkExperienceInput{WorkID: first, Title: "连接数据库", Conditions: "网络受限", Method: "检查端口"})
	if e != nil {
		t.Fatal(e)
	}
	id := text(created.(map[string]any)["id"])
	revision := int64(1)
	updated, e := store.UpsertWorkExperience(ctx, WorkExperienceInput{ID: id, ExpectedRevision: &revision, WorkID: second, Title: "连接数据库", Conditions: "网络受限", Method: "先检查 DNS"})
	if e != nil {
		t.Fatal(e)
	}
	sources := updated.(map[string]any)["sourceWorkIds"].([]string)
	if len(sources) != 2 {
		t.Fatal(sources)
	}
	if _, e = store.DeleteWork(ctx, WorkQuery{WorkID: second}); e != nil {
		t.Fatal(e)
	}
	detail, e := store.GetWorkExperience(ctx, WorkExperienceQuery{ID: id})
	if e != nil {
		t.Fatal(e)
	}
	view := detail.(map[string]any)
	versions := view["versions"].([]any)
	if view["state"] != "retired" || len(versions) != 1 || uploadObject(versions[0])["method"] != "检查端口" {
		t.Fatal(view)
	}
	result, e := store.SearchWorkExperience(ctx, WorkExperienceQuery{Query: "数据库连接"})
	if e != nil || len(result.(map[string]any)["items"].([]any)) != 0 {
		t.Fatal(result, e)
	}
}

func TestReviewDoesNotOverwriteIndexOnlyExperience(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	if e := os.WriteFile(filepath.Join(dir, "galaxy-id.json"), []byte(`{"id":"isolated-owner"}`), 0600); e != nil {
		t.Fatal(e)
	}
	store, e := NewStore(dir, "")
	if e != nil {
		t.Fatal(e)
	}
	obs := WorkObservationInput{Host: "opencode", SessionID: "session", SourceID: "one", Kind: "message", Source: WorkSource{Kind: "user-statement"}, Content: &WorkContent{Excerpt: "数据库连接问题", Retained: "excerpt"}, Details: json.RawMessage(`{}`)}
	recorded, e := store.ObserveWork(ctx, obs)
	if e != nil {
		t.Fatal(e)
	}
	work := text(recorded.(map[string]any)["workId"])
	method := strings.Repeat("方法", 5000)
	saved, e := store.UpsertWorkExperience(ctx, WorkExperienceInput{WorkID: work, Title: "数据库连接问题", Conditions: "数据库连接问题", Method: method})
	if e != nil {
		t.Fatal(e)
	}
	id := text(saved.(map[string]any)["id"])
	req := WorkReviewRequest{Host: "opencode", SessionID: "session"}
	prepared, e := store.PrepareWorkReview(ctx, req)
	if e != nil {
		t.Fatal(e)
	}
	snapshot := prepared.(map[string]any)
	candidates := snapshot["existingExperiences"].([]any)
	if len(candidates) != 1 || uploadObject(candidates[0])["complete"] != false || uploadObject(candidates[0])["method"] != nil {
		t.Fatal(candidates)
	}
	req.ReviewID = text(snapshot["reviewId"])
	rev := int64(1)
	_, e = store.ApplyWorkReview(ctx, WorkReviewApply{WorkReviewRequest: req, Experiences: []WorkExperienceInput{{ID: id, ExpectedRevision: &rev, Title: "数据库连接问题", Conditions: "数据库连接问题", Method: "片段"}}})
	if fault.Code(e) != "local_work_review_conflict" {
		t.Fatal(e)
	}
	detail, e := store.GetWorkExperience(ctx, WorkExperienceQuery{ID: id})
	if e != nil || detail.(map[string]any)["method"] != method {
		t.Fatal("full method not retained", e)
	}
}
