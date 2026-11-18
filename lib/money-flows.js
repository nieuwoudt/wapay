/**
 * Money flows for Mission Control (pages/api/admin/metrics.js and growth.js).
 *
 * Both tabs aggregate journal lines per entry source in SQL (one row per source, with the credit and the debit
 * summed) and turn each row into a signed amount here, so the Dashboard and the Growth tab cannot disagree
 * about what counts as money in, spend, a transfer or money out, or about what a reversal takes off.
 *
 * Pure: no database, no clock.
 */

/**
 * The journal lines a flow row sums, as SQL LIKE patterns. Wallet lines, plus the part of a charged-back card
 * load that WaPay absorbed (lib/ledger-core.js buildChargeback): that line stands where the wallet line would
 * have stood, so the whole load comes off money in, as it does for a refund.
 */
export const FLOW_LINE_PATTERNS = Object.freeze(['WALLET:%', 'EXPENSE:CHARGEBACK:%']);

/** Which flow a journal entry source belongs to (see the builders in lib/ledger-core.js). */
export function flowBucket(source) {
  if (!source) return 'other';
  if (source.startsWith('LOAD_')) return 'in';
  if (source.startsWith('SPEND_') || source.startsWith('VOUCHER_GIFT_')) return 'spend';
  if (source === 'P2P_SEND') return 'transfer';
  if (source.startsWith('CASHOUT')) return 'out';
  return 'other';
}

const toNumber = (v) => (typeof v === 'bigint' ? Number(v) : Number(v || 0));

/**
 * What one aggregated row moved, signed.
 *
 * Money in is what the lines were credited; every other flow is what they were debited. A REVERSAL_<X> entry is
 * the mirror of its original, so its amount sits in the opposite column, and it comes off the flow of X.
 *
 * @param {{ source: string|null, credit: number|bigint|null, debit: number|bigint|null }} row
 * @returns {{ bucket: 'in'|'spend'|'transfer'|'out'|'other', cents: number }}
 */
export function flowOfRow(row) {
  let source = String(row?.source || '');
  const reversal = source.startsWith('REVERSAL_');
  if (reversal) source = source.slice('REVERSAL_'.length);
  const bucket = flowBucket(source);
  if (bucket === 'other') return { bucket, cents: 0 };
  const credit = toNumber(row.credit);
  const debit = toNumber(row.debit);
  const creditSide = bucket === 'in';
  if (reversal) return { bucket, cents: -(creditSide ? debit : credit) };
  return { bucket, cents: creditSide ? credit : debit };
}
