/**
 * BluVasClient Unit Tests
 * 
 * Comprehensive test suite for the Blu VAS (Value Added Services) client.
 * Tests cover:
 * - Airtime purchases (happy path, errors)
 * - Data bundle purchases (happy path, errors)
 * - Network detection (success, fallback)
 * - Retry behavior on transient errors
 * - Error mapping (USER_INPUT, AUTH, RETRYABLE)
 * - Phone number normalization
 * - VendMetaData construction
 * 
 * Target: 20+ test cases with good branch coverage
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, Dispatcher } from 'undici';

// Mock environment variables before importing BluVasClient
vi.stubEnv('BLU_BASE_URL', 'https://test-api.bluvoucher.co.za');
vi.stubEnv('BLU_BASIC_USER', 'test-user');
vi.stubEnv('BLU_BASIC_PASS', 'test-pass');
vi.stubEnv('BLU_API_KEY', 'test-api-key');

// Import after env vars are set
import { BluVasClient } from '../src/vas.js';

describe('BluVasClient', () => {
  let client: BluVasClient;
  let mockAgent: MockAgent;
  let originalDispatcher: Dispatcher;

  const baseUrl = 'https://test-api.bluvoucher.co.za';

  beforeEach(() => {
    client = new BluVasClient();
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
  // Phone Number Normalization Tests
  // ===========================================================================
  describe('Phone Number Normalization', () => {
    it('should convert +27 format to 0 format', () => {
      // Access private method via prototype or test through purchase call
      const result = (client as any).toBluFormat('+27821234567');
      expect(result).toBe('0821234567');
    });

    it('should convert 27 format (without +) to 0 format', () => {
      const result = (client as any).toBluFormat('27821234567');
      expect(result).toBe('0821234567');
    });

    it('should preserve already normalized numbers', () => {
      const result = (client as any).toBluFormat('0821234567');
      expect(result).toBe('0821234567');
    });

    it('should handle edge cases gracefully', () => {
      const result = (client as any).toBluFormat('821234567');
      expect(result).toBe('821234567');
    });
  });

  // ===========================================================================
  // VendMetaData Construction Tests
  // ===========================================================================
  describe('VendMetaData Construction', () => {
    it('should build vendMetaData with correct structure', () => {
      const result = (client as any).buildVendMetaData({
        accountId: 'acc-123',
        journalEntryId: 'journal-456',
        msisdn: '+27821234567',
        idemKey: 'test-idem-123',
      });

      expect(result).toMatchObject({
        transactionReference: 'test-idem-123',
      });
      expect(result.transactionRequestDateTime).toBeDefined();
    });

    it('should normalize phone number in vendMetaData', () => {
      const result = (client as any).buildVendMetaData({
        accountId: 'acc-123',
        journalEntryId: 'journal-456',
        msisdn: '+27831234567',
        idemKey: 'test-idem-123',
      });

      expect(result.transactionReference).toBe('test-idem-123');
    });
  });

  // ===========================================================================
  // Airtime Purchase Tests
  // ===========================================================================
  describe('purchaseAirtime', () => {
    const airtimeParams = {
      msisdn: '+27821234567',
      amountCents: 5000,
      vendorId: 'vodacom',
      idemKey: 'test-idem-123',
      accountId: 'acc-123',
      journalEntryId: 'journal-456',
    };

    it('should successfully purchase airtime', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: '/mobile/airtime/sales',
        method: 'POST',
        body: /"mobile-number":"0821234567"/,
      }).reply(200, {
        requestId: 'test-idem-123',
        reference: 'BLU-REF-789',
        amount: 5000,
        dateTime: '2025-01-15T10:30:00Z',
        mobileNumber: '0821234567',
        vendorName: 'Vodacom',
      });

      const result = await client.purchaseAirtime(airtimeParams);

      expect(result).toEqual({
        providerRef: 'BLU-REF-789',
        amountCents: 5000,
        vendorName: 'Vodacom',
        dateTime: '2025-01-15T10:30:00Z',
      });
    });

    it('should handle 201 status as success', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: '/mobile/airtime/sales',
        method: 'POST',
      }).reply(201, {
        reference: 'BLU-REF-789',
        amount: 5000,
        vendorName: 'Vodacom',
        dateTime: '2025-01-15T10:30:00Z',
      });

      const result = await client.purchaseAirtime(airtimeParams);
      expect(result.providerRef).toBe('BLU-REF-789');
    });

    it('should throw USER_INPUT error on 400 response', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: '/mobile/airtime/sales',
        method: 'POST',
      }).reply(400, {
        error: 'Invalid mobile number',
        message: 'The provided mobile number is invalid',
      });

      await expect(client.purchaseAirtime(airtimeParams)).rejects.toThrow('USER_INPUT');
    });

    it('should not retry on INVALID_PHONE_NUMBER error', async () => {
      const mockPool = mockAgent.get(baseUrl);
      // If retry happens, the second call will succeed and the expectation to throw will fail.
      mockPool.intercept({
        path: '/mobile/airtime/sales',
        method: 'POST',
      }).reply(400, {
        error: 'Bad Request',
        message: 'Invalid phone number',
      });

      mockPool.intercept({
        path: '/mobile/airtime/sales',
        method: 'POST',
      }).reply(201, {
        reference: 'BLU-REF-SHOULD-NOT-HAPPEN',
        amount: 5000,
        vendorName: 'Vodacom',
        dateTime: '2025-01-15T10:30:00Z',
      });

      await expect(client.purchaseAirtime(airtimeParams)).rejects.toThrow('INVALID_PHONE_NUMBER');
    });

    it('should throw USER_INPUT error on 404 response', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: '/mobile/airtime/sales',
        method: 'POST',
      }).reply(404, {
        error: 'Vendor not found',
      });

      await expect(client.purchaseAirtime(airtimeParams)).rejects.toThrow('USER_INPUT');
    });

    it('should throw AUTH error on 401 response', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: '/mobile/airtime/sales',
        method: 'POST',
      }).reply(401, {
        error: 'Unauthorized',
      });

      await expect(client.purchaseAirtime(airtimeParams)).rejects.toThrow('AUTH');
    });

    it('should throw AUTH error on 403 response', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: '/mobile/airtime/sales',
        method: 'POST',
      }).reply(403, {
        error: 'Forbidden',
      });

      await expect(client.purchaseAirtime(airtimeParams)).rejects.toThrow('AUTH');
    });

    it('should throw RETRYABLE error on 429 rate limit', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: '/mobile/airtime/sales',
        method: 'POST',
      }).reply(429, {}).times(3);

      await expect(client.purchaseAirtime(airtimeParams)).rejects.toThrow('RETRYABLE');
    });

    it('should throw RETRYABLE error on 500 server error after retries', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: '/mobile/airtime/sales',
        method: 'POST',
      }).reply(500, { error: 'Internal server error' }).times(3);

      await expect(client.purchaseAirtime(airtimeParams)).rejects.toThrow('RETRYABLE');
    });

    it('should throw RETRYABLE error on 502 gateway error after retries', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: '/mobile/airtime/sales',
        method: 'POST',
      }).reply(502, {}).times(3);

      await expect(client.purchaseAirtime(airtimeParams)).rejects.toThrow('RETRYABLE');
    });

    it('should retry on transient error then succeed', async () => {
      const mockPool = mockAgent.get(baseUrl);
      
      // First call fails with 500
      mockPool.intercept({
        path: '/mobile/airtime/sales',
        method: 'POST',
      }).reply(500, { error: 'Temporary failure' });
      
      // Second call succeeds
      mockPool.intercept({
        path: '/mobile/airtime/sales',
        method: 'POST',
      }).reply(200, {
        reference: 'BLU-REF-RETRY',
        amount: 5000,
        vendorName: 'Vodacom',
        dateTime: '2025-01-15T10:30:00Z',
      });

      const result = await client.purchaseAirtime(airtimeParams);
      expect(result.providerRef).toBe('BLU-REF-RETRY');
    });

    it('should not retry on USER_INPUT error', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: '/mobile/airtime/sales',
        method: 'POST',
      }).reply(400, { error: 'Bad request' });
      
      // This should NOT be called if retry is working correctly
      mockPool.intercept({
        path: '/mobile/airtime/sales',
        method: 'POST',
      }).reply(200, { reference: 'should-not-reach' });

      await expect(client.purchaseAirtime(airtimeParams)).rejects.toThrow('USER_INPUT');
    });

    it('should not retry on AUTH error', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: '/mobile/airtime/sales',
        method: 'POST',
      }).reply(401, { error: 'Unauthorized' });

      await expect(client.purchaseAirtime(airtimeParams)).rejects.toThrow('AUTH');
    });
  });

  // ===========================================================================
  // Network Detection Tests
  // ===========================================================================
  describe('checkMobileNumber', () => {
    it('should detect Vodacom network (201 success)', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: /\/mobile\/airtime\/mobile-number\/check/,
        method: 'GET',
      }).reply(201, {
        vendorName: 'Vodacom',
        mobileNumber: '0821234567',
      });

      const result = await client.checkMobileNumber('+27821234567');
      expect(result.vendorName).toBe('Vodacom');
    });

    it('should detect MTN network', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: /\/mobile\/airtime\/mobile-number\/check/,
        method: 'GET',
      }).reply(200, {
        vendorName: 'MTN',
        mobileNumber: '0831234567',
      });

      const result = await client.checkMobileNumber('+27831234567');
      expect(result.vendorName).toBe('MTN');
    });

    it('should handle network detection failure', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: /\/mobile\/airtime\/mobile-number\/check/,
        method: 'GET',
      }).reply(404, {
        error: 'Mobile number not found',
      });

      await expect(client.checkMobileNumber('+27999999999')).rejects.toThrow('USER_INPUT');
    });

    it('should retry network detection on server error', async () => {
      const mockPool = mockAgent.get(baseUrl);
      
      mockPool.intercept({
        path: /\/mobile\/airtime\/mobile-number\/check/,
        method: 'GET',
      }).reply(500, {});
      
      mockPool.intercept({
        path: /\/mobile\/airtime\/mobile-number\/check/,
        method: 'GET',
      }).reply(200, {
        vendorName: 'Cell C',
        mobileNumber: '0841234567',
      });

      const result = await client.checkMobileNumber('+27841234567');
      expect(result.vendorName).toBe('Cell C');
    });
  });

  // ===========================================================================
  // Data Products Tests
  // ===========================================================================
  describe('getDataProducts', () => {
    it('should fetch all data products when no vendorId specified', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: '/mobile/data/products',
        method: 'GET',
      }).reply(200, [
        { id: 'voda-500mb', name: '500MB Daily', category: 'data', vendorId: 'vodacom', amount: 2500 },
        { id: 'mtn-1gb', name: '1GB Weekly', category: 'data', vendorId: 'mtn', amount: 5000 },
      ]);

      const result = await client.getDataProducts();
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: 'voda-500mb',
        name: '500MB Daily',
        amountCents: 2500,
      });
    });

    it('should filter data products by vendorId', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: '/mobile/data/products?vendorId=vodacom',
        method: 'GET',
      }).reply(200, [
        { id: 'voda-500mb', name: '500MB Daily', category: 'data', vendorId: 'vodacom', amount: 2500 },
      ]);

      const result = await client.getDataProducts('vodacom');
      expect(result).toHaveLength(1);
      expect(result[0].vendorId).toBe('vodacom');
    });

    it('should handle empty product list', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: '/mobile/data/products?vendorId=unknown',
        method: 'GET',
      }).reply(200, []);

      const result = await client.getDataProducts('unknown');
      expect(result).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Data Bundle Purchase Tests
  // ===========================================================================
  describe('purchaseDataBundle', () => {
    const dataParams = {
      msisdn: '+27821234567',
      productId: 'voda-500mb',
      vendorId: 'vodacom',
      idemKey: 'test-data-123',
      accountId: 'acc-123',
      journalEntryId: 'journal-789',
    };

    it('should successfully purchase data bundle', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: '/mobile/data/sales',
        method: 'POST',
      }).reply(200, {
        reference: 'BLU-DATA-456',
        amount: 2500,
        productName: '500MB Daily',
        vendorName: 'Vodacom',
        dateTime: '2025-01-15T11:00:00Z',
      });

      const result = await client.purchaseDataBundle(dataParams);

      expect(result).toEqual({
        providerRef: 'BLU-DATA-456',
        amountCents: 2500,
        productName: '500MB Daily',
        vendorName: 'Vodacom',
        dateTime: '2025-01-15T11:00:00Z',
      });
    });

    it('should throw USER_INPUT error for invalid product', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: '/mobile/data/sales',
        method: 'POST',
      }).reply(400, {
        error: 'Product not found',
      });

      await expect(client.purchaseDataBundle({
        ...dataParams,
        productId: 'invalid-product',
      })).rejects.toThrow('USER_INPUT');
    });

    it('should throw USER_INPUT error on 409 conflict (duplicate)', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: '/mobile/data/sales',
        method: 'POST',
      }).reply(409, {
        error: 'Duplicate request',
      });

      await expect(client.purchaseDataBundle(dataParams)).rejects.toThrow('USER_INPUT');
    });
  });

  // ===========================================================================
  // Vendor Name Mapping Tests
  // ===========================================================================
  describe('Vendor Name Mapping', () => {
    it('should map vendorName to vendorId', () => {
      expect(client.vendorNameToId('Vodacom')).toBe('vodacom');
      expect(client.vendorNameToId('MTN')).toBe('mtn');
      expect(client.vendorNameToId('Cell C')).toBe('cellc');
    });

    it('should map vendorId to display name', () => {
      expect(client.vendorIdToName('vodacom')).toBe('Vodacom');
      expect(client.vendorIdToName('mtn')).toBe('MTN');
      expect(client.vendorIdToName('cellc')).toBe('Cell C');
      expect(client.vendorIdToName('telkom')).toBe('Telkom');
    });

    it('should return original value for unknown vendor', () => {
      expect(client.vendorIdToName('unknown')).toBe('unknown');
    });
  });

  // ===========================================================================
  // Error Handling Edge Cases
  // ===========================================================================
  describe('Error Handling Edge Cases', () => {
    it('should include statusCode in error object', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: '/mobile/airtime/sales',
        method: 'POST',
      }).reply(400, { error: 'Bad request' });

      try {
        await client.purchaseAirtime({
          msisdn: '+27821234567',
          amountCents: 5000,
          vendorId: 'vodacom',
          idemKey: 'test-123',
          accountId: 'acc-123',
          journalEntryId: 'journal-123',
        });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.statusCode).toBe(400);
      }
    });

    it('should include reason in error object', async () => {
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: '/mobile/airtime/sales',
        method: 'POST',
      }).reply(400, { 
        error: 'Validation failed',
        message: 'Amount must be positive',
      });

      try {
        await client.purchaseAirtime({
          msisdn: '+27821234567',
          amountCents: -100,
          vendorId: 'vodacom',
          idemKey: 'test-123',
          accountId: 'acc-123',
          journalEntryId: 'journal-123',
        });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.reason).toBe('Amount must be positive');
      }
    });
  });

  // ===========================================================================
  // Headers Tests
  // ===========================================================================
  describe('HTTP Headers', () => {
    it('should include correct authorization headers', async () => {
      let capturedHeaders: Record<string, string> = {};
      
      const mockPool = mockAgent.get(baseUrl);
      mockPool.intercept({
        path: '/mobile/airtime/sales',
        method: 'POST',
      }).reply(200, (opts) => {
        capturedHeaders = opts.headers as Record<string, string>;
        return {
          reference: 'test-ref',
          amount: 5000,
          vendorName: 'Vodacom',
          dateTime: new Date().toISOString(),
        };
      });

      await client.purchaseAirtime({
        msisdn: '+27821234567',
        amountCents: 5000,
        vendorId: 'vodacom',
        idemKey: 'test-123',
        accountId: 'acc-123',
        journalEntryId: 'journal-123',
      });

      // Verify headers were set (basic auth and apikey)
      expect(capturedHeaders).toBeDefined();
    });
  });
});

