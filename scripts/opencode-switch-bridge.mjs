import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const input = JSON.parse(await readFile(process.env.GALAXY_HOST_BINDING_INPUT, 'utf8'));
const { createConfiguredGalaxyPlugin } = await import(pathToFileURL(input.configuredEntry).href);
let selected = { service: 0, dataDirectory: input.firstDirectory, scopes: ['binding'], installationId: input.installationId };
export const observed = { prompt: null, select: null, selections: [],
  selectConfiguration(patch) { selected = { ...selected, ...patch }; } };
async function send(url, options = {}) {
  const service = input.services.find(item => item.endpoint === new URL(url).origin);
  if (!service) throw new Error('Unexpected synthetic endpoint');
  const response = await fetch(service.address + new URL(url).pathname, { method: options.bodyJson === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(options.credential ? { Authorization: 'Bearer ' + options.credential } : {}) },
    body: options.bodyJson, signal: options.signal ?? AbortSignal.timeout(5000) });
  if (!response.ok) {
    const error = new Error('Private switch fixture rejected request');
    if ([401, 403].includes(response.status)) error.code = 'GALAXY_REMOTE_REJECTED';
    throw error;
  }
  return response.json();
}
const plugin = createConfiguredGalaxyPlugin(async () => {
  const service = input.services[selected.service];
  observed.selections.push({ ...selected, endpoint: service.endpoint });
  return { endpoint: service.endpoint, dataDirectory: selected.dataDirectory, scopes: selected.scopes,
    installationId: selected.installationId, bindingScopeId: 'binding-' + selected.service,
    trustedKeys: new Map(service.trustedKeys), now: () => service.now, connectionSend: send, statusSend: send };
}, { discoveryTransport: { readManifest: send } });
const bridge = { id: plugin.id, async tui(api) {
  await plugin.tui({ ...api, ui: { ...api.ui,
    DialogPrompt(props) { observed.prompt = props; return api.ui.DialogPrompt(props); },
    DialogSelect(props) { observed.select = props; return api.ui.DialogSelect(props); },
  } });
} };
export default bridge;
