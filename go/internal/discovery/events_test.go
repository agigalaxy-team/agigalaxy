package discovery

import (
	"strings"
	"testing"
)

func TestOriginalClosedEventPurposesAndNoCallerIdentity(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000001"
	version := "00000000-0000-4000-8000-000000000002"
	rows := []Object{}
	for name := range eventNames {
		for page := range pagePaths {
			input := Object{"eventId": id, "name": name, "pageKey": page}
			if strings.HasPrefix(name, "content-") || name == "search-click" || name == "not-interested" {
				input["content"] = Object{"kind": "post", "id": id, "version": version}
			}
			if name == "search" {
				input["query"] = " \ufeff Go \u00a0 "
			}
			rows = append(rows, input)
		}
	}
	base := Object{"eventId": id, "name": "pageview", "pageKey": "home"}
	for _, key := range []string{"accountId", "visitorId", "profileId", "purpose", "transport", "body", "title", "url", "privateMessages"} {
		input := merge(Object{}, base)
		input[key] = "caller-data"
		rows = append(rows, input)
	}
	for _, change := range []Object{{"query": "unexpected"}, {"content": nil}, {"eventId": "invalid"}, {"pageKey": "unknown"}, {"exposureId": id}, {"search": Object{"requestId": id}}, {"recommendation": Object{"requestId": id}}} {
		rows = append(rows, merge(merge(Object{}, base), change))
	}
	script := `import{discoveryEvent}from './packages/galaxy-official/src/discovery-runtime/purpose.mjs';let v=JSON.parse(process.argv[1]);console.log(JSON.stringify(v.map(input=>{try{return{value:discoveryEvent(input),code:null}}catch(e){return{value:null,code:e.code??'internal_error'}}})))`
	var original []Object
	if e := decode(originalNode(t, "", true, script, jsonString(rows)), &original); e != nil {
		t.Fatal(e)
	}
	for i, input := range rows {
		value, e := parseEvent(input)
		var code any
		if e != nil {
			code = errorCode(e)
		}
		if !sameValue(Object{"value": value, "code": code}, original[i]) {
			t.Errorf("event purpose %s/%s Go %s JS %s", input["name"], input["pageKey"], jsonString(Object{"value": value, "code": code}), jsonString(original[i]))
		}
	}
}
