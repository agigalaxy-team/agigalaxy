/**
 * Prepare a complete Keycloak 26.7.3 UPConfig without mandatory names.
 * Pure local planning: no Admin API, user updates, realm mutation or import IO.
 */
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const nameAttributes = new Set(['firstName', 'lastName']);

export function planRegistrationProfile(current) {
  if (!current || typeof current !== 'object' || Array.isArray(current) || !Array.isArray(current.attributes)) {
    throw new TypeError('Pass the complete GET /admin/realms/galaxy/users/profile configuration.');
  }
  const userProfile = structuredClone(current);
  const changedAttributes = [];
  const seen = new Set();
  for (const attribute of userProfile.attributes) {
    if (!attribute || typeof attribute !== 'object' || typeof attribute.name !== 'string') {
      throw new TypeError('User-profile attribute configuration is invalid.');
    }
    if (seen.has(attribute.name)) throw new TypeError('User-profile attributes must have unique names.');
    seen.add(attribute.name);
    if (nameAttributes.has(attribute.name) && Object.hasOwn(attribute, 'required')) {
      delete attribute.required;
      changedAttributes.push(attribute.name);
    }
  }
  return {userProfile, changed: changedAttributes.length > 0, changedAttributes};
}

async function main(args) {
  const inputAt = args.indexOf('--input'), outputAt = args.indexOf('--output');
  if (inputAt < 0 || !args[inputAt + 1] || outputAt < 0 || !args[outputAt + 1]) {
    throw new Error('Use --input <profile-or-secret-free-inspection.json> --output <new-profile.json>.');
  }
  const input = path.resolve(args[inputAt + 1]), output = path.resolve(args[outputAt + 1]);
  if (input === output) throw new Error('Keep the original profile configuration for rollback.');
  const document = JSON.parse(await readFile(input, 'utf8'));
  const plan = planRegistrationProfile(document.userProfile ?? document);
  await writeFile(output, JSON.stringify(plan.userProfile, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({output, changed: plan.changed, changedAttributes: plan.changedAttributes}));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => {
    console.error('User-profile planning failed. Pass a valid full profile and a new output path.');
    process.exitCode = 1;
  });
}
