import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { BluVasExtendedClient } from '../src/vas-extended';

describe('BluVasExtendedClient electricity', () => {
  const baseUrl = 'https://test-api.bluvoucher.co.za';
  let mockAgent: MockAgent;

  beforeEach(() => {
    process.env.BLU_BASE_URL = baseUrl;
    process.env.BLU_BASIC_USER = 'user';
    process.env.BLU_BASIC_PASS = 'pass';
    process.env.BLU_API_KEY = 'test-api-key';

    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    await mockAgent.close();
  });

  it('getElectricityInfo calls GET /electricity/info with correct query params and returns reference', async () => {
    const client = new BluVasExtendedClient();
    const meterNumber = '00000100000';
    const amountCents = 20000;

    const mockPool = mockAgent.get(baseUrl);
    mockPool
      .intercept({
        path: `/electricity/info?amount=${amountCents}&free-basic-electricity=false&meter-number=${meterNumber}`,
        method: 'GET',
      })
      .reply(200, {
        reference: 'ELEC-REF-123',
        meterNumber,
        amount: amountCents,
        customerName: 'Test Customer',
      });

    const info = await client.getElectricityInfo({ meterNumber, amountCents, freeBasicElectricity: false });
    expect(info.reference).toBe('ELEC-REF-123');
    expect(info.meterNumber).toBe(meterNumber);
    expect(info.amountCents).toBe(amountCents);
  });

  it('purchaseElectricity posts reference to /electricity/sales', async () => {
    const client = new BluVasExtendedClient();
    const mockPool = mockAgent.get(baseUrl);

    mockPool
      .intercept({
        path: '/electricity/sales',
        method: 'POST',
      })
      .reply(201, {
        reference: 'ELEC-SALE-REF-999',
        amount: 20000,
        dateTime: '2026-01-02T10:00:00Z',
        token: '12345678901234567890',
        tokenType: 'STS_1',
        units: 10,
        unitRate: 200,
        meterNumber: '00000100000',
        municipalityName: 'Eskom',
      });

    const result = await client.purchaseElectricity({
      reference: 'ELEC-REF-123',
      idemKey: 'test-elec-idem',
      accountId: 'acc_1',
      journalEntryId: 'je_1',
    });

    expect(result.providerRef).toBe('ELEC-SALE-REF-999');
    expect(result.token).toBe('12345678901234567890');
  });
});


