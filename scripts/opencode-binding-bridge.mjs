// Fixture wrapper around the installed, otherwise unmodified native package.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const input = JSON.parse(await readFile(process.env.GALAXY_HOST_BINDING_INPUT, 'utf8'));
const { createConfiguredGalaxyPlugin } = await import(pathToFileURL(input.configuredEntry).href);
let time = input.now;
export const observed = { prompt: null, alert: null, advanceTime(seconds) { time = input.now + seconds; } };
async function send(url, options = {}) {
  if (new URL(url).origin !== input.endpoint) throw new Error('Unexpected fixture endpoint');
  const response = await fetch(input.address + new URL(url).pathname, { method: options.bodyJson === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(options.credential ? { Authorization: 'Bearer ' + options.credential } : {}) },
    body: options.bodyJson, signal: options.signal ?? AbortSignal.timeout(5000) });
  if (!response.ok) {
    const error = new Error('Private fixture request rejected');
    if ([401, 403].includes(response.status)) error.code = 'GALAXY_REMOTE_REJECTED';
    throw error;
  }
  return response.json();
}
const configured = createConfiguredGalaxyPlugin({ ...input, dataDirectory: process.env.GALAXY_DATA_DIR,
  trustedKeys: new Map(input.trustedKeys), now: () => time, connectionSend: send, statusSend: send },
{ discoveryTransport: { readManifest: send } });
const bridge = { id: configured.id, async tui(api) {
  await configured.tui({ ...api, ui: { ...api.ui,
    DialogPrompt(props) { observed.prompt = props; return api.ui.DialogPrompt(props); },
    DialogAlert(props) { observed.alert = props; return api.ui.DialogAlert(props); },
  } });
} };
export default bridge;
