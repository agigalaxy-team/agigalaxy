import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {EMAIL_DESIGNS, EMAIL_SCENARIOS, renderEmailPreview} from './render-email.mjs';

// Emit only the fixed synthetic design artifacts; never calls an email service.
const textOnly = process.argv.includes('--text-only');
const outputIndex = process.argv.indexOf('--output');
const outputOption = process.argv.find(arg => arg.startsWith('--output='));
if (outputIndex !== -1 && (!process.argv[outputIndex + 1] || process.argv[outputIndex + 1].startsWith('--'))) {
  throw new Error('--output requires a directory.');
}
const explicitOutput = outputIndex !== -1 ? process.argv[outputIndex + 1] : outputOption?.slice('--output='.length);
if (explicitOutput === '') throw new Error('--output requires a directory.');
const output = explicitOutput ? resolve(explicitOutput) : fileURLToPath(new URL('../../../outputs/email-previews/', import.meta.url));
await mkdir(output, {recursive: true});
const designs = process.argv.includes('--selected-only') ? EMAIL_DESIGNS.filter(design => design.selected) : EMAIL_DESIGNS;
for (const design of designs) {
  for (const scenario of EMAIL_SCENARIOS) {
    if (scenario.designs && !scenario.designs.includes(design.id)) continue;
    const name = scenario.id === 'register' ? design.file : design.file.replace('.html', `-${scenario.id}.html`);
    const result = renderEmailPreview({design: design.id, scenario: scenario.id});
    if (!textOnly) await writeFile(resolve(output, name), result.html, 'utf8');
    await writeFile(resolve(output, name.replace('.html', '.txt')), result.text + '\n', 'utf8');
  }
}
