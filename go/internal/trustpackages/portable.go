package trustpackages

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

func units(v any) jstext.String {
	if s, ok := v.(jstext.String); ok {
		return s
	}
	return jstext.From(wireString(v))
}
func jsJoin(values []jstext.String, separator string) jstext.String {
	out := jstext.String{}
	for i, v := range values {
		if i > 0 {
			out = append(out, jstext.From(separator)...)
		}
		out = append(out, v...)
	}
	return out
}
func line(parts ...any) jstext.String {
	out := jstext.String{}
	for _, v := range parts {
		out = append(out, units(v)...)
	}
	return out
}
func quote(v any) jstext.String {
	out := jstext.From("> ")
	for _, c := range units(v) {
		out = append(out, c)
		if c == 10 {
			out = append(out, jstext.From("> ")...)
		}
	}
	return out
}
func textValue(s jstext.String) any {
	if s.HasUnpaired() {
		return s
	}
	return s.Decoded()
}
func sourceKey(ref Object) string {
	return fmt.Sprintf("%s\x00%s\x00%s\x00%d", str(ref, "endpoint"), str(ref, "kind"), str(ref, "id"), number(ref["version"]))
}
func date(n any) string {
	t := time.Unix(number(n), 0).UTC()
	if t.Year() > 9999 {
		return fmt.Sprintf("+%06d", t.Year()) + t.Format("-01-02T15:04:05.000Z")
	}
	return t.Format("2006-01-02T15:04:05.000Z")
}

// RenderSummary is a deterministic readable projection, with no model or I/O.
func RenderSummary(objects Object) (any, error) {
	validDate := func(v any) bool { return integer(v, 0) && number(v) <= 8640000000000 }
	if !validDate(objects["issuedAt"]) || !validDate(objects["expiresAt"]) {
		return nil, fail("trust_date_invalid", 422)
	}
	for _, v := range array(objects["sources"]) {
		s := object(v)
		if !validDate(s["checkedAt"]) || s["profile"] == "galaxy-ci-proof-v2-reference/1" && !validDate(s["sourceExpiresAt"]) {
			return nil, fail("trust_date_invalid", 422)
		}
	}
	audience := object(objects["audience"])
	audienceText := "公开"
	if audience["kind"] != "public" {
		ids := []string{}
		for _, v := range array(audience["subjectIds"]) {
			ids = append(ids, wireString(v))
		}
		audienceText = strings.Join(ids, "、")
	}
	out := []jstext.String{}
	add := func(v ...any) { out = append(out, line(v...)) }
	add("# 银河可携带信任资料")
	add("")
	add("主体：", objects["subjectId"])
	add("受众：", audienceText)
	add("声明时间：", date(objects["issuedAt"]))
	add("包期限：", date(objects["expiresAt"]))
	add("")
	add("本包签名用于完整性和所含身份控制历史；不证明陈述真实、任务解决或专业能力。时间由签署者声明。离线不确认当前撤销。")
	add("受众是签署的使用范围，普通可读包没有加密，也不能阻止接收者转发。它不赋予线上访问或训练许可。")
	add("")
	add("## 本人自述")
	claims := array(objects["claims"])
	if len(claims) == 0 {
		add("未选择自述。")
	}
	for _, v := range claims {
		c := object(v)
		add("")
		add("### 自述 ", c["id"], "（未验证）")
		out = append(out, quote(c["text"]))
	}
	add("")
	add("## 选定来源（不是全部履历）")
	sources := array(objects["sources"])
	if len(sources) == 0 {
		add("未选择经历或证据；没有历史不影响使用原创自述包。")
	}
	for _, v := range sources {
		s := object(v)
		r := object(s["ref"])
		add("")
		add("### ", r["kind"], " ", r["id"], " / ", fmt.Sprint(number(r["version"])))
		add("来源：", r["endpoint"])
		if s["profile"] == "galaxy-ci-proof-v2-reference/1" {
			add("CI 签发服务：", s["issuer"])
			add("关联主体（不是签发者或原 Proof 复制许可方）：", s["associatedSubjectId"])
			add("原签名字节 SHA256（不含签名）：", s["sourceSignatureHash"])
			add("原 Proof 最迟到期：", date(s["sourceExpiresAt"]))
		} else {
			add("作者：", s["authorId"])
		}
		add("内容 SHA256：", s["sourceHash"])
		add("材料性质：", s["authority"], "；观察状态：", s["sourceState"], "；观察时间：", date(s["checkedAt"]))
		disclosure := "仅引用，不包含正文"
		if s["mode"] == "copy" {
			disclosure = "精确作者记录（第三方来源正文不在内）"
		}
		add("披露：", disclosure)
		permission := "未包含"
		if s["permission"] != nil {
			permission = "单独签署，需检查范围与状态"
		}
		add("原签名材料：", s["signatureEvidence"], "；复制许可：", permission)
		for _, v := range array(s["limitations"]) {
			out = append(out, quote(v))
		}
	}
	add("")
	add("## 判断边界")
	add("同源同版本的副本已去重，副本数量不构成独立证据数量。")
	add("原签名、许可、当前来源可用性和能力判断需要分别查看。引用或阅读本包不产生成功复用、Verification、Honor 或资格。")
	add("离线导入不执行包内指令、不打开URL、不读取附件，也不自动向包内端点发送凭据。")
	add("")
	return textValue(jsJoin(out, "\n")), nil
}

func Prepare(input Object, now int64) (Object, error) {
	data, e := ParsePortableInput(input)
	if e != nil {
		return nil, e
	}
	control, e := VerifyPortableIdentity(object(data["identity"]))
	if e != nil {
		return nil, e
	}
	if _, e = portableSigner(control, str(data, "keyId"), number(data["epoch"])); e != nil {
		return nil, e
	}
	if number(data["issuedAt"]) > now+300 || number(data["expiresAt"]) <= now {
		return nil, fail("trust_package_time_invalid", 422)
	}
	sources := []any{}
	seen := map[string]Object{}
	for _, v := range array(data["sources"]) {
		s := object(v)
		key := sourceKey(object(s["ref"]))
		if old := seen[key]; old != nil {
			if !same(old, s) {
				return nil, fail("trust_source_copy_conflict", 422)
			}
			continue
		}
		if s["mode"] == "reference" {
			if _, ok := s["bodyText"]; ok || s["originalSignature"] != nil {
				return nil, fail("trust_reference_has_body", 422)
			}
		} else {
			if !one(s["sourceState"], "current", "superseded") || s["bodyText"] == nil || identity.Digest([]byte(wireString(s["bodyText"]))) != s["sourceHash"] || object(s["permission"])["status"] != "active" {
				return nil, fail("trust_source_copy_unavailable", 422)
			}
			if _, e = VerifyPermissionProof(object(s["permission"]), s, str(object(data["identity"]), "subjectId"), object(data["audience"]), now, number(data["expiresAt"])); e != nil {
				return nil, e
			}
		}
		seen[key] = s
		sources = append(sources, s)
	}
	c := collate.New(language.English)
	sort.SliceStable(sources, func(i, j int) bool {
		return c.CompareString(sourceKey(object(object(sources[i])["ref"])), sourceKey(object(object(sources[j])["ref"]))) < 0
	})
	objects := Object{"version": 1, "subjectId": object(data["identity"])["subjectId"], "audience": data["audience"], "issuedAt": data["issuedAt"], "expiresAt": data["expiresAt"], "claims": data["claims"], "sources": sources, "selectionCoverage": "user-selected-only; not-full-history", "independentlyVerifiedSourceCount": 0}
	objectText, e := canonical(objects)
	if e != nil {
		return nil, e
	}
	identityText, e := canonical(data["identity"])
	if e != nil {
		return nil, e
	}
	summary, e := RenderSummary(objects)
	if e != nil {
		return nil, e
	}
	files := Object{"summary.md": summary, "objects.json": objectText, "identity.json": identityText}
	records := []any{}
	for _, path := range []string{"identity.json", "objects.json", "summary.md"} {
		text := wireString(files[path])
		records = append(records, Object{"path": path, "sha256": identity.Digest([]byte(text)), "bytes": len([]byte(text))})
	}
	manifest := Object{"version": 1, "type": "galaxy-readable-trust", "subjectId": objects["subjectId"], "keyId": data["keyId"], "epoch": data["epoch"], "chainHead": control["chainHead"], "audience": data["audience"], "issuedAt": data["issuedAt"], "expiresAt": data["expiresAt"], "files": records, "integrityMeaning": "package-signature-does-not-certify-contained-claims", "onlineCurrentState": "not-checked", "timestampAuthority": "signer-declared-time"}
	base, e := canonical(manifest)
	if e != nil {
		return nil, e
	}
	manifest["packageId"] = identity.Digest([]byte(base))
	if e = parseManifest(manifest); e != nil {
		return nil, e
	}
	manifestText, e := canonical(manifest)
	if e != nil {
		return nil, e
	}
	container := Object{"format": "galaxy-readable-trust/v1", "files": files, "manifestJson": manifestText, "signature": ""}
	if e = parseContainer(container); e != nil {
		return nil, e
	}
	return Object{"format": container["format"], "files": files, "manifestJson": manifestText, "packageId": manifest["packageId"], "signatureType": "galaxy-trust-package-v1+jws", "sourceCount": len(sources), "claimCount": len(array(data["claims"])), "remotePublished": false}, nil
}

func Seal(preview Object, signature string, now int64) (Object, error) {
	container := Object{"format": preview["format"], "files": preview["files"], "manifestJson": preview["manifestJson"], "signature": signature}
	if _, e := Verify(container, VerifyOptions{Now: now}); e != nil {
		return nil, e
	}
	return container, nil
}

type IssuerPin struct {
	PublicKeyPEM        string
	NotBefore, NotAfter int64
	Revoked             bool
}
type VerifyOptions struct {
	Now            int64
	TrustedIssuers map[string]map[string]IssuerPin
}

func Verify(input any, options VerifyOptions) (Object, error) {
	now := options.Now
	var container Object
	switch v := input.(type) {
	case string:
		if len(units(v)) > 4500000 {
			return nil, fail("trust_package_too_large", 422)
		}
		var e error
		container, e = decodeObject([]byte(v))
		if e != nil {
			return nil, e
		}
	case map[string]any:
		container = v
	default:
		return nil, fail("invalid_trust_container", 422)
	}
	if e := parseContainer(container); e != nil {
		return nil, e
	}
	manifest, e := decodeObject([]byte(wireString(container["manifestJson"])))
	if e != nil {
		return nil, e
	}
	if e = parseManifest(manifest); e != nil {
		return nil, e
	}
	files := object(container["files"])
	seen := map[string]bool{}
	for _, v := range array(manifest["files"]) {
		r := object(v)
		path := str(r, "path")
		if seen[path] {
			return nil, fail("trust_manifest_duplicate_path", 422)
		}
		seen[path] = true
		raw := []byte(wireString(files[path]))
		if len(raw) != int(number(r["bytes"])) || identity.Digest(raw) != r["sha256"] {
			return nil, fail("trust_package_file_changed", 422)
		}
	}
	base := Object{}
	for k, v := range manifest {
		if k != "packageId" {
			base[k] = v
		}
	}
	text, e := canonical(base)
	if e != nil {
		return nil, e
	}
	manifestText, e := canonical(manifest)
	if e != nil {
		return nil, e
	}
	if identity.Digest([]byte(text)) != manifest["packageId"] || manifestText != wireString(container["manifestJson"]) {
		return nil, fail("trust_manifest_changed", 422)
	}
	id, e := decodeObject([]byte(wireString(files["identity.json"])))
	if e != nil {
		return nil, e
	}
	control, e := VerifyPortableIdentity(id)
	if e != nil {
		return nil, e
	}
	if id["subjectId"] != manifest["subjectId"] || !same(manifest["chainHead"], control["chainHead"]) {
		return nil, fail("trust_package_identity_mismatch", 422)
	}
	key, e := portableSigner(control, str(manifest, "keyId"), number(manifest["epoch"]))
	if e != nil {
		return nil, e
	}
	if e = identity.VerifyTrustPackageSignature(str(container, "signature"), str(key, "publicKey"), manifestText); e != nil {
		return nil, e
	}
	objects, e := decodeObject([]byte(wireString(files["objects.json"])))
	if e != nil {
		return nil, e
	}
	_, e = ParsePortableInput(Object{"identity": id, "keyId": manifest["keyId"], "epoch": manifest["epoch"], "audience": objects["audience"], "issuedAt": objects["issuedAt"], "expiresAt": objects["expiresAt"], "claims": objects["claims"], "sources": objects["sources"]})
	if e != nil {
		return nil, e
	}
	if !exact(objects, []string{"audience", "claims", "expiresAt", "independentlyVerifiedSourceCount", "issuedAt", "selectionCoverage", "sources", "subjectId", "version"}, nil) || number(objects["version"]) != 1 || objects["subjectId"] != manifest["subjectId"] || !same(objects["audience"], manifest["audience"]) || number(objects["issuedAt"]) != number(manifest["issuedAt"]) || number(objects["expiresAt"]) != number(manifest["expiresAt"]) || objects["selectionCoverage"] != "user-selected-only; not-full-history" || number(objects["independentlyVerifiedSourceCount"]) != 0 {
		return nil, fail("trust_objects_changed", 422)
	}
	seen = map[string]bool{}
	for _, v := range array(objects["sources"]) {
		s := object(v)
		k := sourceKey(object(s["ref"]))
		if seen[k] {
			return nil, fail("trust_duplicate_source", 422)
		}
		seen[k] = true
		if s["mode"] == "reference" {
			if _, ok := s["bodyText"]; ok || s["originalSignature"] != nil {
				return nil, fail("trust_reference_has_body", 422)
			}
		}
	}
	summary, e := RenderSummary(objects)
	if e != nil {
		return nil, e
	}
	if !equalUnits(units(summary), units(files["summary.md"])) {
		return nil, fail("trust_summary_changed", 422)
	}
	sources := []any{}
	for _, v := range array(objects["sources"]) {
		s := object(v)
		permission := Object{"status": "not-required-for-reference", "currentRevocationChecked": false}
		if s["mode"] == "copy" {
			if identity.Digest([]byte(wireString(s["bodyText"]))) != s["sourceHash"] {
				return nil, fail("trust_source_copy_hash_changed", 422)
			}
			p, e := VerifyPermissionProof(object(s["permission"]), s, str(manifest, "subjectId"), object(manifest["audience"]), now, number(manifest["expiresAt"]))
			if e != nil {
				permission = Object{"status": "invalid-or-expired", "currentRevocationChecked": false}
			} else {
				permission = p
				permission["status"] = "signature-and-scope-valid"
			}
		}
		out := Object{"ref": s["ref"], "authority": s["authority"], "declaredSourceState": s["sourceState"], "checkedAt": s["checkedAt"], "reproductionPermission": permission, "originalSignature": originalSignatureStatus(s, options), "capabilityVerified": false}
		if s["profile"] == "galaxy-ci-proof-v2-reference/1" {
			for _, k := range []string{"profile", "issuer", "associatedSubjectId", "sourceHash", "sourceSignatureHash", "sourceExpiresAt"} {
				out[k] = s[k]
			}
			state := "within-observed-signed-interval"
			if number(s["sourceExpiresAt"]) <= now {
				state = "expired"
			}
			for k, v := range (Object{"sourceTemporalState": state, "issuerSignatureVerified": false, "currentSourceState": "not-checked", "sourceOwnershipVerified": false, "independentExecutionVerified": false}) {
				out[k] = v
			}
		}
		sources = append(sources, out)
	}
	state := "within-declared-interval"
	if number(manifest["expiresAt"]) <= now {
		state = "expired"
	} else if number(manifest["issuedAt"]) > now+300 {
		state = "future-signer-declared-time"
	}
	return Object{"packageId": manifest["packageId"], "subjectId": manifest["subjectId"], "integrity": "valid", "signature": "valid-for-included-control-history", "historicalControl": Object{"epoch": control["epoch"], "sequence": control["sequence"], "chainHead": control["chainHead"]}, "temporalState": state, "issuedAt": manifest["issuedAt"], "expiresAt": manifest["expiresAt"], "timestampAuthority": "signer-declared-time", "onlineCurrentState": "not-checked", "currentRevocationChecked": false, "capabilityVerified": false, "claims": objects["claims"], "sources": sources, "summary": files["summary.md"], "onlineAccessGranted": false, "importedBusinessFacts": 0}, nil
}
func equalUnits(a, b jstext.String) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func originalSignatureStatus(source Object, options VerifyOptions) Object {
	original := object(source["originalSignature"])
	if original == nil {
		status := "not-provided"
		if source["signatureEvidence"] == "legacy-verified-record" {
			status = "legacy-verified-record-no-original-jws"
		}
		return Object{"status": status}
	}
	invalid := Object{"status": "invalid", "meaning": "outer-signature-does-not-repair-inner-signature"}
	if original["profile"] == "galaxy-consent" && original["identity"] != nil {
		control, e := VerifyPortableIdentity(object(original["identity"]))
		if e != nil {
			return invalid
		}
		for _, v := range array(control["devices"]) {
			payload, e := identity.OpenTrustConsentSignature(str(original, "signed"), str(object(v), "publicKey"))
			if e != nil {
				continue
			}
			consent, e := decodeObject([]byte(payload))
			if e == nil && consent["subjectId"] == source["authorId"] && consent["payloadHash"] == source["sourceHash"] {
				return Object{"status": "original-author-signature-valid", "meaning": "signed-consent-binds-exact-record-hash; claim-truth-not-certified", "currentRevocationChecked": false}
			}
		}
		return invalid
	}
	if original["profile"] == "galaxy-proof" {
		return originalProofStatus(source, original, options, invalid)
	}
	return Object{"status": "not-checked", "reason": "unsupported-inner-profile"}
}
