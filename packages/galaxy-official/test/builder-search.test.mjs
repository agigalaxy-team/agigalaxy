import test from 'node:test';
import { verifyBuilderSearch } from './builder-search-workflow.mjs';
test('Worker and Hub public metadata share typed HTTP/client search, current sources and background index lifecycle',()=>verifyBuilderSearch());
