import assert from 'node:assert/strict';
import test from 'node:test';
import {workbenchTime} from '../src/lib/workbench/workbench-view-model.ts';
import {strategyTime} from '../src/lib/strategies/strategies-view-model.ts';
import {aiRunTime} from '../src/lib/autonomy/ai-runs-view-model.ts';
import {autonomyDate} from '../src/lib/autonomy/autonomy-view-model.ts';

test('record timestamps preserve full Shanghai year and zero-padded date and minute',()=>{
 const input='2025-12-31T16:05:27Z',expected='2026/01/01 00:05';
 for(const format of [workbenchTime,strategyTime,aiRunTime,autonomyDate]){
  assert.equal(format(input),expected);
  assert.equal(format(null),'未记录');
 }
});
