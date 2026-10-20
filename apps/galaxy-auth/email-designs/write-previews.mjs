import {writeFile} from 'node:fs/promises';
import {EMAIL_DESIGNS, EMAIL_SCENARIOS, renderEmailPreview} from './render-email.mjs';

// Emit only the fixed synthetic design artifacts; never calls an email service.
const textOnly = process.argv.includes('--text-only');
for (const design of EMAIL_DESIGNS) {
  for (const scenario of EMAIL_SCENARIOS) {
    if (scenario.designs && !scenario.designs.includes(design.id)) continue;
    const name = scenario.id === 'register' ? design.file : design.file.replace('.html', `-${scenario.id}.html`);
    const result = renderEmailPreview({design: design.id, scenario: scenario.id});
    if (!textOnly) await writeFile(new URL(name, import.meta.url), result.html, 'utf8');
    await writeFile(new URL(name.replace('.html', '.txt'), import.meta.url), result.text + '\n', 'utf8');
  }
}
