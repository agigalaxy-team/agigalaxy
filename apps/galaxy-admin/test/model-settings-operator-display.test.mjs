import test from 'node:test';
import assert from 'node:assert/strict';
import {modelSettingsOperator} from '../src/lib/model-settings-view-model.ts';

test('model settings history shows the actual principal name and never substitutes an internal operator identifier',()=>{
 const operatorId='ab'.repeat(32);
 assert.equal(modelSettingsOperator({operatorId,operatorDisplayName:'银河管理人员'}),'银河管理人员');
 assert.equal(modelSettingsOperator({operatorId,operatorDisplayName:'  运营小林  '}),'运营小林');
 for(const operatorDisplayName of[null,undefined,'','   '])assert.equal(modelSettingsOperator({operatorId,operatorDisplayName}),'管理账户');
 assert.equal(modelSettingsOperator({operatorId}),'管理账户');
 assert.equal(modelSettingsOperator({operatorId,operatorDisplayName:null}).includes(operatorId),false);
});
