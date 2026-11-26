import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { waitForCondition } from './browser-readiness.mjs';

test('browser readiness converts cyclic DOM nodes to booleans before CDP serialization', async () => {
  const element = {}; element.reactFiber = element;
  await waitForCondition(async expression => {
    const result = runInNewContext(expression, { document: { querySelector: () => element } });
    // Simulate returnByValue: a DOM/Fiber object cannot be JSON serialized.
    assert.equal(typeof result, 'boolean');
    return JSON.parse(JSON.stringify(result));
  }, 'document.querySelector("dialog[open]")', 'dialog');
});
test('readiness waits for absent dialog and replaced navigation context', async () => {
  let calls = 0;
  await waitForCondition(async expression => {
    if (++calls === 1) throw Object.assign(new Error('context replaced'), { navigationContextUnavailable: true });
    return runInNewContext(expression, { document: { querySelector: () => calls > 2 ? {} : null } });
  }, 'document.querySelector("dialog[open]")', 'dialog', { interval: 0 });
  assert.equal(calls, 3);
});
test('readiness preserves application/protocol failures and times out on false conditions', async () => {
  const error = new Error('Application exception');
  await assert.rejects(waitForCondition(async () => { throw error; }, 'true', 'dialog'), value => value === error);
  await assert.rejects(waitForCondition(async () => false, 'false', 'dialog', { timeout: 10, interval: 0 }), /timed out: dialog/);
});
