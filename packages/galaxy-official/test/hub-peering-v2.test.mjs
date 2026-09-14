import test from 'node:test';
import {peeringWorkflow} from './hub-peering-workflow.mjs';
test('direct peering uses actual scoped signed agreements and finite current source projections over HTTP',()=>peeringWorkflow());
