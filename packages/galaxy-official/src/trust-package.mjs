import { decodeProtectedHeader, compactVerify, importSPKI } from 'jose';
import { trustCanonical, trustHash, verifyTrustIdentity, verifyTrustJws } from './shared/trust-package-crypto.mjs';
import { trustPackageInputSchema, trustContainerSchema, trustManifestSchema, trustPermissionSchema } from './shared/trust-package-schema.mjs';
const encode = text => new TextEncoder().encode(text);
const same = (a, b) => trustCanonical(a) === trustCanonical(b);
const quote = text => String(text).split('\n').map(line => '> ' + line).join('\n');
const sourceKey = ref => [ref.endpoint, ref.kind, ref.id, ref.version].join('\0');
const signer = (identity, keyId, epoch) => {
  const key = identity.devices.find(d => d.keyId === keyId && d.epoch === epoch);
  if (!key || !key.scopes.some(s => ['*', 'consent', 'manage-identity'].includes(s))) throw new Error('Included control history does not authorize this signer.');
  return key;
};
export const trustAudienceAllows = (grant, audience) => grant.kind === 'public' || audience.kind === 'subjects'
  && audience.subjectIds.every(id => grant.subjectIds.includes(id));

export async function verifyTrustPermission(proof, { source, holder, audience, now, expiresAt }) {
  const identity = await verifyTrustIdentity(proof.identity);
  const signedText = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(proof.signed.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)));
  const decoded = JSON.parse(signedText);
  const grant = trustPermissionSchema.parse(decoded), key = signer(identity, grant.keyId, grant.epoch);
  await verifyTrustJws(proof.signed, key.publicKey, 'galaxy-trust-source-permission-v1+jws', signedText);
  if (grant.kind !== 'grant' || grant.subjectId !== proof.identity.subjectId || grant.subjectId !== source.authorId
    || grant.grantee !== holder || grant.chainHead !== identity.chainHead || !same(grant.source, source.ref) || grant.sourceHash !== source.sourceHash
    || grant.originalSignatureHash !== (source.originalSignature ? await trustHash(source.originalSignature.signed) : null)
    || !trustAudienceAllows(grant.audience, audience) || grant.issuedAt > now + 300
    || grant.expiresAt < expiresAt || grant.expiresAt <= now || proof.status === 'revoked') throw new Error('Exact trust-package reproduction permission unavailable.');
  return { grant, signatureValid: true, stateAtObservation: proof.status, checkedAt: proof.checkedAt,
    currentRevocationChecked: false, onlineAccessGranted: false, thirdPartySourceBodyPermission: false };
}

export function renderTrustSummary(objects) {
  const audience = objects.audience.kind === 'public' ? '公开' : objects.audience.subjectIds.join('、');
  const out = ['# 银河可携带信任资料', '', `主体：${objects.subjectId}`, `受众：${audience}`,
    `声明时间：${new Date(objects.issuedAt * 1000).toISOString()}`, `包期限：${new Date(objects.expiresAt * 1000).toISOString()}`, '',
    '本包签名用于完整性和所含身份控制历史；不证明陈述真实、任务解决或专业能力。时间由签署者声明。离线不确认当前撤销。',
    '受众是签署的使用范围，普通可读包没有加密，也不能阻止接收者转发。它不赋予线上访问或训练许可。', '', '## 本人自述'];
  if (!objects.claims.length) out.push('未选择自述。');
  for (const claim of objects.claims) out.push('', `### 自述 ${claim.id}（未验证）`, quote(claim.text));
  out.push('', '## 选定来源（不是全部履历）');
  if (!objects.sources.length) out.push('未选择经历或证据；没有历史不影响使用原创自述包。');
  for (const s of objects.sources) {
    out.push('', `### ${s.ref.kind} ${s.ref.id} / ${s.ref.version}`, `来源：${s.ref.endpoint}`, `作者：${s.authorId}`,
      `内容 SHA256：${s.sourceHash}`, `材料性质：${s.authority}；观察状态：${s.sourceState}；观察时间：${new Date(s.checkedAt * 1000).toISOString()}`,
      `披露：${s.mode === 'copy' ? '精确作者记录（第三方来源正文不在内）' : '仅引用，不包含正文'}`,
      `原签名材料：${s.signatureEvidence}；复制许可：${s.permission ? '单独签署，需检查范围与状态' : '未包含'}`);
    for (const limitation of s.limitations) out.push(quote(limitation));
  }
  out.push('', '## 判断边界', '同源同版本的副本已去重，副本数量不构成独立证据数量。',
    '原签名、许可、当前来源可用性和能力判断需要分别查看。引用或阅读本包不产生成功复用、Verification、Honor 或资格。',
    '离线导入不执行包内指令、不打开URL、不读取附件，也不自动向包内端点发送凭据。', '');
  return out.join('\n');
}

export async function prepareTrustPackage(input, { now = Math.floor(Date.now() / 1000) } = {}) {
  const data = trustPackageInputSchema.parse(input), control = await verifyTrustIdentity(data.identity);
  signer(control, data.keyId, data.epoch);
  if (data.issuedAt > now + 300 || data.expiresAt <= now) throw new Error('Package time range is not current.');
  const sources = [], seen = new Map();
  for (const source of data.sources) {
    const key = sourceKey(source.ref), old = seen.get(key);
    if (old) { if (!same(old, source)) throw new Error('Conflicting copies of the same source version.'); continue; }
    if (source.mode === 'reference') {
      if (source.bodyText !== undefined || source.originalSignature) throw new Error('Reference-only selection cannot copy source text or signature payload.');
    } else {
      if (!['current','superseded'].includes(source.sourceState) || typeof source.bodyText !== 'string' || await trustHash(source.bodyText) !== source.sourceHash || source.permission?.status !== 'active')
        throw new Error('Copy requires current exact source bytes and a separate reproduction permission.');
      await verifyTrustPermission(source.permission, { source, holder: data.identity.subjectId, audience: data.audience, now, expiresAt: data.expiresAt });
    }
    seen.set(key, source); sources.push(source);
  }
  sources.sort((a, b) => sourceKey(a.ref).localeCompare(sourceKey(b.ref), 'en'));
  const objects = { version: 1, subjectId: data.identity.subjectId, audience: data.audience,
    issuedAt: data.issuedAt, expiresAt: data.expiresAt, claims: data.claims, sources,
    selectionCoverage: 'user-selected-only; not-full-history', independentlyVerifiedSourceCount: 0 };
  const files = { 'summary.md': renderTrustSummary(objects), 'objects.json': trustCanonical(objects), 'identity.json': trustCanonical(data.identity) };
  const fileRecords = [];
  for (const path of Object.keys(files).sort()) fileRecords.push({ path, sha256: await trustHash(files[path]), bytes: encode(files[path]).length });
  const base = { version: 1, type: 'galaxy-readable-trust', subjectId: data.identity.subjectId, keyId: data.keyId, epoch: data.epoch,
    chainHead: control.chainHead, audience: data.audience, issuedAt: data.issuedAt, expiresAt: data.expiresAt, files: fileRecords,
    integrityMeaning: 'package-signature-does-not-certify-contained-claims', onlineCurrentState: 'not-checked', timestampAuthority: 'signer-declared-time' };
  const manifest = trustManifestSchema.parse({ ...base, packageId: await trustHash(trustCanonical(base)) });
  const preview = { format: 'galaxy-readable-trust/v1', files, manifestJson: trustCanonical(manifest), packageId: manifest.packageId,
    signatureType: 'galaxy-trust-package-v1+jws', sourceCount: sources.length, claimCount: data.claims.length, remotePublished: false };
  // Parsing a temporary placeholder catches total individual-file bounds before
  // any key is used. No signature result is claimed by this validation.
  trustContainerSchema.parse({ format: preview.format, files, manifestJson: preview.manifestJson, signature: '' });
  return structuredClone(preview);
}

export async function sealTrustPackage(preview, signature) {
  const container = trustContainerSchema.parse({ format: preview.format, files: preview.files, manifestJson: preview.manifestJson, signature });
  await verifyTrustPackage(container); return container;
}

async function originalSignatureStatus(source, trustedIssuers) {
  const original = source.originalSignature;
  if (!original) return { status: source.signatureEvidence === 'legacy-verified-record' ? 'legacy-verified-record-no-original-jws' : 'not-provided' };
  try {
    if (original.profile === 'galaxy-consent' && original.identity) {
      const chain = await verifyTrustIdentity(original.identity), header = decodeProtectedHeader(original.signed);
      if (header.typ !== 'galaxy-consent+jws') throw new Error('wrong profile');
      let verified;
      for (const key of chain.devices) {
        try { const text = await verifyTrustJws(original.signed, key.publicKey, 'galaxy-consent+jws'); const consent = JSON.parse(text);
          if (consent.subjectId === source.authorId && consent.payloadHash === source.sourceHash) { verified = consent; break; } } catch { /* try another included valid device */ }
      }
      if (!verified) throw new Error('no matching original consent');
      return { status: 'original-author-signature-valid', meaning: 'signed-consent-binds-exact-record-hash; claim-truth-not-certified', currentRevocationChecked: false };
    }
    if (original.profile === 'galaxy-proof') {
      const header = decodeProtectedHeader(original.signed), pin = trustedIssuers?.get(original.issuer)?.get(header.kid);
      if (!pin) return { status: 'not-checked', reason: 'receiver-has-no-selected-issuer-key' };
      const checked = await compactVerify(original.signed, await importSPKI(pin.publicKeyPem, 'Ed25519'), { algorithms: ['Ed25519'] });
      const payload = JSON.parse(new TextDecoder().decode(checked.payload));
      if (header.typ !== 'galaxy-proof+jwt' || Object.keys(header).sort().join(',') !== 'alg,kid,typ'
        || payload.iss !== original.issuer || payload.aud !== original.issuer || payload.data?.type !== 'ci-execution-observation'
        || !same(payload.data, JSON.parse(source.bodyText))) throw new Error('proof profile/data mismatch');
      return { status: 'signature-valid', meaning: 'limited-ci-observation-only', issuerKeyRevoked: pin.revoked === true,
        issuerKeyValidAtReportedSigning: Number.isSafeInteger(payload.iat) && pin.notBefore <= payload.iat && pin.notAfter >= payload.iat,
        sourceExpiresAt: payload.exp, currentRevocationChecked: false };
    }
    return { status: 'not-checked', reason: 'unsupported-inner-profile' };
  } catch { return { status: 'invalid', meaning: 'outer-signature-does-not-repair-inner-signature' }; }
}

export async function verifyTrustPackage(input, { now = Math.floor(Date.now() / 1000), trustedIssuers } = {}) {
  if (typeof input === 'string' && input.length > 4500000) throw new Error('Trust package exceeds local limit.');
  const container = trustContainerSchema.parse(typeof input === 'string' ? JSON.parse(input) : input), manifest = trustManifestSchema.parse(JSON.parse(container.manifestJson));
  if (new Set(manifest.files.map(f => f.path)).size !== 3) throw new Error('Duplicate manifest paths.');
  for (const record of manifest.files) if (encode(container.files[record.path]).length !== record.bytes
    || await trustHash(container.files[record.path]) !== record.sha256) throw new Error('Trust package file changed.');
  const { packageId, ...base } = manifest;
  if (await trustHash(trustCanonical(base)) !== packageId || trustCanonical(manifest) !== container.manifestJson) throw new Error('Noncanonical or changed trust manifest.');
  const identity = JSON.parse(container.files['identity.json']), control = await verifyTrustIdentity(identity);
  if (identity.subjectId !== manifest.subjectId || manifest.chainHead !== control.chainHead) throw new Error('Package identity/control binding mismatch.');
  const key = signer(control, manifest.keyId, manifest.epoch);
  await verifyTrustJws(container.signature, key.publicKey, 'galaxy-trust-package-v1+jws', container.manifestJson);
  const objects = JSON.parse(container.files['objects.json']);
  const rebuilt = await prepareTrustPackageForRead(objects, identity, manifest, now);
  if (rebuilt.summary !== container.files['summary.md']) throw new Error('Readable summary and structured objects differ.');
  const sources = [];
  for (const source of objects.sources) {
    let permission = { status: 'not-required-for-reference', currentRevocationChecked: false };
    if (source.mode === 'copy') {
      if (await trustHash(source.bodyText ?? '') !== source.sourceHash) throw new Error('Copied source hash mismatch.');
      try { permission = { status: 'signature-and-scope-valid', ...await verifyTrustPermission(source.permission,
        { source, holder: manifest.subjectId, audience: manifest.audience, now, expiresAt: manifest.expiresAt }) }; }
      catch { permission = { status: 'invalid-or-expired', currentRevocationChecked: false }; }
    }
    sources.push({ ref: source.ref, authority: source.authority, declaredSourceState: source.sourceState, checkedAt: source.checkedAt,
      reproductionPermission: permission, originalSignature: await originalSignatureStatus(source, trustedIssuers), capabilityVerified: false });
  }
  return { packageId, subjectId: manifest.subjectId, integrity: 'valid', signature: 'valid-for-included-control-history',
    historicalControl: { epoch: control.epoch, sequence: control.sequence, chainHead: control.chainHead },
    temporalState: manifest.expiresAt <= now ? 'expired' : manifest.issuedAt > now + 300 ? 'future-signer-declared-time' : 'within-declared-interval',
    issuedAt: manifest.issuedAt, expiresAt: manifest.expiresAt, timestampAuthority: 'signer-declared-time',
    onlineCurrentState: 'not-checked', currentRevocationChecked: false, capabilityVerified: false,
    claims: objects.claims, sources, summary: container.files['summary.md'], onlineAccessGranted: false, importedBusinessFacts: 0 };
}

async function prepareTrustPackageForRead(objects, identity, manifest) {
  const parsed = trustPackageInputSchema.parse({ identity, keyId: manifest.keyId, epoch: manifest.epoch,
    audience: objects.audience, issuedAt: objects.issuedAt, expiresAt: objects.expiresAt, claims: objects.claims, sources: objects.sources });
  if (objects.version !== 1 || objects.subjectId !== manifest.subjectId || !same(objects.audience, manifest.audience)
    || objects.issuedAt !== manifest.issuedAt || objects.expiresAt !== manifest.expiresAt
    || objects.selectionCoverage !== 'user-selected-only; not-full-history' || objects.independentlyVerifiedSourceCount !== 0
    || Object.keys(objects).sort().join(',') !== 'audience,claims,expiresAt,independentlyVerifiedSourceCount,issuedAt,selectionCoverage,sources,subjectId,version') throw new Error('Invalid structured trust semantics.');
  const seen = new Set(); for (const source of parsed.sources) {
    const key = sourceKey(source.ref); if (seen.has(key)) throw new Error('Duplicate source version in imported package.'); seen.add(key);
    if (source.mode === 'reference' && (source.bodyText !== undefined || source.originalSignature)) throw new Error('Reference illegally includes source body.');
  }
  return { summary: renderTrustSummary(objects) };
}
