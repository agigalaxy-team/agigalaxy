package discovery

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestOriginalZodCodePointBoundsAndExplicitUTF16Bounds(t *testing.T) {
	cases := []Object{}
	for _, n := range []int{80, 81, 160, 161, 200, 201, 500, 501} {
		value := strings.Repeat("🚀", n)
		event := Object{"eventId": uuid.NewString(), "name": "search", "pageKey": "search", "query": value}
		search := Object{"query": value}
		settings := Object{"synonyms": []any{Object{"term": value, "alternatives": []string{"x"}}}, "rankingMode": "relevance", "fixedConstraints": fixedConstraints}
		quality := Object{"operationId": uuid.NewString(), "expectedRevision": 0, "versionId": uuid.NewString(), "reason": value}
		theme := Object{"operationId": uuid.NewString(), "expectedVersion": 0, "enabled": true, "reason": value, "label": value, "mapping": Object{"categories": []string{}, "tagIds": []string{}, "queryTerms": []string{value}}}
		legacy := Object{"type": "proof", "query": Object{"query": value}}
		_, ee := parseEvent(event)
		_, se := parseSearch(search)
		_, ce := canonicalSettings(settings)
		_, qe := parseQualityInput("apply", quality)
		_, te := parseRecommendationCommand("theme", theme)
		_, _, le := parseLegacySearch([]byte(jsonString(legacy)))
		cases = append(cases, Object{"event": event, "search": search, "settings": settings, "quality": quality, "theme": theme, "legacy": legacy, "got": []bool{ee == nil, se == nil, ce == nil, qe == nil, te == nil, le == nil}})
	}
	path := filepath.Join(t.TempDir(), "bounds.json")
	if e := os.WriteFile(path, []byte(jsonString(cases)), 0600); e != nil {
		t.Fatal(e)
	}
	script := `import{readFile}from 'node:fs/promises';import{discoveryEventSchema,discoverySearchSchema}from './packages/galaxy-official/src/discovery-runtime/purpose.mjs';import{searchQualitySettingsSchema,searchQualityApplySchema}from './packages/galaxy-official/src/shared/operations-search-quality-schema.mjs';import{recommendationThemeSaveSchema}from './packages/galaxy-official/src/shared/operations-recommendation-schema.mjs';import{searchQuerySchema}from './packages/galaxy-official/src/shared/search-schema.mjs';let bad=[];for(const [i,c]of JSON.parse(await readFile(process.argv[1],'utf8')).entries()){const actual=[discoveryEventSchema.safeParse(c.event).success,discoverySearchSchema.safeParse(c.search).success,searchQualitySettingsSchema.safeParse(c.settings).success,searchQualityApplySchema.safeParse(c.quality).success,recommendationThemeSaveSchema.safeParse(c.theme).success,searchQuerySchema.safeParse(c.legacy).success];if(JSON.stringify(actual)!==JSON.stringify(c.got))bad.push({i,actual,got:c.got})}console.log(JSON.stringify(bad))`
	var bad []any
	if e := decode(originalNode(t, "", true, script, path), &bad); e != nil {
		t.Fatal(e)
	}
	if len(bad) > 0 {
		t.Fatalf("original Zod astral bounds differ %s", jsonString(bad))
	}
	// These two source guards are explicit JS .length, separate from Zod max.
	_, e := controlledSettings(Object{"synonyms": Object{strings.Repeat("🚀", 101): []string{"x"}}, "rankingRules": []string{"words"}})
	if e == nil {
		t.Fatal("explicit native UTF16 length was relaxed")
	}
}
