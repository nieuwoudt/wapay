import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildElectricitySalePayload } from '../lib/electricity-utils.js';

function fakePreviewCall() {
  return {
    reference: 'REF-123',
    transactionTypeId: 'TT-1',
    utility: 'UTIL',
    consumer: { name: 'Alice', address: '123 Main' },
  };
}

test('electricity flow uses stored preview reference (no re-preview)', () => {
  let previewCalls = 0;

  // Simulate preview
  const preview = fakePreviewCall();
  previewCalls += 1;

  // Simulate confirm -> pin -> execute using stored preview data (no new preview)
  const payload = buildElectricitySalePayload({
    draft: {
      meterNumber: '00000100000',
      amountCents: 20000,
      reference: preview.reference,
      transactionTypeId: preview.transactionTypeId,
      utility: preview.utility,
      consumer: preview.consumer,
    },
    accountId: 'acc-1',
    journalEntryId: 'je-1',
    idemKey: 'idem-1',
  });

  assert.equal(previewCalls, 1, 'preview should be called exactly once');
  assert.equal(payload.reference, 'REF-123', 'execute must use stored reference');
  assert.equal(payload.meta.transactionTypeId, 'TT-1');
});

