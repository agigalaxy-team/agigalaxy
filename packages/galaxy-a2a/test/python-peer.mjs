import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
export async function pythonPeer(python) {
  const child = spawn(python, ['-u', fileURLToPath(new URL('./python/server.py', import.meta.url))], { windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONNOUSERSITE: '1' } });
  let output = '', errors = '', ready;
  child.stderr.on('data', b => { errors += b; });
  const wait = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Python fixture startup timeout: ' + errors)); }, 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); if (!ready) reject(new Error(`Python exited ${code}: ${errors}`)); });
    child.stdout.on('data', b => {
      output += b; const line = output.split('\n')[0];
      if (!ready && output.includes('\n')) { try { ready = JSON.parse(line); clearTimeout(timer); resolve(ready); } catch (error) { reject(error); } }
    });
  });
  const info = await wait, origin = `http://127.0.0.1:${info.port}`, requests = [];
  const cardResponse = await fetch(origin + '/.well-known/agent-card.json');
  if (!cardResponse.ok) { child.kill(); throw new Error('Python AgentCard unavailable.'); }
  const card = await cardResponse.json();
  const lifecycleCard = await (await fetch(origin + '/lifecycle-card.json')).json();
  return { endpoint: 'https://python-peer.example.org/a2a', card, lifecycleCard, info, requests,
    get: async () => card,
    async post(url, { bodyJson, credential, signal }) {
      if (!['https://python-peer.example.org/a2a', 'https://python-peer.example.org/lifecycle'].includes(url) || credential) throw new Error('Synthetic Python transport boundary.');
      requests.push(JSON.parse(bodyJson));
      const response = await fetch(origin + new URL(url).pathname, { method: 'POST', body: bodyJson, signal,
        headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' } });
      if (!response.ok) throw new Error(`Python RPC ${response.status}: ${await response.text()}`);
      return response.json();
    }, async close() { if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } },
  };
}
