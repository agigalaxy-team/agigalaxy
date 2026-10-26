#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readOperationsConfiguration } from './configuration.mjs';
import { normalizeOperationalRecord, rfc3339Pattern } from './log-record.mjs';

const timestamp = new RegExp('^(' + rfc3339Pattern.slice(1, -1) + ') (.*)$');
export function dockerLogArguments(container, since) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(container)) throw new Error('operations_log_container_invalid');
  if (since !== '24h' && !new RegExp(rfc3339Pattern).test(since)) throw new Error('operations_log_cursor_invalid');
  return ['--host', 'unix:///var/run/docker.sock', 'logs', '--follow', '--timestamps', '--since', since, container];
}

export function createDockerLogDecoder(onLine) {
  let buffer = '', overlong = false;
  function emit() {
    const line = buffer.replace(/[\r\n]+$/, ''), truncated = overlong;
    buffer = ''; overlong = false;
    if (line || truncated) onLine({ line, truncated });
  }
  return {
    write(chunk) {
      for (const piece of chunk.split(/(?<=\n)/)) {
        if (!overlong) { buffer += piece; if (Buffer.byteLength(buffer) > 65536) { buffer = ''; overlong = true; } }
        if (piece.endsWith('\n')) emit();
      }
    },
    end: emit,
  };
}

export async function collectDockerLogs(config) {
  const directory = config.directories.data + '/component-logs';
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(directory + '/docker-client', { recursive: true, mode: 0o700 });
  const dockerEnvironment = { PATH: process.env.PATH, DOCKER_CONFIG: directory + '/docker-client' };
  const cursorPath = directory + '/cursors.json', cursors = {};
  try { Object.assign(cursors, JSON.parse(await readFile(cursorPath, 'utf8'))); } catch (error) { if (error.code !== 'ENOENT') throw new Error('operations_log_cursor_unavailable'); }
  const watchers = new Map(), finished = new Map(), sizes = new Map();
  let queue = Promise.resolve(), stopping = false, discoveryChild = null, fatal;
  /** @type {Promise<void> | null} */
  let pollingPromise = null;
  const maxBytes = config.logCollection.maxFileBytes, retained = config.logCollection.files;
  const enqueue = job => { queue = queue.then(job); queue.catch(error => { fatal ??= error; stop(); }); return queue; };
  const write = async (entry, record) => {
    const path = directory + '/' + entry.component + '.jsonl';
    const line = JSON.stringify({ ...record, component: entry.component, environment: config.environment, release: entry.release }) + '\n';
    if (!sizes.has(path)) { try { sizes.set(path, (await stat(path)).size); } catch (error) { if (error.code !== 'ENOENT') throw error; sizes.set(path, 0); } }
    if (sizes.get(path) + Buffer.byteLength(line) > maxBytes) {
      for (let index = retained - 1; index >= 1; index--) {
        try { await rename(index === 1 ? path : path + '.' + (index - 1), path + '.' + index); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      sizes.set(path, 0);
    }
    await appendFile(path, line, { mode: 0o600 }); sizes.set(path, sizes.get(path) + Buffer.byteLength(line));
  };
  const persist = () => enqueue(async () => { await writeFile(cursorPath + '.next', JSON.stringify(cursors), { mode: 0o600 }); await rename(cursorPath + '.next', cursorPath); });
  const follow = (entry, id) => {
    const key = entry.container;
    const saved = cursors[key]?.containerId === id && new RegExp(rfc3339Pattern).test(cursors[key]?.time) ? { ...cursors[key] } : null;
    const child = spawn(config.tools.docker, dockerLogArguments(entry.container, saved?.time ?? '24h'), { stdio: ['ignore', 'pipe', 'pipe'], env: dockerEnvironment });
    const watcher = { child, id, done: null }; watchers.set(key, watcher);
    // stdout/stderr from `docker logs` are both log streams. Neither is sent to
    // this service's journal or stored before projection.
    const read = stream => {
      const decoder = createDockerLogDecoder(({ line, truncated }) => {
        const matched = timestamp.exec(line);
        if (!matched) { void enqueue(() => write(entry, { ...normalizeOperationalRecord(line), event: truncated ? 'log_record_truncated' : 'log_source_notice', level: 'warn', detailsOmitted: true })); return; }
        const [, time, body] = matched;
        const record = normalizeOperationalRecord(body, { time });
        void enqueue(async () => {
          await write(entry, record);
          const prior = cursors[key];
          if (!prior || prior.containerId !== id || time > prior.time) cursors[key] = { containerId: id, time };
        });
      });
      stream.setEncoding('utf8'); stream.on('data', decoder.write.bind(decoder)); stream.on('end', decoder.end);
    };
    read(child.stdout); read(child.stderr);
    watcher.done = new Promise(resolve => {
      child.once('error', () => { void enqueue(() => write(entry, { event: 'log_source_unavailable', level: 'error', code: 'docker_logs_unavailable' })); });
      child.once('close', code => { if (watchers.get(key) === watcher) watchers.delete(key); finished.set(key, id); if (code !== 0 && !stopping) void enqueue(() => write(entry, { event: 'log_source_interrupted', level: 'warn', code: 'docker_logs_interrupted' })); resolve(); });
    });
  };
  async function discover() {
    try {
      const child = spawn(config.tools.docker, ['--host', 'unix:///var/run/docker.sock', 'ps', '--all', '--no-trunc', '--format', '{{.ID}}|{{.Names}}|{{.State}}'], { stdio: ['ignore', 'pipe', 'ignore'], env: dockerEnvironment });
      discoveryChild = child;
      const deadline = setTimeout(() => { child.kill('SIGTERM'); }, 15000);
      let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { output += value; if (output.length > 1048576) child.kill(); });
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(deadline));
      if (code !== 0) throw new Error('operations_log_discovery_unavailable');
      const current = new Map(output.split('\n').map(line => { const [id, name, state] = line.split('|'); return [name, { id, state }]; }));
      for (const entry of config.dockerLogs) {
        if (stopping) break;
        const found = current.get(entry.container), watcher = watchers.get(entry.container);
        if (watcher && watcher.id !== found?.id) { watcher.child.kill('SIGTERM'); await watcher.done; }
        if (!found || !/^[a-f0-9]{64}$/.test(found.id) || watchers.has(entry.container) || found.state !== 'running' && finished.get(entry.container) === found.id) continue;
        follow(entry, found.id);
      }
    } catch { if (!stopping) console.error(JSON.stringify({ event: 'component_log_discovery_failed', code: 'docker_log_discovery_unavailable', level: 'error' })); }
    finally { discoveryChild = null; }
  }
  function poll() {
    if (stopping) return Promise.resolve();
    if (!pollingPromise) pollingPromise = discover().finally(() => { pollingPromise = null; });
    return pollingPromise;
  }
  let resolveStop;
  const stopped = new Promise(resolve => { resolveStop = resolve; });
  function stop() { if (stopping) return; stopping = true; discoveryChild?.kill('SIGTERM'); for (const watcher of watchers.values()) watcher.child.kill('SIGTERM'); resolveStop(); }
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const pollTimer = setInterval(() => { void poll(); }, 5000), cursorTimer = setInterval(() => { if (!stopping) void persist(); }, 10000);
  console.info(JSON.stringify({ event: 'component_log_collection_started', phase: 'starting', level: 'info' }));
  try { await poll(); await stopped; }
  finally {
    clearInterval(pollTimer); clearInterval(cursorTimer);
    await Promise.resolve(pollingPromise);
    const closing = [...watchers.values()];
    const deadline = setTimeout(() => { for (const watcher of closing) watcher.child.kill('SIGKILL'); }, 10000);
    for (const watcher of closing) watcher.child.kill('SIGTERM');
    await Promise.all(closing.map(watcher => watcher.done));
    clearTimeout(deadline);
    await queue; await persist();
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
  if (fatal) throw fatal;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf('--config');
  try { if (index < 0 || !process.argv[index + 1]) throw new Error('operations_log_configuration_required'); await collectDockerLogs(await readOperationsConfiguration(process.argv[index + 1])); }
  catch { console.error(JSON.stringify({ event: 'component_log_collector_failed', code: 'log_collection_failed', level: 'error' })); process.exitCode = 1; }
}
