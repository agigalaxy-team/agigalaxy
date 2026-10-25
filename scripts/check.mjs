import {fileURLToPath} from 'node:url';
import {runChecks} from './checks/runner.mjs';

// Stable npm/CLI entry; discovery and execution have separate implementations.
process.exitCode=runChecks({root:fileURLToPath(new URL('../',import.meta.url)),mode:process.argv[2]??'all'});
