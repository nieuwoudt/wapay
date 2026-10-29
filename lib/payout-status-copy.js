/**
 * Withdrawal status in one vocabulary (BUGLOG #148, the 28 October incident; incident Build rule 4).
 *
 * On 28 October a customer read "✅ … approved and has been handed to the bank rail" and "❌ … could not be
 * completed by the bank rail" in the same minute, about an R100 she did not recognise, and "Nothing is coming
 * in to my bank account" got the withdraw menu. Five places wrote withdrawal status and each said it its own
 * way. Every withdrawal status a customer reads is now built here, from the pay-out row's state:
 *
 *   ⏳ waiting for approval   AWAITING_APPROVAL, REJECTING   (a person at WaPay checks it; nothing has left)
 *   ⏳ on its way             INIT, PENDING                  (with the bank; the money is set aside)
 *   ⏳ being checked          NEEDS_OPERATOR                 (an anomaly a person resolves; never "on its way")
 *   ✅ paid                   SUCCESS                        (the bank confirmed it; only then a ✅)
 *   ❌ didn't go through      FAILED                         (the reason from lib/payout-reasons.js, money back)
 *   ↩️ cancelled              FAILED + CANCELLED_BY_CUSTOMER
 *
 * The customer word is "withdrawal". No "bank rail", no partner named, no time promise
 * (docs/GOLDEN_THREAD.md 4.4), no em dash. Amounts are integer cents. The paid message with its collection
 * steps stays in lib/payouts.js payoutOutcomeMessage, which calls failedCopy for a failure. Pure.
 */
import { payoutReason } from './payout-reasons.js';

/**
 * Pay-out row statuses still in flight: one of these at a time per account (BUGLOG #147). NEEDS_OPERATOR is not
 * one of them: nothing moves such a row on but a person, often it holds nothing, and counting it would block the
 * customer (and the operator's own make-whole pay-out) for good (review 2026-10-29).
 */
export const OPEN_PAYOUT_STATUSES = Object.freeze(['INIT', 'AWAITING_APPROVAL', 'PENDING', 'REJECTING']);

const R = (c) => `R${(Number(c || 0) / 100).toFixed(2).replace(/\.00$/, '')}`;
const BANK_METHODS = ['PAYSHAP', 'RTC'];
const METHOD_PHRASE = { PAYSHAP: 'by PayShap', RTC: 'by bank transfer', CASHSEND: 'as cash at an Absa ATM', NEDCASH: 'as cash at a Nedbank ATM', EWALLET: 'to an FNB eWallet' };
export const PERSON_LINE = 'Reply *person* to talk to someone from WaPay.';

/** Which of the five the customer is in. */
export function payoutPhase(p = {}) {
  const s = String(p.status || '');
  if (s === 'AWAITING_APPROVAL' || s === 'REJECTING') return 'APPROVAL';
  if (s === 'INIT' || s === 'PENDING') return 'ON_ITS_WAY';
  if (s === 'NEEDS_OPERATOR') return 'CHECKING';
  if (s === 'SUCCESS' || s === 'SETTLED') return 'PAID';
  if (p.outcome === 'CANCELLED_BY_CUSTOMER') return 'CANCELLED';
  return 'FAILED';
}
export const isOpenPayout = (p) => OPEN_PAYOUT_STATUSES.includes(String(p?.status || ''));

const isBank = (method) => BANK_METHODS.includes(method);
/** The rail really has it (a 98/99 or a webhook-pending), not a timeout or an unreadable answer (BUGLOG #82). */
export function railHasIt(outcome) {
  const o = String(outcome || '');
  return o !== '' && o !== 'TRANSPORT_INDETERMINATE' && o !== 'UNKNOWN' && !o.startsWith('HTTP_');
}
/** "when your bank confirms it" for a bank, "when it is paid" for cash (the code comes by SMS). */
const whenDone = (p) => (isBank(p.method) ? 'when your bank confirms it' : 'when it is paid and the code is sent');
const methodPhrase = (method) => METHOD_PHRASE[method] || '';
/** "your Capitec account •••918", "your bank account •••918", "cellphone •••1175". The masked record only. */
export function destinationOf(p = {}) {
  const r = p.recipient || {};
  if (isBank(p.method)) {
    const bank = r.bank ? String(r.bank).trim() : '';
    return `your ${bank ? `${bank} ` : 'bank '}account${r.account ? ` ${r.account}` : ''}`;
  }
  return r.mobile ? `cellphone ${r.mobile}` : 'your cellphone';
}
const toWhere = (p) => (isBank(p.method) ? `to ${destinationOf(p)}` : `with the code to ${destinationOf(p)}`);
/** "The R100 and the R16 fee" (plural) or "The R100" (singular), with the verb that agrees. */
const amountAndFee = (p) => (Number.isInteger(p.feeCents) ? `The ${R(p.amountCents)} and the ${R(p.feeCents)} fee` : `The ${R(p.amountCents)}`);
const areBack = (p) => `${amountAndFee(p)} ${Number.isInteger(p.feeCents) ? 'are' : 'is'} back in your WaPay balance`;
/** A failure where nothing ever left the balance (no money, an empty float) says that, never "came back". */
const moneyAfter = (p, why) => (why.kept ? 'Nothing left your WaPay balance for it' : areBack(p));
const comeBack = (p) => `${amountAndFee(p).replace(/^The/, 'the')} ${Number.isInteger(p.feeCents) ? 'come' : 'comes'} straight back to your balance`;
const setAside = (p) => R(Number(p.amountCents || 0) + Number(p.feeCents || 0));
const ref = (p) => (p.reference ? ` (reference ${p.reference})` : '');

/** "today at 21:40", "yesterday at 18:05", "on 25 Oct at 18:05", in SAST. */
export function whenAt(at, now = new Date()) {
  if (!at) return '';
  const sast = (d) => new Date(new Date(d).getTime() + 2 * 60 * 60 * 1000);
  const a = sast(at); const n = sast(now);
  const day = (d) => Math.floor(d.getTime() / 86400000);
  const clock = `${String(a.getUTCHours()).padStart(2, '0')}:${String(a.getUTCMinutes()).padStart(2, '0')}`;
  const diff = day(n) - day(a);
  if (diff <= 0) return `today at ${clock}`;
  if (diff === 1) return `yesterday at ${clock}`;
  return `on ${a.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][a.getUTCMonth()]} at ${clock}`;
}

/** "💰 Balance: R420." or "💰 Balance: R360: R244 available and R116 set aside for your withdrawal." */
export function balanceLine({ availableCents = 0, heldCents = 0 } = {}) {
  const held = Number(heldCents) || 0;
  const avail = Number(availableCents) || 0;
  if (held <= 0) return `💰 Balance: ${R(avail)}.`;
  return `💰 Balance: ${R(avail + held)}: ${R(avail)} available and ${R(held)} set aside for something in progress.`;
}

/** The reason for a failed row, and the words that go with it. */
export function reasonFor(p = {}) {
  return payoutReason({ providerStatus: p.providerStatus ?? null, outcome: p.outcome ?? null, message: p.message ?? p.lastMessage ?? null });
}

/**
 * The rail has it (PENDING after PerformPayout, or after the founder's approval).
 * "⏳ *On its way.* Your R100 withdrawal by PayShap is on its way to your Capitec account •••918 …"
 */
export function onItsWayCopy(out = {}, { approved = false } = {}) {
  // Approved, but the bank's answer timed out or could not be read: nobody has confirmed it has it (BUGLOG #82).
  if (approved && !railHasIt(out.outcome)) {
    return `⏳ *Approved.* I could not get confirmation from your bank just now, so I am checking on it${ref(out)}. ${amountAndFee(out)} ${Number.isInteger(out.feeCents) ? 'stay' : 'stays'} set aside, and I'll message you here either way.`;
  }
  const lead = approved ? '⏳ *Approved and on its way.*' : '⏳ *On its way.*';
  const where = isBank(out.method) ? `on its way to ${destinationOf(out)}` : `being sent, and the collection code goes to ${destinationOf(out)}`;
  const tell = `I'll message you here ${whenDone(out)}.`;
  return `${lead} Your ${R(out.amountCents)} withdrawal ${methodPhrase(out.method)} is ${where}${ref(out)}. ${tell} If it does not go through, ${comeBack(out)}.`;
}

/**
 * A finished failure, with the reason, where the money is, the balance when known, and the next step.
 * "❌ *Didn't go through.* Your R100 withdrawal by PayShap didn't reach your Capitec account •••918, because …"
 */
export function failedCopy(out = {}, { balanceCents = null } = {}) {
  const why = reasonFor(out);
  if (why.key === 'CANCELLED') return cancelledCopy(out, { balanceCents });
  const where = isBank(out.method) ? `didn't reach ${destinationOf(out)}` : "didn't go through";
  const bal = Number.isInteger(balanceCents) ? `, so you have ${R(balanceCents)} available now` : '';
  const next = [why.nextText, PERSON_LINE].filter(Boolean).join(' ');
  return `❌ *Didn't go through.* Your ${R(out.amountCents)} withdrawal ${methodPhrase(out.method)} ${where}, because ${why.reason}. ${moneyAfter(out, why)}${bal}. ${next}${out.reference ? ` (Reference ${out.reference}.)` : ''}`;
}

/** The customer cancelled a withdrawal that was still waiting for approval. */
export function cancelledCopy(out = {}, { balanceCents = null } = {}) {
  const bal = Number.isInteger(balanceCents) ? `, so you have ${R(balanceCents)} available now` : '';
  return `↩️ *Cancelled.* Your ${R(out.amountCents)} withdrawal ${methodPhrase(out.method)}${ref(out)} will not be sent. ${areBack(out)}${bal}.`;
}

/** One withdrawal as one line of a list: what, where, when, its state in plain words, and where the money is. */
export function payoutLine(p = {}, { now = new Date() } = {}) {
  const phase = payoutPhase(p);
  const head = `${R(p.amountCents)} ${methodPhrase(p.method)} ${toWhere(p)}`.replace(/\s+/g, ' ').trim();
  const at = whenAt(phase === 'PAID' || phase === 'FAILED' || phase === 'CANCELLED' ? p.finalisedAt || p.createdAt : p.createdAt, now);
  const tail = p.reference ? ` (${p.reference})` : '';
  if (phase === 'APPROVAL') return `⏳ ${head}, ${at}: waiting for approval. A person at WaPay checks every withdrawal before it goes. ${setAside(p)} is set aside for it and nothing has left WaPay.${tail}`;
  if (phase === 'ON_ITS_WAY') {
    const checked = p.checked === true ? ' I checked just now: your bank has not confirmed it yet.' : p.checked === false ? ' I could not check with your bank this second, so I will keep checking.' : '';
    return `⏳ ${head}, ${at}: on its way. ${setAside(p)} is set aside for it, not lost.${checked} I'll message you here ${whenDone(p)}, and if it does not go through the money comes straight back to your balance.${tail}`;
  }
  if (phase === 'CHECKING') return `⏳ ${head}, ${at}: a person at WaPay is checking this one with the bank. If it did not go through, the money comes back to your balance. ${PERSON_LINE}${tail}`;
  if (phase === 'PAID') return `✅ ${head}, ${at}: paid.${isBank(p.method) ? ' Your bank confirmed it.' : ' The collection code was sent by SMS.'}${tail}`;
  if (phase === 'CANCELLED') return `↩️ ${head}, ${at}: cancelled by you. ${amountAndFee(p)} came back to your balance.${tail}`;
  const why = reasonFor(p);
  return `❌ ${head}, ${at}: didn't go through, because ${why.reason}. ${why.kept ? 'Nothing left your balance for it.' : `${amountAndFee(p)} came back to your balance.`}${tail}`;
}

/**
 * The answer to "Nothing is coming in to my bank account", "did my withdrawal go through", "where is my money"
 * (BUGLOG #145): the newest withdrawals (at most three) with each one's state, whether anything is still on its
 * way, the balance with what is set aside, and the one next step that fits the newest.
 */
export function missingMoneyReply({ payouts = [], availableCents = 0, heldCents = 0, now = new Date() } = {}) {
  const rows = (payouts || []).slice(0, 3);
  const bal = balanceLine({ availableCents, heldCents });
  if (!rows.length) {
    return `🔎 I can't see a withdrawal from your WaPay balance in the last 7 days, so nothing is on its way to your bank from WaPay.\n\n${bal}\n\nSay *withdraw* to move money to your bank, or ${PERSON_LINE.charAt(0).toLowerCase()}${PERSON_LINE.slice(1)}`;
  }
  const lines = rows.map((p) => payoutLine(p, { now }));
  const open = rows.filter(isOpenPayout);
  const state = open.length ? '' : '\n\nNothing else is on its way from your WaPay balance right now.';
  const newest = rows[0];
  const phase = payoutPhase(newest);
  let next;
  if (phase === 'APPROVAL') next = `Say *cancel withdrawal* to cancel it and have ${setAside(newest)} back in your balance, or wait and I'll message you here. ${PERSON_LINE}`;
  else if (phase === 'FAILED') next = [reasonFor(newest).nextText, PERSON_LINE].filter(Boolean).join(' ');
  else if (phase === 'PAID') next = `${isBank(newest.method) ? "✅ means your bank confirmed the payment: it shows in your bank's own app or SMS." : '✅ means it was paid: the collection code came by SMS.'} ${PERSON_LINE}`;
  else next = PERSON_LINE;
  return `🔎 I checked your withdrawals:\n\n${lines.join('\n\n')}${state}\n\n${bal}\n\n${next}`;
}

/** A withdrawal is already open (BUGLOG #147): what it is, that one at a time is the rule, and what they can do. */
export function openPayoutCopy(open = {}, { availableCents = null, heldCents = null } = {}) {
  const phase = payoutPhase(open);
  const what = `${R(open.amountCents)} ${methodPhrase(open.method)} ${toWhere(open)}${ref(open)}`.replace(/\s+/g, ' ');
  const bal = Number.isInteger(availableCents) ? `\n\n${balanceLine({ availableCents, heldCents: Number.isInteger(heldCents) ? heldCents : 0 })}` : '';
  if (phase === 'APPROVAL') {
    return `⏳ You already have a withdrawal waiting for approval: ${what}. ${setAside(open)} is set aside for it. One withdrawal at a time, so a new one can start once this one is done. Say *cancel withdrawal* to cancel it and have the ${setAside(open)} back in your balance, or wait and I'll message you here.${bal}`;
  }
  return `⏳ You already have a withdrawal on its way: ${what}. ${setAside(open)} is set aside for it. One withdrawal at a time, so a new one can start once this one is paid, or once it comes back to your balance. I'll message you here either way.${bal}`;
}

/** "cancel withdrawal" with nothing waiting, or with one the bank already has. */
export function cannotCancelCopy(open = null) {
  if (!open) return `There is no withdrawal waiting to cancel. Say *did my withdrawal go through* to see your recent withdrawals.`;
  return `⏳ Your ${R(open.amountCents)} withdrawal ${methodPhrase(open.method)}${ref(open)} has already been approved and sent, so it can't be cancelled now. If it does not go through, the money comes straight back to your balance, and I'll message you here either way.`;
}

/** "person" / "talk to a person": a person was asked (the alert went), or the contact, or the honest fallback. */
export function personAskedCopy({ alerted = false, contact = '' } = {}) {
  if (alerted === 'EARLIER') return '🙋 I asked a person from the WaPay team to look at your account earlier today, and they will message you here.';
  if (alerted) return '🙋 I have asked a person from the WaPay team to look at your account and message you here.';
  if (String(contact || '').trim()) return `🙋 To talk to a person from the WaPay team, WhatsApp ${String(contact).trim()}.`;
  return '🙋 I could not reach the WaPay team just now. Please send *person* again in a little while. Meanwhile *did my withdrawal go through* shows your recent withdrawals.';
}
