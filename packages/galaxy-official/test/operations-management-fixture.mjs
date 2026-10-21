import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';

export const endpoint = 'https://galaxy.example.invalid';
export const adminOrigin = 'https://operations.example.invalid';
export const operatorRoles = {
  administrator: 'galaxy-operations-administrator',
  reader: 'galaxy-operations-reader',
};

export function operator(role = 'administrator', operatorId = 'synthetic-operator') {
  return {kind: 'business-operator', operatorId, role, endpoint};
}

export function publicSnapshot({title = '银河', pages = [], media = []} = {}) {
  return {
    version: 1,
    settings: {siteTitle: title, description: '合成公开内容', footerLinks: [{label: '帮助', href: '/help/'}]},
    pages,
    media,
  };
}

export function publicPage({path = '/help/', title = '使用帮助', blocks = []} = {}) {
  return {id: 'synthetic-page', path, title, description: '公开说明', blocks, updatedAt: '2026-10-20T12:00:00.000Z'};
}

export function response() {
  const headers = new Map();
  return {headers, statusCode: 200, setHeader: (name, value) => headers.set(name.toLowerCase(), value), end() {}};
}

export function request(jar = new Map(), headers = {}, method = 'GET') {
  return {method, headers: {host: new URL(adminOrigin).host, cookie: [...jar.values()].join('; '), ...headers}};
}

export function acceptCookies(jar, result) {
  const cookies = result.headers.get('set-cookie') ?? [];
  for (const cookie of Array.isArray(cookies) ? cookies : [cookies]) {
    const pair = cookie.split(';', 1)[0], index = pair.indexOf('='), name = pair.slice(0, index);
    if (pair.slice(index + 1)) jar.set(name, pair);
    else jar.delete(name);
  }
}

export function deferred() {
  let resolvePromise, rejectPromise;
  const promise = new Promise((resolve, reject) => {resolvePromise = resolve; rejectPromise = reject;});
  return {promise, resolve: resolvePromise, reject: rejectPromise};
}

export async function temporaryDirectory(t, prefix) {
  assert.match(prefix, /^galaxy-[a-z-]+-$/);
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, prefix));
  t.after(async () => {
    // Recursive cleanup is limited to this exact fixture-owned temporary root.
    assert.equal(dirname(resolve(directory)), parent);
    assert.ok(basename(directory).startsWith(prefix));
    await rm(directory, {recursive: true, force: true, maxRetries: 4, retryDelay: 100});
  });
  return directory;
}
