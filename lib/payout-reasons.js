/**
 * Why a withdrawal did not go through, as data (BUGLOG #146, the 28 October incident; incident Build rule 5).
 *
 * OTT answers a pay-out with a status code (PerformPayout, the webhook, GetPaymentStatus) and a message. Until
 * now the code was kept on the row and the customer was told "could not be completed by the bank rail" whatever
 * it said. Every failure reason the customer hears comes from this table: one row per cause, a reason in plain
 * words, the next step, and who was at fault (the fee on the next withdrawal is waived unless it was the
 * customer). A code that no row names is UNKNOWN: the customer hears the honest generic line and ops is alerted.
 *
 * A row matches by OTT status code (`codes`), by our own outcome name (`outcomes`, as railAndSettle,
 * finalisePayout, reconcileInitPayout and rejectPayout record it) or by an outcome prefix. `refine` narrows a
 * matched row by the rail's message (the bank's own words behind a 97, when OTT passes them on). The customer
 * copy names no partner and promises no time (docs/GOLDEN_THREAD.md 4.4). Pure.
 */

/** The next step a reason points to, as the words that work in the chat. */
export const NEXT_STEPS = Object.freeze({
  CHECK_DETAILS: 'Check the details you typed (the account number and the bank, or the cellphone number), then say *withdraw* to try again.',
  CHECK_ACCOUNT: 'Check the account number and the bank, then say *withdraw* to try again.',
  CHECK_MOBILE: 'Check the cellphone number, then say *withdraw* to try again.',
  CHECK_NAME: 'The name must match the bank account exactly. Say *withdraw* to try again with the name as your bank has it.',
  CHECK_ID: 'Check the ID or passport number, then say *withdraw* to try again.',
  SMALLER: 'Say *withdraw* to try again with a smaller amount.',
  TRY_LATER: 'Say *withdraw* to try again a little later.',
  RETRY: 'Say *withdraw* to try again.',
  NONE: '',
});

/**
 * Who caused it: CUSTOMER (details typed wrong), BANK (the bank side), OURS (WaPay or its partner), UNKNOWN.
 * `kept: true` marks a failure before any money moved (nothing left the balance, so nothing "came back").
 */
export const PAYOUT_REASONS = Object.freeze([
  // Our own outcomes first: they say more than the code beside them.
  { key: 'FLOAT_SHORT', outcomes: ['FLOAT_SHORT'], reason: 'of a problem on our side, not with your bank', next: 'TRY_LATER', fault: 'OURS', kept: true },
  { key: 'NOT_APPROVED', outcomes: ['REJECTED'], reason: 'it was not approved by WaPay', next: 'NONE', fault: 'OURS', waiveFee: false },
  { key: 'CANCELLED', outcomes: ['CANCELLED_BY_CUSTOMER'], reason: 'you cancelled it', next: 'NONE', fault: 'CUSTOMER' },
  { key: 'NO_BALANCE', outcomes: ['INSUFFICIENT_FUNDS'], reason: 'your balance no longer covered it', next: 'NONE', fault: 'CUSTOMER', kept: true },
  { key: 'NEVER_SENT', outcomePrefixes: ['INIT_ABANDONED_'], reason: 'of a problem on our side, not with your bank', next: 'RETRY', fault: 'OURS' },
  { key: 'REQUEST_UNREADABLE', outcomes: ['REQUEST_INVALID'], reason: 'of a problem on our side, not with your bank', next: 'TRY_LATER', fault: 'OURS' },
  // OTT's status codes (docs/OTT_PAYOUT_API.md §5, lib/ott-payout.js classifyPayoutStatus).
  { key: 'OUR_SETUP', codes: ['-1', '1', '2'], outcomes: ['AUTH_ERROR', 'INVALID_LOGON', 'INVALID_HASH'], reason: 'of a problem on our side, not with your bank', next: 'TRY_LATER', fault: 'OURS' },
  { key: 'SERVICE_REFUSED', codes: ['0'], outcomes: ['PAYOUT_REJECTED'], reason: 'of a problem on our side: it was turned down before it reached your bank', next: 'TRY_LATER', fault: 'OURS' },
  { key: 'MOBILE_REJECTED', codes: ['4'], outcomes: ['INVALID_MOBILE'], reason: 'the cellphone number was not accepted', next: 'CHECK_MOBILE', fault: 'CUSTOMER' },
  { key: 'DETAILS_REJECTED', codes: ['9'], outcomes: ['DATA_VALIDATION'], reason: 'some of the details were not accepted', next: 'CHECK_DETAILS', fault: 'CUSTOMER' },
  { key: 'ID_REJECTED', codes: ['10', '11'], outcomes: ['ID_VALIDATION'], reason: 'the ID or passport number was not accepted', next: 'CHECK_ID', fault: 'CUSTOMER' },
  { key: 'OVER_LIMIT', codes: ['12'], outcomes: ['LIMIT_ERROR'], reason: 'the amount is over a limit for this kind of withdrawal', next: 'SMALLER', fault: 'CUSTOMER' },
  {
    key: 'BANK_DID_NOT_COMPLETE',
    codes: ['97'],
    outcomes: ['PROVIDER_FAILURE'],
    reason: "the bank's payment system did not complete it",
    next: 'TRY_LATER',
    fault: 'BANK',
    // The bank's own words, when OTT passes them on after "Fail at Provider".
    refine: [
      { key: 'NAME_MISMATCH', pattern: /\bname\b|holder|mismatch/i, reason: 'the name did not match the bank account', next: 'CHECK_NAME', fault: 'CUSTOMER' },
      { key: 'ACCOUNT_NOT_VALID', pattern: /\baccount\b.{0,30}\b(?:invalid|closed|not found|does not exist|inactive|dormant|blocked)\b|\binvalid account\b|\bclosed account\b/i, reason: 'the bank says that account is not valid or not open', next: 'CHECK_ACCOUNT', fault: 'CUSTOMER' },
      { key: 'BANK_UNAVAILABLE', pattern: /time ?out|timed out|unavailable|offline|not available|not reachable|unreachable|try again/i, reason: 'your bank could not be reached', next: 'TRY_LATER', fault: 'BANK' },
      { key: 'OVER_LIMIT', pattern: /\blimit\b|exceed/i, reason: 'the amount is over a limit your bank allows', next: 'SMALLER', fault: 'CUSTOMER' },
    ],
  },
]);

const UNKNOWN = Object.freeze({ key: 'UNKNOWN', reason: 'the bank did not complete it', next: 'TRY_LATER', fault: 'UNKNOWN' });

/** The OTT status code a row or an outcome carries: providerStatus first, then "PROVIDER_97" or "INIT_ABANDONED_0". */
export function statusCodeOf({ providerStatus = null, outcome = null } = {}) {
  // The final outcome's code first: a row that sat at 98/99 and then failed keeps the old 98/99 as its
  // providerStatus, and the push and the lookup must give the same reason (review 2026-10-29).
  const m = String(outcome || '').match(/^(?:PROVIDER|INIT_ABANDONED)_(-?\d+)$/);
  if (m) return m[1];
  if (providerStatus != null && String(providerStatus).trim() !== '') return String(providerStatus).trim();
  return null;
}

/**
 * The reason for one failed withdrawal.
 * @param {{ providerStatus?: string|number|null, outcome?: string|null, message?: string|null }} p
 * @returns {{ key: string, reason: string, next: string, nextText: string, fault: string, waiveFee: boolean, known: boolean, code: string|null }}
 */
export function payoutReason({ providerStatus = null, outcome = null, message = null } = {}) {
  const code = statusCodeOf({ providerStatus, outcome });
  const name = String(outcome || '');
  const byOutcome = PAYOUT_REASONS.find((r) => (r.outcomes || []).includes(name) || (r.outcomePrefixes || []).some((p) => name.startsWith(p)));
  const row = (byOutcome && !byOutcome.codes) ? byOutcome : PAYOUT_REASONS.find((r) => code != null && (r.codes || []).includes(code)) || byOutcome || null;
  let hit = row ? { ...row, known: true } : { ...UNKNOWN, known: false };
  const text = String(message || '');
  if (row?.refine && text) {
    const sub = row.refine.find((x) => x.pattern.test(text));
    if (sub) hit = { ...hit, key: sub.key, reason: sub.reason, next: sub.next, fault: sub.fault };
  }
  const { codes, outcomes, outcomePrefixes, refine, ...out } = hit;
  return { ...out, code, kept: !!out.kept, nextText: NEXT_STEPS[out.next] ?? '', waiveFee: out.waiveFee ?? out.fault !== 'CUSTOMER' };
}
