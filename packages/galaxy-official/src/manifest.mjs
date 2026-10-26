import { createSigningService } from "./security/signing-service.mjs";
import { digest } from './shared/digest.mjs';
import { validateNetworkManifest } from './verification/manifest.mjs';
export { validateManifest, verifyManifest,validateHubManifest,verifyHubManifest,hubManifestDigest } from './verification/manifest.mjs';

export class ManifestService {
  constructor({ bindings, endpoint = bindings?.endpoint, kid = bindings?.kid,
    now = bindings?.now, signer = bindings && createSigningService(bindings, ['manifest']),
    operator, region, capabilities = [], networkType='official',displayName=networkType==='hub'?'Galaxy Hub':'Galaxy Official',serviceVersion='0.1.0',hub }) {
    this.now = now; this.signer = signer;
    if(networkType==='official'&&hub!==undefined)throw new Error('Hub metadata requires a Hub service.');
    this.data = validateNetworkManifest({ schemaVersion: 1, networkType, displayName,
      operator, endpoint: endpoint, capabilities, policy: { automaticUpload: false,
        privateKeyCustody: 'client', url: `${endpoint}/v1/policy` }, region, serviceVersion,
      signingKeyId: kid, revocationPath: '/v1/signing-keys/status',...(networkType==='hub'?{hub}:{}) }, endpoint,networkType);
    this.cached = null;
  }
  async get() {
    this.signer.assertAvailable(300);
    if (!this.cached || this.cached.refreshAt <= this.now()) {
      const signed = await this.signer.sign('manifest', this.data, undefined, 300);
      this.cached = { document: { signed }, etag: `"${digest(signed)}"`, refreshAt: this.now() + 60 };
    }
    return this.cached;
  }
}

