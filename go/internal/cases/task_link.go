package cases

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"reflect"
	"sort"
)

func parsedLink(raw []byte) (Object, error) {
	var c Object
	if protocol.Decode(raw, &c) != nil || !shape(c, []string{"operationId", "taskId", "expectedTaskVersion", "case", "initialFact"}, nil) || !uuidField(c, "operationId") || !uuidField(c, "taskId") || !integer(c, "expectedTaskVersion", 1) {
		return nil, fault.New("invalid_case_task_link", 400)
	}
	for _, k := range []string{"case", "initialFact"} {
		if _, _, e := envelope(encode(c[k])); e != nil {
			return nil, fault.New("invalid_case_task_link", 400)
		}
	}
	return c, nil
}
func ordered(fields ...any) *protocol.OrderedObject {
	o := protocol.NewOrderedObject()
	for i := 0; i < len(fields); i += 2 {
		o.Set(fields[i].(string), fields[i+1])
	}
	return o
}
func linkHashes(c Object) (string, string, error) {
	first, last := object(c["case"]), object(c["initialFact"])
	current := Object{"operationId": c["operationId"], "taskId": c["taskId"], "expectedTaskVersion": c["expectedTaskVersion"], "case": Object{"payloadJson": first["payloadJson"]}, "initialFact": Object{"payloadJson": last["payloadJson"]}}
	raw, e := identity.Canonical(current)
	if e != nil {
		return "", "", e
	}
	legacy := ordered("operationId", c["operationId"], "taskId", c["taskId"], "expectedTaskVersion", c["expectedTaskVersion"], "case", ordered("consentId", first["consentId"], "payloadJson", first["payloadJson"]), "initialFact", ordered("consentId", last["consentId"], "payloadJson", last["payloadJson"]))
	old, e := protocol.EncodeJS(legacy)
	if e != nil {
		return "", "", e
	}
	return identity.Digest(raw), identity.Digest(old), nil
}
func materialContainer(request Object) bool {
	if len(list(request["materials"])) > 0 {
		return true
	}
	fields := []any{request["title"], request["summary"], object(request["workContext"])["goal"], object(request["workContext"])["currentSituation"]}
	if expected, ok := request["expectedOutcome"]; ok {
		fields = append(fields, expected)
	}
	for _, v := range fields {
		if _, ok := v.(string); !ok {
			return true
		}
	}
	return false
}
func (s *Service) CreateAndLinkTask(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	command, e := parsedLink(raw)
	if e != nil {
		return nil, e
	}
	if s.AttachCase == nil || s.TaskWrite == nil {
		return nil, fault.New("task_service_unavailable", 503)
	}
	rootRequest, initialRequest := object(command["case"]), object(command["initialFact"])
	root, e := parseFact(text(rootRequest, "payloadJson"))
	if e != nil {
		return nil, e
	}
	initial, e := parseFact(text(initialRequest, "payloadJson"))
	if e != nil {
		return nil, e
	}
	taskID := text(command, "taskId")
	source := object(root["source"])
	if root["kind"] != "case-created" || root["taskId"] != taskID || source["kind"] != "active-task" || source["reference"] != taskID || root["actorId"] != a.SubjectID {
		return nil, fault.New("invalid_task_case_root", 422)
	}
	if !one(initial["kind"], "attempt-start", "intervention") || initial["caseId"] != root["caseId"] || initial["taskId"] != taskID || number(initial, "expectedVersion") != 1 {
		return nil, fault.New("initial_work_fact_required", 422)
	}
	return s.run(ctx, a, true, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		task, e := s.TaskWrite(ctx, tx, a, taskID)
		if e != nil {
			return nil, e
		}
		hash, legacy, e := linkHashes(command)
		if e != nil {
			return nil, e
		}
		prior, e := queryOne(ctx, tx, `SELECT subject_id,task_id::text,case_id::text,payload_hash,receipt FROM case_task_links WHERE operation_id=$1`, command["operationId"])
		if e != nil {
			return nil, e
		}
		if prior != nil {
			if prior["subject_id"] != a.SubjectID || prior["task_id"] != taskID || (prior["payload_hash"] != hash && prior["payload_hash"] != legacy) {
				return nil, fault.New("event_conflict", 409)
			}
			for _, event := range []Object{root, initial} {
				row, e := queryOne(ctx, tx, `SELECT id::text,subject_id,consent_id::text,payload_text FROM case_events WHERE id=$1`, event["eventId"])
				if e != nil {
					return nil, e
				}
				if _, e = s.RequireEventVisibleWithin(ctx, tx, &a, row); e != nil {
					return nil, e
				}
			}
			out := copyObject(object(prior["receipt"]))
			out["operationId"] = command["operationId"]
			out["payloadHash"] = prior["payload_hash"]
			return out, nil
		}
		linked, e := queryOne(ctx, tx, `SELECT task_id::text FROM case_task_links WHERE task_id=$1`, taskID)
		if e != nil {
			return nil, e
		}
		if task["caseId"] != nil && task["caseId"] != "" || linked != nil {
			return nil, fault.New("task_case_link_conflict", 409)
		}
		if number(object(task["row"]), "version") != number(command, "expectedTaskVersion") {
			return nil, fault.New("task_version_conflict", 409)
		}
		var participation Object
		if task["requesterId"] != a.SubjectID {
			if text(root, "participationId") == "" || root["participationId"] != initial["participationId"] || root["actorId"] != initial["actorId"] || s.Participation == nil {
				return nil, fault.New("participation_required", 403)
			}
			participation, e = s.Participation(ctx, tx, a, taskID, text(root, "participationId"))
			if e != nil {
				return nil, e
			}
			if participation["subjectId"] != a.SubjectID || !one(participation["state"], "active", "delivered", "accepted", "disputed") {
				return nil, fault.New("participation_required", 403)
			}
			if participation["paused"] == true || one(participation["taskState"], "canceled", "closed") {
				return nil, fault.New("participation_paused", 403)
			}
			if number(root, "participationScopeVersion") != number(participation, "scopeVersion") || number(initial, "participationScopeVersion") != number(participation, "scopeVersion") {
				return nil, fault.New("participation_scope_changed", 409)
			}
			snapshot := object(task["snapshot"])
			if number(root, "taskScopeVersion") != number(snapshot, "scopeVersion") || number(initial, "taskScopeVersion") != number(snapshot, "scopeVersion") {
				return nil, fault.New("invalid_scope_version", 422)
			}
			request := object(snapshot["request"])
			title := request["title"]
			if materialContainer(request) {
				title = "这次求助的工作记录"
			}
			if root["title"] != title || root["summary"] != "任务协作记录，仅保存各参与者报告的实际工作。" {
				return nil, fault.New("invalid_task_case_root", 422)
			}
			grants := []deviceauth.ConsentIntent{}
			for i, r := range []Object{rootRequest, initialRequest} {
				event := []Object{root, initial}[i]
				g, e := s.grant(ctx, tx, Object{"id": event["eventId"], "subject_id": a.SubjectID, "consent_id": r["consentId"], "payload_text": r["payloadJson"]})
				if e != nil {
					return nil, e
				}
				grants = append(grants, g)
			}
			left, right := append([]string{}, grants[0].Viewers...), append([]string{}, grants[1].Viewers...)
			sort.Strings(left)
			sort.Strings(right)
			if grants[0].Visibility != "Private" || grants[1].Visibility != "Private" || !reflect.DeepEqual(left, right) {
				return nil, fault.New("disclosure_mismatch", 403)
			}
		}
		if _, e = s.SubmitV2Within(ctx, tx, a, encode(rootRequest), requestID, auth, SubmitOptions{AllowTaskRoot: true, OwnerID: text(task, "requesterId"), Participation: participation}); e != nil {
			return nil, e
		}
		linkedTask, e := s.AttachCase(ctx, tx, taskID, text(root, "caseId"), text(task, "requesterId"))
		if e != nil {
			return nil, e
		}
		fact, e := s.SubmitV2Within(ctx, tx, a, encode(initialRequest), requestID, auth, SubmitOptions{})
		if e != nil {
			return nil, e
		}
		receipt := Object{"operationId": command["operationId"], "payloadHash": hash, "caseId": root["caseId"], "taskId": taskID, "caseVersion": fact["caseVersion"], "taskVersion": linkedTask["version"], "taskCaseLinkVersion": int64(1), "synthetic": root["synthetic"], "failedAttemptsCreated": 0, "initialFact": fact["objectRef"]}
		if _, e = tx.Exec(ctx, `INSERT INTO case_task_links(task_id,case_id,operation_id,subject_id,payload_hash,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, taskID, root["caseId"], command["operationId"], a.SubjectID, hash, string(encode(receipt))); e != nil {
			return nil, e
		}
		return receipt, nil
	})
}
