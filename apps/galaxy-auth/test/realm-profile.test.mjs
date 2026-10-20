import test from 'node:test';
import assert from 'node:assert/strict';
import {planRegistrationProfile} from '../realm-profile.mjs';

test('registration planning makes names optional without changing profile permissions, validation or other fields', () => {
  const current = {
    attributes: [
      {name: 'username', validations: {length: {min: 3, max: 255}}},
      {name: 'email', required: {roles: ['user']}, validations: {email: {}}},
      ...['firstName', 'lastName'].map(name => ({
        name, displayName: '${' + name + '}', required: {roles: ['user']},
        permissions: {view: ['admin', 'user'], edit: ['admin', 'user']},
        validations: {length: {max: 255}, 'person-name-prohibited-characters': {}},
        annotations: {inputHelperTextBefore: 'optional-profile-help'}, multivalued: false,
      })),
      {name: 'custom', required: {roles: ['admin']}, annotations: {inputType: 'textarea'}},
    ],
    groups: [{name: 'user-metadata', displayHeader: 'User metadata'}],
    unmanagedAttributePolicy: 'ADMIN_VIEW',
  };
  const original = structuredClone(current);
  const plan = planRegistrationProfile(current);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.changedAttributes, ['firstName', 'lastName']);
  const expected = structuredClone(current);
  for (const attribute of expected.attributes) {
    if (attribute.name === 'firstName' || attribute.name === 'lastName') delete attribute.required;
  }
  assert.deepEqual(plan.userProfile, expected);
  assert.deepEqual(current, original);
  const again = planRegistrationProfile(plan.userProfile);
  assert.equal(again.changed, false);
  assert.deepEqual(again.userProfile, plan.userProfile);
});

test('planning requires a complete UPConfig and rejects ambiguous duplicate field definitions', () => {
  assert.throws(() => planRegistrationProfile({realm: 'galaxy'}), TypeError);
  assert.throws(() => planRegistrationProfile({attributes: [{name: 'firstName'}, {name: 'firstName'}]}), TypeError);
});
