import test from 'node:test';
import { verifyContactsV2 } from './contacts-v2-workflow.mjs';
test('Contact v2 authenticates real OIDC accounts, shares invitation cooldown and creates one consensual ordinary room',{timeout:90000},()=>verifyContactsV2());
