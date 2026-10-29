import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {isAbsolute} from 'node:path';

// This adapter starts the current Go Cases/Task handlers against a disposable
// PostgreSQL cluster. Only fixture signing, controlled content removal and
// inspection use private fixture routes; business calls use real HTTP handlers.
export async function goDomainFixture(t) {
  if (!process.env.GALAXY_GO_TEST_PG_BIN) throw Error('A2A domain integration requires GALAXY_GO_TEST_PG_BIN for isolated PostgreSQL');
  const binary=process.env.GALAXY_A2A_FIXTURE_BINARY;
  if(binary&&!isAbsolute(binary))throw Error('An absolute current Go fixture binary is required');
  const child = spawn(binary ?? process.env.GALAXY_BUILD_GO ?? 'go', binary
    ? ['-test.run=^TestServeCurrentDomains$', '-test.v', '-test.timeout=4m']
    : ['test', '-count=1', '-tags', 'galaxy_a2a_fixture',
    './internal/testsupport/a2afixture', '-run', '^TestServeCurrentDomains$', '-v', '-timeout=4m'],
    {cwd: fileURLToPath(new URL('../../../go/', import.meta.url)), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env});
  let ready, output = '', errors = '';
  const wait = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('Current Go A2A fixture startup timeout: ' + errors.slice(-2000))); }, 60000);
    child.stderr.on('data', b => { errors = (errors + b).slice(-4000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); if (!ready) reject(Error(`Current Go A2A fixture exited ${code}: ${errors} ${output.slice(-2000)}`)); });
    child.stdout.on('data', b => {
      output += b;
      const marker = 'GALAXY_A2A_FIXTURE ', line = output.split('\n').find(value => value.startsWith(marker));
      if (!ready && line && output.includes(line + '\n')) {
        try { ready = JSON.parse(line.slice(marker.length)); clearTimeout(timer); resolve(ready); }
        catch (error) { clearTimeout(timer); reject(error); }
      }
    });
  });
  const state = await wait;
  const request = async (path, input, {method = 'POST', actor = 0, control = false, signal} = {}) => {
    const response = await fetch(state.origin + path, {method, signal,
      headers: {'Content-Type': 'application/json', ...(control ? {'X-Galaxy-Fixture-Key': state.controlKey} : {Authorization: 'Bearer ' + state.actors[actor].credential})},
      ...(method === 'GET' ? {} : {body: JSON.stringify(input)})});
    if (response.status === 204) return null;
    const value = await response.json();
    if (!response.ok) throw Object.assign(Error(value.error ?? 'Current Go domain fixture failed'), {status: response.status});
    return value;
  };
  t.after(async () => {
    if (child.exitCode !== null) return;
    const ended = once(child, 'exit');
    try { await request('/fixture/shutdown', {}, {control: true}); }
    finally {
      const timer = setTimeout(() => child.kill(), 15000);
      const [code] = await ended; clearTimeout(timer);
      if (code !== 0) throw Error(`Current Go fixture cleanup failed ${code}: ${errors} ${output.slice(-1500)}`);
    }
  });
  const index = actor => state.actors.findIndex(value => value.actor.bindingId === actor.bindingId);
  const callAs = (actor, path, input, options = {}) => {
    const selected = index(actor); if (selected < 0) throw Error('Unknown synthetic Go actor');
    return request(path, input, {...options, actor: selected});
  };
  const cases = {
    submitV2: (actor, input) => callAs(actor, '/v2/cases/events', input),
    getV2: (actor, id, input = {}) => callAs(actor, `/v2/cases/${id}/read`, input),
    receipt: (actor, input) => callAs(actor, '/v2/cases/events/receipt', input),
    createAndLinkTask: (actor, input) => callAs(actor, `/v2/tasks/${input.taskId}/case`, input),
  };
  const assistance = {
    createTask: (actor, input) => callAs(actor, '/v2/tasks', input),
    getTask: (actor, id) => callAs(actor, `/v2/tasks/${id}`, undefined, {method: 'GET'}),
    proposeParticipation: (actor, id, input) => callAs(actor, `/v2/tasks/${id}/participations`, input),
    submitParticipationEvent: (actor, id, input) => callAs(actor, `/v2/participations/${id}/events`, input),
  };
  const consents = {revoke: (actor, id) => request('/fixture/revoke', {actor: index(actor), consentId: id}, {control: true})};
  const db = {query: async (sql, args) => {
    if (sql === "UPDATE case_events SET payload='{}'::jsonb,payload_text='' WHERE id=$1") return request('/fixture/erase-case-content', {id: args[0]}, {control: true});
    if (sql === 'SELECT kind,count(*)::int count FROM case_events GROUP BY kind ORDER BY kind') return request('/fixture/case-counts', {}, {control: true});
    throw Error('Only the two explicit synthetic fixture inspections are available');
  }};
  const actors = state.actors.map((value, actor) => ({...value, now: state.now, access: {endpoint: state.endpoint}, cases, assistance, consents, db,
    authorize: (event, action = 'case.teaser.publish', options = {}) => request('/fixture/authorize',
      {actor, payloadJson: JSON.stringify(event), action, objectId: options.objectId ?? event.eventId ?? event.operationId ?? event.id,
        id: options.id, visibility: options.visibility, viewers: options.viewers}, {control: true})}));
  return {owner: actors[0], peer: actors[1], origin: state.origin};
}
