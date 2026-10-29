/**
 * "Nothing is coming in to my bank account" (BUGLOG #145, the 28 October incident).
 *
 * At 22:13 the customer wrote that sentence and got the PayShap withdraw opener: matchWithdrawAsk reads "to my
 * bank" as a withdraw word, and in the processor it runs before the status lookup. A complaint that money did
 * not arrive, or a question about whether a withdrawal went through, is about money that already moved: it is
 * answered from the ledger and the pay-out rows (lib/payout-status-copy.js missingMoneyReply), never with a menu
 * and never by a model (constitution invariant 7).
 *
 * Three deterministic asks, checked in the processor before the Pay agent and before the withdraw matcher:
 *   matchMissingMoney     a complaint ("nothing came in", "I didn't receive my money", "my withdrawal failed")
 *                         or a withdrawal status question ("did my withdrawal go through", "where is my money")
 *   matchCancelWithdrawal "cancel my withdrawal" (only a withdrawal still waiting for approval can be cancelled)
 *   matchPersonAsk        "person", "talk to a person", "speak to someone" (an ops alert, or the support contact)
 * Pure.
 */
import { matchDepositStatusRequest } from './deposits.js';

const norm = (text) => String(text || '').replace(/[‘’`]/g, "'").replace(/\s+/g, ' ').trim();

// "not / nothing / never / haven't / didn't … come in / arrive / receive / reflect / get / show / reach / land"
const NEGATION = /\b(?:nothing|not|no|never|nt|haven'?t|havent|hasn'?t|hasnt|didn'?t|didnt|did not|has not|have not|is not|isn'?t|isnt|was not|wasn'?t|still not|not yet|yet to|no sign of)\b/i;
const ARRIVAL = /\b(?:com(?:e|es|ing)\s+(?:in|through)|came\s+(?:in|through)|arriv\w*|receiv\w*|recieve\w*|reciev\w*|got\s+(?:it|my|the|any|anything|money|nothing|paid)|get(?:ting)?\s+(?:it|my|the|any|anything|money|paid)|reflect\w*|show(?:ed|ing|n|s)?\s+(?:up|in)|reach\w*|land\w*|gone\s+through|go(?:ne)?\s+through|went\s+through|been\s+paid|paid\s+(?:in|out|into))\b/i;
const MONEY = /\b(?:money|cash|funds?|payment|withdraw\w*|pay-?outs?|cash-?outs?|bank|account|capitec|fnb|absa|nedbank|standard bank|tyme\w*|discovery|african bank|payshap|deposit\w*|balance|r\s?\d+)\b/i;
// "I don't have / haven't got a bank account" is about having no account, never a complaint.
const NO_ACCOUNT = /\b(?:haven'?t|have not|don'?t|do not|never)\s+(?:got\s+|had\s+|have\s+)?(?:a|any)\s+(?:bank\s+)?account\b/i;
// A question or a failure statement about a withdrawal, or the money, with no negation needed.
const DIRECT = [
  // A bare "status": the waiting-for-approval message tells the customer to ask exactly that (CHANGELOG 129).
  /^\W*(?:check\s+(?:my\s+)?)?(?:my\s+)?status\W*(?:please|pls)?\W*$/i,
  /\bwh?ere(?:'?s|\s+is|\s+are)\s+(?:my|the)\s+(?:money|cash|funds?|withdrawals?|pay-?outs?|payments?|r\s?\d+)\b/i,
  /\bwhat\s+happened\s+(?:to|with)\s+(?:my|the)\s+(?:money|cash|funds?|withdrawals?|pay-?outs?|payments?|r\s?\d+)\b/i,
  /\bwhy\s+(?:did|has|was|is)\s+(?:my|the)\s+(?:withdrawals?|pay-?outs?|payments?|money|cash-?outs?)\b.{0,30}\b(?:fail\w*|declin\w*|reject\w*|cancel\w*|not|come back|returned|bounc\w*|reversed)\b/i,
  /\b(?:my|the)\s+(?:withdrawals?|pay-?outs?|cash-?outs?)\s+(?:has\s+|have\s+|was\s+|is\s+|got\s+|been\s+)*(?:fail\w*|declin\w*|reject\w*|bounc\w*|reversed|came back|returned)\b/i,
  // "nothing in my Capitec yet", "still nothing in my account"
  /\b(?:nothing|no money|still nothing)\s+(?:is\s+)?(?:in|into|at)\s+(?:my|the)\s+(?:bank|account|capitec|fnb|absa|nedbank|standard bank|tyme\w*|discovery|african bank)\b/i,
  /\b(?:withdrawals?|pay-?outs?|cash-?outs?)\s+(?:did\s*n'?o?t|did not|didnt|has not|hasn'?t|was not|wasn'?t)\s+(?:go|gone|went|come|work)\b/i,
];
// A withdrawal status question the deposit-status matcher already knows ("did my withdrawal go through").
const PAYOUT_WORDS = /\b(?:withdraw\w*|pay-?outs?|cash-?outs?|bank|account|capitec|fnb|absa|nedbank|standard bank|tyme\w*|payshap|atm|e-?wallet|cash ?send)\b/i;
const DEPOSIT_WORDS = /\b(?:deposit\w*|card|payfast|top-?up|topped up|loaded?|apple pay|google pay|eft|voucher|link)\b/i;

/** True for a complaint that money did not arrive, or a question about a withdrawal that already moved. */
export function matchMissingMoney(text) {
  const t = norm(text);
  if (!t || t.length > 200) return false;
  if (NO_ACCOUNT.test(t)) return false;
  if (DIRECT.some((re) => re.test(t))) return true;
  if (NEGATION.test(t) && ARRIVAL.test(t) && MONEY.test(t)) return true;
  // "did my withdrawal go through", "has my payout arrived", "withdrawal status": the existing status shapes,
  // when they are about a withdrawal or a bank (a bare deposit question stays with the deposit lookup).
  return matchDepositStatusRequest(t) && PAYOUT_WORDS.test(t) && !DEPOSIT_WORDS.test(t);
}

/** The words point at money coming IN (a card top-up, a link, a voucher), not at a withdrawal. */
export function namesDeposit(text) {
  return DEPOSIT_WORDS.test(norm(text)) && !/\bwithdraw\w*|pay-?outs?|cash-?outs?\b/i.test(norm(text));
}

/** The words point at a bank or a withdrawal. */
export function namesBankOrWithdrawal(text) {
  return PAYOUT_WORDS.test(norm(text));
}

/** "cancel my withdrawal", "stop the withdrawal", "cancel the pay-out", "I don't want the withdrawal anymore". */
export function matchCancelWithdrawal(text) {
  const t = norm(text);
  if (!t || t.length > 120) return false;
  return /\b(?:cancel|stop|undo|reverse|call off)\b.{0,20}\b(?:withdrawals?|pay-?outs?|cash-?outs?)\b/i.test(t)
    || /\bdon'?t\s+want\s+(?:the|my|that)\s+(?:withdrawals?|pay-?outs?)\b/i.test(t);
}

/** "person", "a person please", "talk to a person", "speak to someone", "I want a human", "customer support". */
export function matchPersonAsk(text) {
  const t = norm(text).toLowerCase();
  if (!t || t.length > 120) return false;
  if (/^\W*(?:a\s+)?(?:person|human|real person|agent|consultant|support|customer (?:care|service|support))\W*(?:please|pls|plz)?\W*$/.test(t)) return true;
  return /\b(?:talk|speak|chat)\s+(?:to|with)\s+(?:a|an|the|someone|somebody|some one)?\s*(?:real\s+)?(?:person|human|someone|somebody|agent|consultant|staff|support|manager|team|people)\b/.test(t)
    || /\b(?:i\s+(?:want|need)|get\s+me|can\s+i\s+(?:get|have))\s+(?:a|an|to\s+(?:talk|speak)\s+to\s+a)?\s*(?:real\s+)?(?:person|human|agent|consultant)\b/.test(t);
}
