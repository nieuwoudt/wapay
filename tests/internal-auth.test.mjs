/**
 * Tests for the internal API key guard on internal-only routes (VAS previews).
 *
 * The guard is deploy-safe: with no WAPAY_INTERNAL_API_KEY configured it
 * fails OPEN by explicit design (so shipping the code cannot break prod);
 * once the env var is set it fails CLOSED with a 401.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { requireInternalAuth } from '../lib/internal-auth.js';
import { internalJsonHeaders } from '../lib/api-url.js';

const KEY = 'test-internal-key-0123456789';

/** Minimal Next.js-style req mock. Header names are lowercase, as Node delivers them. */
function mockReq(headerValue) {
  const headers = {};
  if (headerValue !== undefined) headers['x-internal-api-key'] = headerValue;
  return { url: '/api/vas/airtime/preview', headers, method: 'POST' };
}

/** Minimal res mock capturing status + json body. */
function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

/** Run fn with WAPAY_INTERNAL_API_KEY set (or deleted when value is undefined). */
function withEnvKey(value, fn) {
  const prev = process.env.WAPAY_INTERNAL_API_KEY;
  if (value === undefined) delete process.env.WAPAY_INTERNAL_API_KEY;
  else process.env.WAPAY_INTERNAL_API_KEY = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.WAPAY_INTERNAL_API_KEY;
    else process.env.WAPAY_INTERNAL_API_KEY = prev;
  }
}

test('enforced: matching key passes and writes no response', () => {
  withEnvKey(KEY, () => {
    const res = mockRes();
    assert.equal(requireInternalAuth(mockReq(KEY), res), true);
    assert.equal(res.statusCode, null, 'must not touch the response on success');
  });
});

test('enforced: mismatched key of the same length gets a 401', () => {
  withEnvKey(KEY, () => {
    const res = mockRes();
    const wrong = 'x'.repeat(KEY.length);
    assert.equal(requireInternalAuth(mockReq(wrong), res), false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'AUTH', message: 'Unauthorized' });
  });
});

test('enforced: missing header gets a 401', () => {
  withEnvKey(KEY, () => {
    const res = mockRes();
    assert.equal(requireInternalAuth(mockReq(undefined), res), false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'AUTH', message: 'Unauthorized' });
  });
});

test('enforced: length mismatch never throws (constant-time path)', () => {
  withEnvKey(KEY, () => {
    for (const provided of ['', 'a', KEY + 'extra', KEY.slice(0, 5)]) {
      const res = mockRes();
      let result;
      assert.doesNotThrow(() => {
        result = requireInternalAuth(mockReq(provided), res);
      });
      assert.equal(result, false, `"${provided}" must be rejected`);
      assert.equal(res.statusCode, 401);
    }
  });
});

test('enforced: non-string header value (array) is rejected without throwing', () => {
  withEnvKey(KEY, () => {
    const res = mockRes();
    const req = mockReq(undefined);
    req.headers['x-internal-api-key'] = [KEY, KEY];
    let result;
    assert.doesNotThrow(() => {
      result = requireInternalAuth(req, res);
    });
    assert.equal(result, false);
    assert.equal(res.statusCode, 401);
  });
});

test('unenforced: no env var set passes (fail-open by design)', () => {
  withEnvKey(undefined, () => {
    const res = mockRes();
    assert.equal(requireInternalAuth(mockReq(undefined), res), true);
    assert.equal(res.statusCode, null, 'must not touch the response');
  });
});

test('unenforced: even a wrong header passes when the env var is absent', () => {
  withEnvKey(undefined, () => {
    const res = mockRes();
    assert.equal(requireInternalAuth(mockReq('anything'), res), true);
    assert.equal(res.statusCode, null);
  });
});

test('internalJsonHeaders: sends x-internal-api-key when the env var is set', () => {
  withEnvKey(KEY, () => {
    const headers = internalJsonHeaders();
    assert.equal(headers['x-internal-api-key'], KEY);
    assert.equal(headers['Content-Type'], 'application/json');
  });
});

test('internalJsonHeaders: omits x-internal-api-key when the env var is absent', () => {
  withEnvKey(undefined, () => {
    const headers = internalJsonHeaders();
    assert.equal('x-internal-api-key' in headers, false);
  });
});
