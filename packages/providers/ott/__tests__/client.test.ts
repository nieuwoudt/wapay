/**
 * OttClient Unit Tests
 *
 * Test suite for the OTT Mobile voucher issuing client. Covers:
 * - Request hash construction (doc example known-vector)
 * - HTTP Basic auth header + application/x-www-form-urlencoded encoding
 * - Success envelope (success === 'true' strings)
 * - Error taxonomy mapping (AUTH / USER_INPUT / RETRYABLE)
 * - GetVoucher timeout -> TIMEOUT_CHECK_REQUIRED with .uniqueReference
 * - Rand-string -> integer cents parsing (exact, no floats)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, Dispatcher } from 'undici';

// Mock environment variables before importing OttClient
vi.stubEnv('OTT_BASE_URL', 'https://test-api.ott-mobile.com');
vi.stubEnv('OTT_API_USERNAME', 'test-user');
vi.stubEnv('OTT_API_PASSWORD', 'test-pass');
vi.stubEnv('OTT_API_KEY', 'ace4e782-e953-45d5-9f2a-aa1498c830ed');

// Import after env vars are set
import { OttClient, hashParams, randToCents, centsToRand } from '../src/client.js';

const baseUrl = 'https://test-api.ott-mobile.com';
const apiKey = 'ace4e782-e953-45d5-9f2a-aa1498c830ed';
const expectBasicAuth = 'Basic ' + Buffer.from('test-user:test-pass').toString('base64');

/** Voucher JSON exactly as the spec sends it: a JSON-encoded STRING field. */
const specVoucherBody = {
  success: 'true',
  voucher:
    '{"voucherID":71238,"saleID":79022,"pin":"257262903647","serialNumber":"300000268491","batch":"320201112","instructions":"","amount":10.0000}',
};

describe('hashParams', () => {
  it('matches the documented example exactly (key + values in alphabetical param order)', () => {
    // Doc: sha256('ace4e782-e953-45d5-9f2a-aa1498c830ed' + '11' + '123456789012')
    const hash = hashParams({ VendorID: '11', VoucherPin: '123456789012' }, apiKey);
    expect(hash).toBe('c399a3964ec6d7e3e7804fa56d14c78e2a1a880c1a702127d96a790ec6332bf0');
  });

  it('is independent of object insertion order', () => {
    const a = hashParams({ VoucherPin: '123456789012', VendorID: '11' }, apiKey);
    const b = hashParams({ VendorID: '11', VoucherPin: '123456789012' }, apiKey);
    expect(a).toBe(b);
  });

  it('concatenates values only, without separators or param names', () => {
    // sha256 of apiKey + '' should equal a hash over an empty param set
    const empty = hashParams({}, apiKey);
    expect(empty).toHaveLength(64);
    expect(empty).not.toBe(hashParams({ x: 'x' }, apiKey));
  });
});

describe('randToCents', () => {
  it('parses rand strings to integer cents with exact math', () => {
    expect(randToCents('996.70')).toBe(99670);
    expect(randToCents('0.00')).toBe(0);
    expect(randToCents('1000')).toBe(100000);
  });

  it('handles negative balances (GetBalance sends e.g. "-3.30")', () => {
    expect(randToCents('-3.30')).toBe(-330);
  });

  it('handles JSON numbers and long zero decimals (10.0000 from GetVoucher)', () => {
    expect(randToCents(10.0)).toBe(1000);
    expect(randToCents('10.0000')).toBe(1000);
    expect(randToCents('10.5')).toBe(1050);
  });

  it('rejects malformed and sub-cent amounts', () => {
    expect(() => randToCents('abc')).toThrow();
    expect(() => randToCents('10.005')).toThrow();
    expect(() => randToCents('')).toThrow();
  });
});

describe('centsToRand', () => {
  it('formats integer cents as decimal rand strings', () => {
    expect(centsToRand(1000)).toBe('10.00');
    expect(centsToRand(99670)).toBe('996.70');
    expect(centsToRand(5)).toBe('0.05');
    expect(centsToRand(0)).toBe('0.00');
  });

  it('rejects non-integer cents', () => {
    expect(() => centsToRand(10.5)).toThrow();
  });
});

describe('OttClient', () => {
  let client: OttClient;
  let mockAgent: MockAgent;
  let originalDispatcher: Dispatcher;

  beforeEach(() => {
    client = new OttClient();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    originalDispatcher = getGlobalDispatcher();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(() => {
    setGlobalDispatcher(originalDispatcher);
    mockAgent.close();
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Wire format: Basic auth, form encoding, hash field
  // ===========================================================================
  describe('wire format', () => {
    it('sends Basic auth, form-urlencoded body and the correct hash field', async () => {
      let captured: any;
      mockAgent
        .get(baseUrl)
        .intercept({ path: '/api/reseller/v1/GetBalance', method: 'POST' })
        .reply((opts) => {
          captured = opts;
          return {
            statusCode: 200,
            data: { success: 'true', balance: '-3.30', availableBalance: '996.70' },
          };
        });

      await client.getBalance('bal-ref-1');

      const headers = captured.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(expectBasicAuth);
      expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');

      // Body must be form variables, never JSON
      const form = new URLSearchParams(String(captured.body));
      expect(form.get('uniqueReference')).toBe('bal-ref-1');
      expect(form.get('hash')).toBe(hashParams({ uniqueReference: 'bal-ref-1' }, apiKey));
      expect(String(captured.body).startsWith('{')).toBe(false);
    });

    it('honours constructor config overrides over env', async () => {
      const overridden = new OttClient({
        baseUrl: 'https://other.example.com',
        username: 'u2',
        password: 'p2',
        apiKey: 'other-key',
      });
      let captured: any;
      mockAgent
        .get('https://other.example.com')
        .intercept({ path: '/api/reseller/v1/GetBalance', method: 'POST' })
        .reply((opts) => {
          captured = opts;
          return {
            statusCode: 200,
            data: { success: 'true', balance: '0.00', availableBalance: '0.00' },
          };
        });

      await overridden.getBalance('r1');
      expect(captured.headers['Authorization']).toBe(
        'Basic ' + Buffer.from('u2:p2').toString('base64'),
      );
      const form = new URLSearchParams(String(captured.body));
      expect(form.get('hash')).toBe(hashParams({ uniqueReference: 'r1' }, 'other-key'));
    });
  });

  // ===========================================================================
  // GetBalance
  // ===========================================================================
  describe('getBalance', () => {
    it('returns balances as integer cents (rand strings parsed exactly)', async () => {
      mockAgent
        .get(baseUrl)
        .intercept({ path: '/api/reseller/v1/GetBalance', method: 'POST' })
        .reply(200, { success: 'true', balance: '-3.30', availableBalance: '996.70' });

      const result = await client.getBalance('bal-ref-2');
      expect(result).toEqual({ balanceCents: -330, availableBalanceCents: 99670 });
    });

    it('maps 401 (empty body) to AUTH', async () => {
      mockAgent
        .get(baseUrl)
        .intercept({ path: '/api/reseller/v1/GetBalance', method: 'POST' })
        .reply(401, '');

      await expect(client.getBalance('r')).rejects.toThrow('AUTH');
    });

    it('maps 500 to RETRYABLE', async () => {
      mockAgent
        .get(baseUrl)
        .intercept({ path: '/api/reseller/v1/GetBalance', method: 'POST' })
        .reply(500, {
          success: 'false',
          message: ' we are experiencing a problem, please try later ',
        });

      await expect(client.getBalance('r')).rejects.toThrow('RETRYABLE');
    });

    it('maps network errors to RETRYABLE', async () => {
      mockAgent
        .get(baseUrl)
        .intercept({ path: '/api/reseller/v1/GetBalance', method: 'POST' })
        .replyWithError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

      await expect(client.getBalance('r')).rejects.toThrow('RETRYABLE');
    });

    it('maps a timeout on a non-GetVoucher call to RETRYABLE (safe to re-ask)', async () => {
      mockAgent
        .get(baseUrl)
        .intercept({ path: '/api/reseller/v1/GetBalance', method: 'POST' })
        .replyWithError(
          Object.assign(new Error('Headers Timeout Error'), {
            code: 'UND_ERR_HEADERS_TIMEOUT',
            name: 'HeadersTimeoutError',
          }),
        );

      await expect(client.getBalance('r')).rejects.toThrow('RETRYABLE');
    });
  });

  // ===========================================================================
  // GetVoucher
  // ===========================================================================
  describe('getVoucher', () => {
    const voucherParams = {
      branch: 'WAPAY-HQ',
      cashier: 'BOT-1',
      uniqueReference: 'ott-idem-123',
      valueCents: 1000,
      vendorCode: 11,
      mobileForSMS: '0821234567',
      till: 'WHATSAPP',
    };

    it('issues a voucher, decoding the nested voucher JSON string to cents', async () => {
      let captured: any;
      mockAgent
        .get(baseUrl)
        .intercept({ path: '/api/reseller/v1/GetVoucher', method: 'POST' })
        .reply((opts) => {
          captured = opts;
          return { statusCode: 200, data: specVoucherBody };
        });

      const voucher = await client.getVoucher(voucherParams);

      expect(voucher).toEqual({
        voucherId: 71238,
        saleId: 79022,
        pin: '257262903647',
        serialNumber: '300000268491',
        batch: '320201112',
        instructions: '',
        amountCents: 1000, // 10.0000 rand
        uniqueReference: 'ott-idem-123',
      });

      // value must go on the wire as a decimal rand string, hashed with all sent params
      const form = new URLSearchParams(String(captured.body));
      expect(form.get('value')).toBe('10.00');
      expect(form.get('vendorCode')).toBe('11');
      expect(form.get('branch')).toBe('WAPAY-HQ');
      expect(form.get('cashier')).toBe('BOT-1');
      expect(form.get('mobileForSMS')).toBe('0821234567');
      expect(form.get('till')).toBe('WHATSAPP');
      expect(form.get('hash')).toBe(
        hashParams(
          {
            branch: 'WAPAY-HQ',
            cashier: 'BOT-1',
            uniqueReference: 'ott-idem-123',
            value: '10.00',
            vendorCode: '11',
            mobileForSMS: '0821234567',
            till: 'WHATSAPP',
          },
          apiKey,
        ),
      );
    });

    it('omits optional params (and excludes them from the hash) when not provided', async () => {
      let captured: any;
      mockAgent
        .get(baseUrl)
        .intercept({ path: '/api/reseller/v1/GetVoucher', method: 'POST' })
        .reply((opts) => {
          captured = opts;
          return { statusCode: 200, data: specVoucherBody };
        });

      await client.getVoucher({
        branch: 'B',
        cashier: 'C',
        uniqueReference: 'ref-x',
        valueCents: 5000,
        vendorCode: 11,
      });

      const form = new URLSearchParams(String(captured.body));
      expect(form.has('mobileForSMS')).toBe(false);
      expect(form.has('till')).toBe(false);
      expect(form.get('value')).toBe('50.00');
      expect(form.get('hash')).toBe(
        hashParams(
          { branch: 'B', cashier: 'C', uniqueReference: 'ref-x', value: '50.00', vendorCode: '11' },
          apiKey,
        ),
      );
    });

    it('maps HTTP 201 success:"false" (insufficient funds) to USER_INPUT with reason + errorCode', async () => {
      mockAgent
        .get(baseUrl)
        .intercept({ path: '/api/reseller/v1/GetVoucher', method: 'POST' })
        .reply(201, {
          success: 'false',
          errorCode: '6',
          message: 'You do not have sufficient funds',
        });

      const err: any = await client.getVoucher(voucherParams).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('USER_INPUT');
      expect(err.reason).toBe('You do not have sufficient funds');
      expect(err.errorCode).toBe('6');
    });

    it('throws TIMEOUT_CHECK_REQUIRED with .uniqueReference on timeout (never retries GetVoucher)', async () => {
      mockAgent
        .get(baseUrl)
        .intercept({ path: '/api/reseller/v1/GetVoucher', method: 'POST' })
        .replyWithError(
          Object.assign(new Error('Headers Timeout Error'), {
            code: 'UND_ERR_HEADERS_TIMEOUT',
            name: 'HeadersTimeoutError',
          }),
        );

      const err: any = await client.getVoucher(voucherParams).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('TIMEOUT_CHECK_REQUIRED');
      expect(err.uniqueReference).toBe('ott-idem-123');
    });

    it('maps 401 to AUTH', async () => {
      mockAgent
        .get(baseUrl)
        .intercept({ path: '/api/reseller/v1/GetVoucher', method: 'POST' })
        .reply(401, 'Authentication Failed');

      await expect(client.getVoucher(voucherParams)).rejects.toThrow('AUTH');
    });

    it('treats an unparseable success body as TIMEOUT_CHECK_REQUIRED (voucher may exist)', async () => {
      mockAgent
        .get(baseUrl)
        .intercept({ path: '/api/reseller/v1/GetVoucher', method: 'POST' })
        .reply(200, { success: 'true', voucher: 'not-json-at-all' });

      const err: any = await client.getVoucher(voucherParams).catch((e) => e);
      expect(err.message).toBe('TIMEOUT_CHECK_REQUIRED');
      expect(err.uniqueReference).toBe('ott-idem-123');
    });
  });

  // ===========================================================================
  // CheckVoucher
  // ===========================================================================
  describe('checkVoucher', () => {
    it('returns the voucher issued under a previous uniqueReference', async () => {
      mockAgent
        .get(baseUrl)
        .intercept({ path: '/api/reseller/v1/CheckVoucher', method: 'POST' })
        .reply(200, specVoucherBody);

      const voucher = await client.checkVoucher('ott-idem-123');
      expect(voucher.pin).toBe('257262903647');
      expect(voucher.amountCents).toBe(1000);
      expect(voucher.uniqueReference).toBe('ott-idem-123');
    });

    it('maps "Not Found" (201 success:"false") to USER_INPUT', async () => {
      mockAgent
        .get(baseUrl)
        .intercept({ path: '/api/reseller/v1/CheckVoucher', method: 'POST' })
        .reply(201, { success: 'false', errorCode: '1', message: 'Not Found' });

      const err: any = await client.checkVoucher('unknown-ref').catch((e) => e);
      expect(err.message).toBe('USER_INPUT');
      expect(err.reason).toBe('Not Found');
      expect(err.errorCode).toBe('1');
    });
  });

  // ===========================================================================
  // ConfirmVoucher / RejectVoucher
  // ===========================================================================
  describe('confirmVoucher / rejectVoucher', () => {
    it('confirms a voucher', async () => {
      let captured: any;
      mockAgent
        .get(baseUrl)
        .intercept({ path: '/api/reseller/v1/ConfirmVoucher', method: 'POST' })
        .reply((opts) => {
          captured = opts;
          return { statusCode: 200, data: { success: 'true', message: 'Voucher Confirmed' } };
        });

      const result = await client.confirmVoucher('ott-idem-123');
      expect(result).toEqual({ message: 'Voucher Confirmed' });
      const form = new URLSearchParams(String(captured.body));
      expect(form.get('uniqueReference')).toBe('ott-idem-123');
      expect(form.get('hash')).toBe(hashParams({ uniqueReference: 'ott-idem-123' }, apiKey));
    });

    it('rejects a voucher', async () => {
      mockAgent
        .get(baseUrl)
        .intercept({ path: '/api/reseller/v1/RejectVoucher', method: 'POST' })
        .reply(200, { success: 'true', message: 'Voucher Rejected' });

      const result = await client.rejectVoucher('ott-idem-123');
      expect(result).toEqual({ message: 'Voucher Rejected' });
    });

    it('maps "Invalid Reference" to USER_INPUT', async () => {
      mockAgent
        .get(baseUrl)
        .intercept({ path: '/api/reseller/v1/ConfirmVoucher', method: 'POST' })
        .reply(201, { success: 'false', errorCode: '1', message: 'Invalid Reference' });

      const err: any = await client.confirmVoucher('dup-ref').catch((e) => e);
      expect(err.message).toBe('USER_INPUT');
      expect(err.reason).toBe('Invalid Reference');
    });
  });
});
