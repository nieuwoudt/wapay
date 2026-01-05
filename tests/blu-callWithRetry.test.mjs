import test from 'node:test';
import assert from 'node:assert/strict';

import { callWithRetryTestHarness } from '../packages/providers/blu/src/vas-test-helper.js';

test('callWithRetry stops immediately on USER_INPUT (no retries)', async () => {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    const err = new Error('USER_INPUT');
    err.reason = 'Bad request';
    throw err;
  };

  const { attempts, error } = await callWithRetryTestHarness(fn, 3);

  assert.equal(calls, 1);
  assert.equal(attempts, 1);
  assert.equal(error.message, 'USER_INPUT');
});

test('callWithRetry retries retryable errors up to maxAttempts', async () => {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    if (calls < 3) {
      const err = new Error('RETRYABLE');
      err.reason = 'Temporary';
      throw err;
    }
    return 'ok';
  };

  const { attempts, result, error } = await callWithRetryTestHarness(fn, 3);

  assert.equal(attempts, 3);
  assert.equal(result, 'ok');
  assert.equal(error, undefined);
});

