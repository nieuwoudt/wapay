/**
 * PayFast signature + checkout signing tests.
 *
 * Covers:
 * - MD5 known-vector stability (hashes computed once by running the ported
 *   algorithm on fixed input; a change in encoding/order/filtering breaks them)
 * - THE empty-field asymmetry from UniFuel docs/known-issues.md §1, in BOTH
 *   directions: inbound verification INCLUDES empty values, outbound
 *   checkout signing STRIPS them before signing
 * - %20 -> + encoding, trimming, passphrase append
 * - buildCheckout / buildCheckoutUrl (GET query byte-identical to the
 *   signed base string)
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  pfEncode,
  buildParamString,
  generateSignature,
  verifySignature,
} from '../src/signature.js';
import {
  PAYFAST_PROCESS_URLS,
  buildCheckout,
  buildCheckoutUrl,
} from '../src/checkout.js';

const PASSPHRASE = 'jt7NOE43FZPn';

/** Fixed input with an EMPTY field — the shape that broke UniFuel for 2 days. */
const vectorData: Record<string, string> = {
  name_first: 'Jane Doe',
  email_address: 'jane@example.com',
  amount: '50.00',
  item_name: 'WaPay load: R50',
  custom_str1: '',
};

// Known vectors: computed by running the ported algorithm once on the fixed
// input above and pinning the digests. They assert STABILITY of encoding
// (%20->+), insertion order, empty-field inclusion, and passphrase append.
const VECTOR_WITH_EMPTY_AND_PASSPHRASE = '12e4bc1d88079f973639643723c10b4a';
const VECTOR_EMPTY_STRIPPED_AND_PASSPHRASE = '703ac9ce865da0f4c8f3ed286bb141cd';
const VECTOR_WITH_EMPTY_NO_PASSPHRASE = '899a208466dee232f50db4ff032b8bfe';

describe('pfEncode', () => {
  it('URL-encodes with %20 -> + (form semantics) and trims', () => {
    expect(pfEncode('Jane Doe')).toBe('Jane+Doe');
    expect(pfEncode('  padded  ')).toBe('padded');
    expect(pfEncode('a@b.co/za?&=')).toBe('a%40b.co%2Fza%3F%26%3D');
    expect(pfEncode(undefined)).toBe('');
    expect(pfEncode(null)).toBe('');
  });
});

describe('buildParamString', () => {
  it('keeps empty values as key=, preserves insertion order, drops only signature', () => {
    expect(
      buildParamString({ b: '1', a: '', signature: 'deadbeef', c: 'x y' })
    ).toBe('b=1&a=&c=x+y');
  });
});

describe('generateSignature', () => {
  it('matches the known vector (empty field INCLUDED, passphrase appended)', () => {
    expect(generateSignature(vectorData, PASSPHRASE)).toBe(
      VECTOR_WITH_EMPTY_AND_PASSPHRASE
    );
  });

  it('matches the known vector without a passphrase', () => {
    expect(generateSignature(vectorData)).toBe(VECTOR_WITH_EMPTY_NO_PASSPHRASE);
  });

  it('produces a DIFFERENT hash when empty fields are stripped (the UniFuel bug)', () => {
    const stripped = Object.fromEntries(
      Object.entries(vectorData).filter(([, v]) => v !== '')
    );
    expect(generateSignature(stripped, PASSPHRASE)).toBe(
      VECTOR_EMPTY_STRIPPED_AND_PASSPHRASE
    );
    expect(VECTOR_EMPTY_STRIPPED_AND_PASSPHRASE).not.toBe(
      VECTOR_WITH_EMPTY_AND_PASSPHRASE
    );
  });

  it('is exactly md5 of the param string + &passphrase= (independent recomputation)', () => {
    const base =
      'name_first=Jane+Doe&email_address=jane%40example.com&amount=50.00' +
      '&item_name=WaPay+load%3A+R50&custom_str1=&passphrase=jt7NOE43FZPn';
    const expected = crypto.createHash('md5').update(base).digest('hex');
    expect(generateSignature(vectorData, PASSPHRASE)).toBe(expected);
  });

  it('never includes the signature key itself in the hash input', () => {
    const withSig = { ...vectorData, signature: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    expect(generateSignature(withSig, PASSPHRASE)).toBe(
      VECTOR_WITH_EMPTY_AND_PASSPHRASE
    );
  });

  it('is order-DEPENDENT (PayFast signs wire order, not sorted order)', () => {
    const reordered: Record<string, string> = {
      custom_str1: '',
      item_name: 'WaPay load: R50',
      amount: '50.00',
      email_address: 'jane@example.com',
      name_first: 'Jane Doe',
    };
    expect(generateSignature(reordered, PASSPHRASE)).not.toBe(
      VECTOR_WITH_EMPTY_AND_PASSPHRASE
    );
  });
});

describe('verifySignature (INBOUND: empty fields INCLUDED)', () => {
  it('accepts an ITN whose signature covers empty-valued fields (real PayFast behaviour)', () => {
    const itn = { ...vectorData, signature: VECTOR_WITH_EMPTY_AND_PASSPHRASE };
    expect(verifySignature(itn, PASSPHRASE)).toBe(true);
  });

  it('REJECTS a signature computed with empties stripped — the 2-day outage direction', () => {
    // If verifySignature ever starts stripping empties, this becomes the
    // accepted hash and real ITNs (signed WITH empties) start failing.
    const itn = { ...vectorData, signature: VECTOR_EMPTY_STRIPPED_AND_PASSPHRASE };
    expect(verifySignature(itn, PASSPHRASE)).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifySignature({ ...vectorData }, PASSPHRASE)).toBe(false);
  });

  it('rejects when the passphrase differs', () => {
    const itn = { ...vectorData, signature: VECTOR_WITH_EMPTY_AND_PASSPHRASE };
    expect(verifySignature(itn, 'wrong-passphrase')).toBe(false);
  });
});

describe('buildCheckout (OUTBOUND: empty fields STRIPPED before signing)', () => {
  const params = {
    merchantId: '10000100',
    merchantKey: '46f0cd694581a',
    passphrase: PASSPHRASE,
    sandbox: true,
    amountCents: 5000,
    mPaymentId: 'wapay-load-42',
    itemName: 'WaPay wallet load',
    returnUrl: 'https://wapay.example/pay/return',
    cancelUrl: 'https://wapay.example/pay/cancel',
    notifyUrl: 'https://wapay.example/api/payfast/itn',
  };

  it('returns the sandbox process URL when sandbox, live otherwise', () => {
    expect(buildCheckout(params).url).toBe('https://sandbox.payfast.co.za/eng/process');
    expect(buildCheckout({ ...params, sandbox: false }).url).toBe(
      'https://www.payfast.co.za/eng/process'
    );
    expect(PAYFAST_PROCESS_URLS.sandbox).toContain('sandbox.');
  });

  it('converts integer cents to a rand string exactly (5000 -> "50.00")', () => {
    expect(buildCheckout(params).fields.amount).toBe('50.00');
    expect(buildCheckout({ ...params, amountCents: 100000 }).fields.amount).toBe(
      '1000.00'
    );
    expect(buildCheckout({ ...params, amountCents: 5 }).fields.amount).toBe('0.05');
  });

  it('rejects non-positive or fractional cents', () => {
    expect(() => buildCheckout({ ...params, amountCents: 0 })).toThrow();
    expect(() => buildCheckout({ ...params, amountCents: -5000 })).toThrow();
    expect(() => buildCheckout({ ...params, amountCents: 50.5 })).toThrow();
  });

  it('strips empty custom_str1 BEFORE signing: absent from fields AND from the hash', () => {
    const { fields } = buildCheckout({ ...params, customStr1: '' });
    expect('custom_str1' in fields).toBe(false);

    const { signature, ...sent } = fields;
    // The posted signature must verify over exactly the posted fields...
    expect(signature).toBe(generateSignature(sent, PASSPHRASE));
    // ...and must NOT equal a signature that (wrongly) included the empty field.
    expect(signature).not.toBe(
      generateSignature({ ...sent, custom_str1: '' }, PASSPHRASE)
    );
  });

  it('includes and signs custom_str1 when provided', () => {
    const { fields } = buildCheckout({ ...params, customStr1: 'acct_9' });
    expect(fields.custom_str1).toBe('acct_9');
    const { signature, ...sent } = fields;
    expect(signature).toBe(generateSignature(sent, PASSPHRASE));
    // Field order is PayFast's documented attribute order
    expect(Object.keys(fields)).toEqual([
      'merchant_id',
      'merchant_key',
      'return_url',
      'cancel_url',
      'notify_url',
      'm_payment_id',
      'amount',
      'item_name',
      'custom_str1',
      'signature',
    ]);
  });

  it('signs without a passphrase when none is configured', () => {
    const { fields } = buildCheckout({ ...params, passphrase: undefined });
    const { signature, ...sent } = fields;
    expect(signature).toBe(generateSignature(sent));
    expect(signature).not.toBe(generateSignature(sent, PASSPHRASE));
  });

  it('demonstrates the full asymmetry: outbound strips, inbound includes', () => {
    // Outbound: '' stripped from the signed set
    const out = buildCheckout({ ...params, customStr1: '' });
    expect('custom_str1' in out.fields).toBe(false);
    // Inbound: the same '' MUST be part of the verified set
    const itnParams = { amount: '50.00', custom_str1: '' };
    const itnSig = generateSignature(itnParams, PASSPHRASE);
    expect(verifySignature({ ...itnParams, signature: itnSig }, PASSPHRASE)).toBe(true);
    const strippedSig = generateSignature({ amount: '50.00' }, PASSPHRASE);
    expect(
      verifySignature({ ...itnParams, signature: strippedSig }, PASSPHRASE)
    ).toBe(false);
  });
});

describe('buildCheckoutUrl (signed GET for WhatsApp)', () => {
  const params = {
    merchantId: '10000100',
    merchantKey: '46f0cd694581a',
    passphrase: PASSPHRASE,
    sandbox: true,
    amountCents: 5000,
    mPaymentId: 'wapay-load-42',
    itemName: 'WaPay wallet load',
    returnUrl: 'https://wapay.example/pay/return',
    cancelUrl: 'https://wapay.example/pay/cancel',
    notifyUrl: 'https://wapay.example/api/payfast/itn',
    customStr1: 'acct_9',
  };

  it('targets the process endpoint with a query string', () => {
    const url = buildCheckoutUrl(params);
    expect(url.startsWith('https://sandbox.payfast.co.za/eng/process?')).toBe(true);
    expect(buildCheckoutUrl({ ...params, sandbox: false }).startsWith(
      'https://www.payfast.co.za/eng/process?'
    )).toBe(true);
  });

  it('emits a query byte-identical to the signed base string + &signature=', () => {
    const { fields } = buildCheckout(params);
    const { signature, ...sent } = fields;
    const expectedQuery =
      buildParamString(sent) + '&signature=' + signature;
    const url = buildCheckoutUrl(params);
    expect(url).toBe(`${PAYFAST_PROCESS_URLS.sandbox}?${expectedQuery}`);
    // Spaces travel as '+', which form-decoding restores to the signed value
    expect(url).toContain('item_name=WaPay+wallet+load');
    expect(url).not.toContain('%20');
  });

  it('round-trips: decoding the query and re-signing reproduces the signature param', () => {
    const url = buildCheckoutUrl(params);
    const query = new URL(url).search.slice(1);
    // URLSearchParams applies form decoding ('+' -> space), like PayFast will
    const decoded: Record<string, string> = {};
    new URLSearchParams(query).forEach((value, key) => {
      decoded[key] = value;
    });
    const receivedSignature = decoded.signature;
    delete decoded.signature;
    expect(generateSignature(decoded, PASSPHRASE)).toBe(receivedSignature);
  });

  it('carries the same signature as the POST form (same algorithm, GET vs POST)', () => {
    const { fields } = buildCheckout(params);
    const url = buildCheckoutUrl(params);
    expect(url.endsWith(`&signature=${fields.signature}`)).toBe(true);
  });
});
