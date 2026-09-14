#!/usr/bin/env node

import {
  exportLocalData,
  getLocalSnapshot,
  initializeLocalGalaxyId,
  resolveDataDir,
} from '../../galaxy-core/src/local-store.mjs';

function usage() {
  return `Galaxy ID internal fallback (Founding Beta local prototype)

Usage:
  npm run internal:galaxy-id -- init [--data-dir <path>]
  npm run internal:galaxy-id -- status [--data-dir <path>]
  npm run internal:galaxy-id -- export [--data-dir <path>]

This is an internal development fallback. End users should initialize through Galaxy Integration MCP or an AI Skill. All commands are local-only and never register, upload, or publish a Galaxy ID.`;
}

function parseArguments(argv) {
  const argumentsWithoutNode = argv.slice(2);
  const command = argumentsWithoutNode.find((item) => !item.startsWith('-')) || 'status';
  const dataDirIndex = argumentsWithoutNode.indexOf('--data-dir');
  const dataDir = dataDirIndex >= 0 ? argumentsWithoutNode[dataDirIndex + 1] : undefined;
  return { command, dataDir };
}

const { command, dataDir } = parseArguments(process.argv);
const localDirectory = resolveDataDir(dataDir);

try {
  if (command === 'init') {
    const snapshot = await initializeLocalGalaxyId(localDirectory);
    console.log(JSON.stringify({
      message: 'Galaxy ID initialized locally. No registration or upload occurred.',
      dataDir: snapshot.dataDir,
      identity: snapshot.identity,
    }, null, 2));
  } else if (command === 'status') {
    const snapshot = await getLocalSnapshot(localDirectory);
    console.log(JSON.stringify({
      dataDir: snapshot.dataDir,
      identity: snapshot.identity,
      recoveryRequired: snapshot.recoveryRequired ?? false,
      counts: {
        cases: snapshot.state.cases.length,
        disclosurePlans: snapshot.state.disclosurePlans.length,
        consentGrants: snapshot.state.consentGrants.length,
        localProofDrafts: snapshot.state.localProofDrafts.length,
      },
    }, null, 2));
  } else if (command === 'export') {
    console.log(JSON.stringify(await exportLocalData(localDirectory), null, 2));
  } else if (command === 'help' || command === '--help' || command === '-h') {
    console.log(usage());
  } else {
    console.error(`Unknown command: ${command}\n\n${usage()}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
