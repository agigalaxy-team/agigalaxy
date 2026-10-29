package community

import (
	"github.com/google/uuid"
	"testing"
)

func controls() Object {
	return Object{"schema": "business-controls/1", "features": Object{"forumPost": true, "forumReply": true, "chatSend": true, "attachmentUpload": true}, "lists": []Object{}, "rules": []Object{}}
}
func TestRulesUseOriginalThreeValuedPredicate(t *testing.T) {
	account := uuid.NewString()
	keyword, domainList, rule := uuid.NewString(), uuid.NewString(), uuid.NewString()
	config := controls()
	config["lists"] = []Object{{"id": keyword, "name": "关键词", "kind": "keyword", "enabled": true, "entries": []string{"ABC"}}, {"id": domainList, "name": "域名", "kind": "domain", "enabled": true, "entries": []string{"例子.测试"}}}
	config["rules"] = []Object{{"id": rule, "name": "原拒绝规则", "enabled": true, "targets": []string{"forum-post"}, "conditions": Object{"combinator": "or", "rules": []Object{{"field": "keywordList", "operator": "matches", "value": keyword}, {"field": "domainList", "operator": "matches", "value": domainList}}}, "action": "reject", "exceptions": []Object{}}}
	input := Object{"target": "forum-post", "accountId": account, "accountTier": "new", "subjectType": "person", "text": "全角ＡＢＣ 与 https://子.例子.测试/a", "links": []string{}, "attachmentCount": 0}
	normalized := object(t, encode(config))
	facts := Object{"accountTier": "new", "subjectType": "person", "attachmentCount": int64(0)}
	got, e := evaluateRules(normalized, "forum-post", account, facts, str(input, "text"), nil)
	if e != nil {
		t.Fatal(e)
	}
	if got.Outcome != "reject" || len(got.Matched) != 1 || got.Matched[0] != rule {
		t.Fatal("matching rejection changed", got)
	}
	exception := uuid.NewString()
	rr := config["rules"].([]Object)
	rr[0]["exceptions"] = []Object{{"id": exception, "name": "账户例外", "enabled": true, "accountIds": []string{account}}}
	normalized = object(t, encode(config))
	got, e = evaluateRules(normalized, "forum-post", account, facts, str(input, "text"), nil)
	if e != nil {
		t.Fatal(e)
	}
	if got.Outcome != "allow" || len(got.Exceptions) != 1 || got.Exceptions[0] != exception {
		t.Fatal("account exception changed", got)
	}
	rr[0]["conditions"] = Object{"combinator": "and", "rules": []Object{{"field": "subjectType", "operator": "eq", "value": "person"}}}
	rr[0]["exceptions"] = []Object{}
	delete(input, "subjectType")
	facts["subjectType"] = nil
	normalized = object(t, encode(config))
	got, e = evaluateRules(normalized, "forum-post", account, facts, str(input, "text"), nil)
	if e != nil {
		t.Fatal(e)
	}
	if got.Outcome != "unknown" {
		t.Fatal("missing subject fact was treated as known", got)
	}
}
