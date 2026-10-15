'use strict';
const assert = require('node:assert/strict');
const {
  resolveSemanticPolicy,
  resolveHarnessSections,
  composeTargetSections,
} = require('../.core-test/core');

const schema = {
  id: 'cs-py-v1',
  choices: [
    { id: 'linq', values: ['lazy', 'eager'], defaultValue: 'lazy' },
    { id: 'exceptions', values: ['throw', 'result'], defaultValue: 'throw' },
  ],
};

const profile = resolveSemanticPolicy(schema, { linq: 'eager' });
assert.deepEqual(profile, {
  id: 'cs-py-v1',
  choices: { linq: 'eager', exceptions: 'throw' },
});
assert.throws(() => resolveSemanticPolicy(schema, { linq: 'magic' }), /Unknown semantic choice/);
assert.throws(() => resolveSemanticPolicy(schema, { notAChoice: 'x' }), /Unknown semantic choice/);
assert.throws(
  () => resolveSemanticPolicy({ id: 'bad', choices: [
    { id: 'x', values: ['a'], defaultValue: 'a' },
    { id: 'x', values: ['b'], defaultValue: 'b' },
  ] }),
  /Invalid semantic choice/,
);

const harness = { id: 'stdlib-v1', targetLanguage: 'python', facilities: ['decimal'] };
const sections = resolveHarnessSections(harness, [
  { id: 'decimal', targetLanguage: 'python', text: 'from decimal import Decimal\n' },
]);
assert.deepEqual(sections, [
  { kind: 'harness', facilityId: 'decimal', text: 'from decimal import Decimal\n' },
]);
assert.deepEqual(composeTargetSections('value = Decimal("1.2")\n', sections), [
  { kind: 'harness', facilityId: 'decimal', text: 'from decimal import Decimal\n' },
  { kind: 'translation', text: 'value = Decimal("1.2")\n' },
]);
assert.throws(
  () => resolveHarnessSections({ ...harness, facilities: ['unknown'] }, []),
  /Unavailable harness facility/,
);
assert.throws(
  () => resolveHarnessSections({ ...harness, facilities: ['decimal', 'decimal'] }, [
    { id: 'decimal', targetLanguage: 'python', text: 'pass' },
  ]),
  /Duplicate requested harness/,
);
console.log('policy harness smoke: PASS');
