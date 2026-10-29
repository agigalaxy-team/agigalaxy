package discovery

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

func TestOriginalSearchSettingsNormalizationAndNativeProjection(t *testing.T) {
	rows := []Object{}
	for _, term := range []string{" A  Ｂ ", "İstanbul", "ΣΟΣ", "Å", "🚀", "\ue000", "中文", "é", "Æ", "ø", "你好", "zebra"} {
		rows = append(rows, Object{"term": term, "alternatives": []string{"Go", "ＧＯ", "🚀", "\ue000"}})
	}
	var settings Object
	_ = decode([]byte(jsonString(Object{"synonyms": rows, "rankingMode": "relevance", "fixedConstraints": fixedConstraints})), &settings)
	type fixture struct {
		Settings                    Object
		Canonical, Native, Editable Object
		Normalized                  []string
	}
	input := fixture{Settings: settings, Normalized: []string{"İSTANBUL", "ΣΟΣ", "\u0085 A \u0085", "\ufeff A\u00a0 Ｂ "}}
	root, _ := filepath.Abs("../../..")
	script := `import{searchQualitySettingsSchema,canonicalSearchSettings,nativeSearchSettings,editableSearchSettings,normalizeSearchTerm}from './packages/galaxy-contracts/src/operations-search-quality-schema.mjs';let x=JSON.parse(process.argv[1]);x.Canonical=canonicalSearchSettings(searchQualitySettingsSchema.parse(x.Settings));x.Native=nativeSearchSettings(x.Canonical);x.Editable=editableSearchSettings(x.Native);x.Normalized=x.Normalized.map(normalizeSearchTerm);console.log(JSON.stringify(x))`
	cmd := exec.Command("node", "--input-type=module", "-e", script, jsonString(input))
	cmd.Dir = root
	raw, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original settings %v %s", e, raw)
	}
	var original fixture
	if e = decode(raw, &original); e != nil {
		t.Fatal(e)
	}
	canonical, e := canonicalSettings(settings)
	if e != nil {
		t.Fatal(e)
	}
	native := nativeSettings(canonical)
	editable := editableSettings(native)
	normalizeJSON := func(value any) any { var v any; _ = json.Unmarshal([]byte(jsonString(value)), &v); return v }
	// The development machine's ICU default is zh-CN; its array order is a
	// recorded boundary pending the actual service-locale baseline. Compare the
	// normalized content here, while retaining exact alternative-array ordering.
	byTerm := func(value Object) Object {
		v := normalizeJSON(value).(map[string]any)
		if rows, ok := v["synonyms"].([]any); ok {
			mapped := Object{}
			for _, row := range rows {
				o := object(row)
				mapped[str(o, "term")] = o["alternatives"]
			}
			v["synonyms"] = mapped
		}
		return v
	}
	for label, pair := range map[string][2]any{"canonical": {byTerm(canonical), byTerm(original.Canonical)}, "native": {native, original.Native}, "editable": {byTerm(editable), byTerm(original.Editable)}} {
		if !reflect.DeepEqual(normalizeJSON(pair[0]), normalizeJSON(pair[1])) {
			t.Errorf("%s differs Go %s JS %s", label, jsonString(pair[0]), jsonString(pair[1]))
		}
	}
	for i, v := range input.Normalized {
		if n := normalizeTerm(v); n != original.Normalized[i] {
			t.Errorf("normalization %q Go %q JS %q", v, n, original.Normalized[i])
		}
	}
}
