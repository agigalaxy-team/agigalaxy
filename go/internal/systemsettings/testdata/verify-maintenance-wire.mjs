// Independent standard-library verification of actual synthetic Go wire bytes.
import { createHmac, timingSafeEqual } from 'node:crypto';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const { key, requests } = JSON.parse(raw);
const results = requests.map(({ headers: h, body }) => {
  if (typeof key !== 'string' || key.length < 32 || h['x-galaxy-service-key'] !== key
      || !/^[a-f0-9]{64}$/.test(h['x-galaxy-service-signature']) || h['x-galaxy-request-at'] !== '2000000000') return false;
  const expected = createHmac('sha256', key).update(h['x-galaxy-request-id'] + '\n' + h['x-galaxy-request-at'] + '\n').update(body).digest();
  return timingSafeEqual(expected, Buffer.from(h['x-galaxy-service-signature'], 'hex'));
});
console.log(JSON.stringify({ results }));
