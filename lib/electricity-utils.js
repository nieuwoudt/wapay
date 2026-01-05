/**
 * Helpers for electricity confirm/vend flow (pure, testable).
 */

export function buildElectricityDraft({ meterNumber, amountCents, info }) {
  return {
    meterNumber,
    amountCents,
    reference: info?.reference || '',
    transactionTypeId: info?.transactionTypeId || info?.transactionType || null,
    utility: info?.municipalityName || info?.utility || null,
    consumer: {
      name: info?.customerName || null,
      address: info?.customerAddress || null,
    },
    rawInfo: info || {},
  };
}

export function buildElectricitySalePayload({ draft, accountId, journalEntryId, idemKey }) {
  return {
    requestId: idemKey,
    reference: draft.reference,
    vendMetaData: {
      transactionRequestDateTime: new Date().toISOString(),
      transactionReference: journalEntryId ? `WAPAY-${journalEntryId}` : idemKey,
    },
    meta: {
      meterNumber: draft.meterNumber,
      amountCents: draft.amountCents,
      transactionTypeId: draft.transactionTypeId,
      utility: draft.utility,
      consumer: draft.consumer,
      accountId,
    },
  };
}

