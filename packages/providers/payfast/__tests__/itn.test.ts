/**
 * PayFast ITN verification pipeline tests.
 *
 * Covers:
 * - rand-string <-> integer-cents exactness (no float math)
 * - IP allowlist membership math (CIDR boundaries, IPv6-mapped prefix)
 * - the 5-step pipeline: pass + each failure reason, with a stubbed fetch
 *   (no live network calls) and the enforce-vs-warn source-IP flag
 * - POST-back wire format: sandbox vs live URL, signature excluded
 * - parseItnBody preserving wire order and empty values
 */
import { describe, it, expect } from 'vitest';
import { generateSignature } from '../src/signature.js';
import { centsToRand, randToCents } from '../src/checkout.js';
import {
  PAYFAST_ITN_CIDRS,
  PAYFAST_VALIDATE_URLS,
  parseItnBody,
  ipInCidr,
  isPayfastIp,
  verifyItn,
  type FetchLike,
} from '../src/itn.js';

const PASSPHRASE = 'test-passphrase 123';
const GOOD_IP = '197.97.145.144';

/**
 * Build a realistic ITN param set in PayFast's wire order — with the empty
 * fields (item_description, custom_str2..5, custom_int1..5, name_last) that
 * real ITNs carry and that MUST be part of the signature.
 */
function makeItn(overrides: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {
    m_payment_id: 'wapay-load-42',
    pf_payment_id: '1089250',
    payment_status: 'COMPLETE',
    item_name: 'WaPay wallet load',
    item_description: '',
    amount_gross: '50.00',
    amount_fee: '-2.30',
    amount_net: '47.70',
    custom_str1: 'acct_9',
    custom_str2: '',
    custom_str3: '',
    custom_str4: '',
    custom_str5: '',
    custom_int1: '',
    custom_int2: '',
    custom_int3: '',
    custom_int4: '',
    custom_int5: '',
    name_first: 'Jane',
    name_last: '',
    email_address: 'jane@example.com',
    merchant_id: '10000100',
    ...overrides,
  };
  return { ...base, signature: generateSignature(base, PASSPHRASE) };
}

/** Stubbed fetch that records the call and returns a fixed body. */
function stubFetch(body: string) {
  const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { text: async () => body };
  };
  return { impl, calls };
}

describe('randToCents / centsToRand exactness', () => {
  it("parses '50.00' -> 5000 and '1000.00' -> 100000 exactly", () => {
    expect(randToCents('50.00')).toBe(5000);
    expect(randToCents('1000.00')).toBe(100000);
    expect(randToCents('0.05')).toBe(5);
    expect(randToCents('1000')).toBe(100000);
    expect(randToCents('-2.30')).toBe(-230); // amount_fee is negative
  });

  it("formats 5000 -> '50.00' and 100000 -> '1000.00' exactly", () => {
    expect(centsToRand(5000)).toBe('50.00');
    expect(centsToRand(100000)).toBe('1000.00');
    expect(centsToRand(5)).toBe('0.05');
    expect(centsToRand(-230)).toBe('-2.30');
  });

  it('round-trips without float drift (the 0.1+0.2 class of bug)', () => {
    for (const cents of [1, 3, 29, 5000, 99670, 100000, 123456789]) {
      expect(randToCents(centsToRand(cents))).toBe(cents);
    }
    // 5798.05 * 100 === 579804.9999... under float math; string math is exact
    expect(randToCents('5798.05')).toBe(579805);
  });

  it('rejects malformed, sub-cent and non-integer input', () => {
    expect(() => randToCents('abc')).toThrow();
    expect(() => randToCents('50.005')).toThrow();
    expect(() => randToCents('')).toThrow();
    expect(() => centsToRand(50.5)).toThrow();
  });
});

describe('IP allowlist membership math', () => {
  it('197.97.145.144/28 spans .144-.159 inclusive', () => {
    expect(ipInCidr('197.97.145.144', '197.97.145.144/28')).toBe(true);
    expect(ipInCidr('197.97.145.159', '197.97.145.144/28')).toBe(true);
    expect(ipInCidr('197.97.145.143', '197.97.145.144/28')).toBe(false);
    expect(ipInCidr('197.97.145.160', '197.97.145.144/28')).toBe(false);
  });

  it('41.74.179.192/27 spans .192-.223 inclusive', () => {
    expect(ipInCidr('41.74.179.192', '41.74.179.192/27')).toBe(true);
    expect(ipInCidr('41.74.179.223', '41.74.179.192/27')).toBe(true);
    expect(ipInCidr('41.74.179.191', '41.74.179.192/27')).toBe(false);
    expect(ipInCidr('41.74.179.224', '41.74.179.192/27')).toBe(false);
  });

  it('rejects malformed IPs and CIDRs instead of throwing', () => {
    expect(ipInCidr('not-an-ip', '197.97.145.144/28')).toBe(false);
    expect(ipInCidr('1.2.3.4.5', '197.97.145.144/28')).toBe(false);
    expect(ipInCidr('197.97.145.300', '197.97.145.144/28')).toBe(false);
    expect(ipInCidr('197.97.145.145', '197.97.145.144/99')).toBe(false);
    expect(ipInCidr('197.97.145.145', 'garbage')).toBe(false);
  });

  it('isPayfastIp covers both published ranges and strips ::ffff:', () => {
    expect(PAYFAST_ITN_CIDRS).toEqual(['197.97.145.144/28', '41.74.179.192/27', '102.216.36.0/24']);
    expect(isPayfastIp('197.97.145.150')).toBe(true);
    expect(isPayfastIp('41.74.179.200')).toBe(true);
    expect(isPayfastIp('::ffff:197.97.145.150')).toBe(true);
    expect(isPayfastIp('102.65.1.1')).toBe(false);
    expect(isPayfastIp('')).toBe(false);
    expect(isPayfastIp('unknown')).toBe(false);
  });
});

describe('parseItnBody', () => {
  it('preserves wire order and empty values (both signature-critical)', () => {
    const body = 'm_payment_id=p1&custom_str2=&name_last=&amount_gross=50.00';
    const parsed = parseItnBody(body);
    expect(Object.keys(parsed)).toEqual([
      'm_payment_id',
      'custom_str2',
      'name_last',
      'amount_gross',
    ]);
    expect(parsed.custom_str2).toBe('');
    expect(parsed.name_last).toBe('');
  });

  it('form-decodes values (+ -> space, %xx)', () => {
    const parsed = parseItnBody('item_name=WaPay+wallet+load&email_address=jane%40example.com');
    expect(parsed.item_name).toBe('WaPay wallet load');
    expect(parsed.email_address).toBe('jane@example.com');
  });
});

describe('verifyItn pipeline', () => {
  const baseInput = {
    sourceIp: GOOD_IP,
    passphrase: PASSPHRASE,
    sandbox: true,
    expectedAmountCents: 5000,
  };

  it('passes a fully valid ITN and POSTs back to the sandbox validate URL', async () => {
    const { impl, calls } = stubFetch('VALID');
    const params = makeItn();
    const verdict = await verifyItn({ ...baseInput, params, fetchImpl: impl });

    expect(verdict).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(PAYFAST_VALIDATE_URLS.sandbox);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded'
    );
    // POST-back carries every field EXCEPT signature
    const posted = new URLSearchParams(calls[0].init.body);
    expect(posted.get('signature')).toBeNull();
    expect(posted.get('m_payment_id')).toBe('wapay-load-42');
    expect(posted.get('amount_gross')).toBe('50.00');
    expect(posted.get('custom_str2')).toBe(''); // empties still posted back
  });

  it('uses the live validate URL when sandbox=false', async () => {
    const { impl, calls } = stubFetch('VALID');
    const verdict = await verifyItn({
      ...baseInput,
      sandbox: false,
      params: makeItn(),
      fetchImpl: impl,
    });
    expect(verdict.ok).toBe(true);
    expect(calls[0].url).toBe('https://www.payfast.co.za/eng/query/validate');
  });

  it('accepts a whitespace-padded VALID body (trimmed compare)', async () => {
    const { impl } = stubFetch('VALID\n');
    const verdict = await verifyItn({ ...baseInput, params: makeItn(), fetchImpl: impl });
    expect(verdict.ok).toBe(true);
  });

  it('rejects a tampered signature FIRST and never calls fetch', async () => {
    const { impl, calls } = stubFetch('VALID');
    const params = { ...makeItn(), signature: 'a'.repeat(32) };
    const verdict = await verifyItn({ ...baseInput, params, fetchImpl: impl });
    expect(verdict).toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
    expect(calls).toHaveLength(0);
  });

  it('rejects when the signature was computed with empty fields stripped (regression guard)', async () => {
    const { impl } = stubFetch('VALID');
    const params = makeItn();
    const stripped = Object.fromEntries(
      Object.entries(params).filter(([k, v]) => k !== 'signature' && v !== '')
    );
    params.signature = generateSignature(stripped, PASSPHRASE);
    const verdict = await verifyItn({ ...baseInput, params, fetchImpl: impl });
    expect(verdict).toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
  });

  it('REJECTS a non-PayFast source IP by default (hardened vs UniFuel warn-only)', async () => {
    const { impl, calls } = stubFetch('VALID');
    const verdict = await verifyItn({
      ...baseInput,
      params: makeItn(),
      sourceIp: '102.65.1.1',
      fetchImpl: impl,
    });
    expect(verdict).toEqual({ ok: false, reason: 'SOURCE_IP_REJECTED' });
    expect(calls).toHaveLength(0);
  });

  it('warns-only when enforceSourceIp:false (local tunnel debugging escape hatch)', async () => {
    const { impl } = stubFetch('VALID');
    const verdict = await verifyItn({
      ...baseInput,
      params: makeItn(),
      sourceIp: '102.65.1.1',
      enforceSourceIp: false,
      fetchImpl: impl,
    });
    expect(verdict).toEqual({ ok: true });
  });

  it('accepts the IPv6-mapped form of a PayFast IP', async () => {
    const { impl } = stubFetch('VALID');
    const verdict = await verifyItn({
      ...baseInput,
      params: makeItn(),
      sourceIp: '::ffff:41.74.179.200',
      fetchImpl: impl,
    });
    expect(verdict).toEqual({ ok: true });
  });

  it('rejects an amount mismatch via exact rand-string compare', async () => {
    const { impl, calls } = stubFetch('VALID');
    const verdict = await verifyItn({
      ...baseInput,
      expectedAmountCents: 5001, // '50.01' vs ITN's '50.00'
      params: makeItn(),
      fetchImpl: impl,
    });
    expect(verdict).toEqual({ ok: false, reason: 'AMOUNT_MISMATCH' });
    expect(calls).toHaveLength(0);
  });

  it("rejects amount_gross formatted differently ('50.0' is not '50.00' — exact compare)", async () => {
    const { impl } = stubFetch('VALID');
    const verdict = await verifyItn({
      ...baseInput,
      params: makeItn({ amount_gross: '50.0' }),
      fetchImpl: impl,
    });
    expect(verdict).toEqual({ ok: false, reason: 'AMOUNT_MISMATCH' });
  });

  it('rejects non-COMPLETE payment statuses', async () => {
    const { impl, calls } = stubFetch('VALID');
    for (const payment_status of ['FAILED', 'PENDING', 'CANCELLED', '']) {
      const verdict = await verifyItn({
        ...baseInput,
        params: makeItn({ payment_status }),
        fetchImpl: impl,
      });
      expect(verdict).toEqual({ ok: false, reason: 'PAYMENT_NOT_COMPLETE' });
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects when PayFast's server answers anything but 'VALID'", async () => {
    const { impl } = stubFetch('INVALID');
    const verdict = await verifyItn({ ...baseInput, params: makeItn(), fetchImpl: impl });
    expect(verdict).toEqual({ ok: false, reason: 'SERVER_VALIDATION_FAILED' });
  });

  it('rejects (not throws) when the POST-back fetch fails', async () => {
    const impl: FetchLike = async () => {
      throw new Error('ECONNRESET');
    };
    const verdict = await verifyItn({ ...baseInput, params: makeItn(), fetchImpl: impl });
    expect(verdict).toEqual({ ok: false, reason: 'SERVER_VALIDATION_FAILED' });
  });

  it('verifies an ITN parsed from a raw form body end-to-end', async () => {
    const { impl } = stubFetch('VALID');
    const params = makeItn();
    const rawBody = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%20/g, '+')}`)
      .join('&');
    const verdict = await verifyItn({
      ...baseInput,
      params: parseItnBody(rawBody),
      fetchImpl: impl,
    });
    expect(verdict).toEqual({ ok: true });
  });
});
