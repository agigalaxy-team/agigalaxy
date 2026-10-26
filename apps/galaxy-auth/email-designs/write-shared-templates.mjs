import {writeFile} from 'node:fs/promises';
import {keycloakEmailThemeTemplates} from '../../../packages/galaxy-mail/src/layout.mjs';

// Write the selected theme's static FTL source artifacts. No Keycloak runtime,
// real message values, transport or account operations are involved.
for (const [name, source] of Object.entries(keycloakEmailThemeTemplates())) {
  await writeFile(new URL('../theme/galaxy-mail-editorial/email/' + name, import.meta.url), source, 'utf8');
}
