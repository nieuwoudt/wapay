/**
 * The withdraw gate for a balance that cannot cover the smallest withdrawal
 * (founder 2026-10-12, the Lisa case). She had R0 to spend, a R350 voucher
 * from the founder delivered that evening and an unpaid R367 link, and ten
 * plain requests to "put it in my bank account" got the same line: "💸
 * Withdrawals start at R50 plus the fee, so the smallest one needs R58, and
 * you have R0 available right now." Seven times in a row.
 *
 * Now the gate reads her situation (lib/money-situation.js) and answers in
 * tiers, counted from the replies she recently got (refs.gate on the stored
 * assistant turn, language-proof):
 *   0  the first time: her money first, where it is, then the minimum;
 *   1  the second time: the fuller picture as bullets and the two or three
 *      things she can do;
 *   2  the third time: a person (an ops alert is sent; the reply only says a
 *      person will message her when the alert actually went);
 *   3+ after that: a short reminder, naming the person only if one was
 *      really asked (refs.personAsked on an earlier reply, or now).
 * Pure except for the alert, which the caller passes in.
 */
import { situationSentences, whenSaid } from './money-situation.js';

export const SHORT_GATE = 'WITHDRAW_SHORT';
const R = (c) => `R${(c / 100).toFixed(2).replace(/\.00$/, '')}`;
const firstNameOf = (account) => String(account?.displayName || '').trim().split(/\s+/)[0] || '';

/**
 * @param {object} a
 * @param {object} a.account            the customer (display name for the greeting only)
 * @param {number} a.balanceCents       what the withdraw flow can use
 * @param {number} a.needCents          the smallest withdrawal plus its fee
 * @param {number} a.minCents           the smallest withdrawal
 * @param {string} a.cheapestLabel      the method that gives needCents ("PayShap")
 * @param {object|null} a.situation     moneySituation()
 * @param {number} a.repeats            gate replies already given recently (0, 1, 2, …)
 * @param {boolean} [a.personAsked]     an ops alert has actually gone out (now or on an earlier reply)
 * @param {Date} [a.now]
 * @returns {{ text: string, refs: { gate: string, tier: number } }}
 */
export function shortGateReply({ account, balanceCents, needCents, minCents, cheapestLabel = 'PayShap', situation = null, repeats = 0, personAsked = false, now = new Date() }) {
  const name = firstNameOf(account);
  const tier = Math.min(Math.max(0, repeats | 0), 3);
  const fee = needCents - minCents;
  const short = Math.max(0, needCents - balanceCents);
  const facts = situationSentences(situation, { now });
  const need = `A withdrawal needs at least ${R(needCents)} in your balance (the ${R(minCents)} minimum plus the ${R(fee)} ${cheapestLabel} fee)`;
  const refs = (t) => ({ gate: SHORT_GATE, tier: t, ...(personAsked ? { personAsked: true } : {}) });

  if (tier === 0) {
    const lead = balanceCents > 0
      ? `💸 You have ${R(balanceCents)} to withdraw. ${need}, so you need ${R(short)} more.`
      : `💸 You have R0 to withdraw.`;
    const body = facts.length ? ` ${facts.join(' ')}` : '';
    const tail = balanceCents > 0 ? ' Say *add money* to top up.' : ` ${need}. Say *add money* to top up.`;
    return { text: lead + body + tail, refs: refs(0) };
  }

  const gifts = (situation?.giftsReceived || []).filter((g) => !g.inBalance);
  const links = (situation?.pendingLinks || []).filter((l) => l.grossCents || l.amountCents);
  const held = (situation?.pendingPayouts || []).filter((p) => Number.isInteger(p.amountCents));
  const bullets = [`• Balance you can withdraw: *${R(balanceCents)}*`];
  for (const g of gifts.slice(0, 2)) bullets.push(`• The ${R(g.amountCents)}${g.fromName ? ` from ${g.fromName}` : ''} (${whenSaid(g.at, now).replace(/^on /, '')}): a voucher PIN, not balance`);
  for (const l of links.slice(0, 1)) bullets.push(`• Your ${R(l.grossCents || l.amountCents)} payment link: ${l.ageMinutes >= 15 ? 'not paid, nothing was taken' : 'no payment yet'}`);
  for (const p of held.slice(0, 1)) bullets.push(`• Held for your ${R(p.amountCents)} withdrawal${p.reference ? ` (${p.reference})` : ''}: ${R(p.amountCents + (p.feeCents || 0))}, until the bank confirms it`);
  const todo = [`Add money to your balance: say *add money* (card, bank or a cash voucher bought at a till)`];
  if (gifts.length) todo.push(`Use the voucher PIN${gifts.length === 1 ? '' : 's'} at a shop that takes WaPay vouchers`);
  todo.push(`Withdraw once your balance is ${R(needCents)} or more: say *withdraw*`);
  const noId = situation && !situation.identity?.kind ? '\n\nYou do not need a South African ID for a withdrawal: a passport or foreign ID works too.' : '';
  const picture = `${bullets.join('\n')}\n\nWhat you can do:\n${todo.map((x, i) => `${['1️⃣', '2️⃣', '3️⃣'][i]} ${x}`).join('\n')}`;

  if (tier === 1) {
    return { text: `Let me explain where your money is${name ? `, ${name}` : ''}:\n\n${picture}${noId}`, refs: refs(1) };
  }
  if (tier === 2) {
    if (personAsked) {
      return { text: `🙋 I can see this is not working for you${name ? `, ${name}` : ''}, so I have asked a person from the WaPay team to look at your account and message you here. Your money is safe.\n\n${picture}`, refs: refs(2) };
    }
    const contact = String(process.env.WAPAY_SUPPORT_WHATSAPP || '').trim();
    if (contact) return { text: `🙋 I can see this is not working for you${name ? `, ${name}` : ''}. To talk to a person from the WaPay team, WhatsApp ${contact}. Your money is safe.\n\n${picture}`, refs: refs(2) };
    return { text: `Here it is once more, step by step${name ? `, ${name}` : ''}:\n\n${picture}${noId}`, refs: refs(2) };
  }
  const reminder = `you have ${R(balanceCents)} to withdraw, and ${need.charAt(0).toLowerCase()}${need.slice(1)}. Say *add money* to top up.`;
  if (personAsked) return { text: `🙋 A person from the WaPay team has been asked to help you and will message you here. Until then: ${reminder}`, refs: refs(3) };
  const contact = String(process.env.WAPAY_SUPPORT_WHATSAPP || '').trim();
  if (contact) return { text: `🙋 To talk to a person from the WaPay team, WhatsApp ${contact}. In short: ${reminder}`, refs: refs(3) };
  const gift = gifts[0];
  return { text: `💸 In short: ${reminder}${gift ? ` The ${R(gift.amountCents)}${gift.fromName ? ` from ${gift.fromName}` : ''} is a voucher PIN, so it stays a voucher.` : ''}`, refs: refs(3) };
}

/** The ops e-mail for a customer who reached the third tier: references and masks only. */
export function stuckAlert({ account, balanceCents, needCents, situation, now = new Date() }) {
  const tail = String(account?.waId || account?.msisdn || '').replace(/\D/g, '').slice(-4);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const lines = situationSentences(situation, { now }).map((l) => `<li>${esc(l)}</li>`).join('');
  return {
    subject: `${firstNameOf(account) || 'A customer'} has asked to withdraw three times and cannot`,
    detailsHtml: `<p>Account <code>${esc(account?.id || '?')}</code>, WhatsApp •••${esc(tail)}, display name ${esc(firstNameOf(account) || '(none)')}.</p>`
      + `<p>Balance the withdraw flow can use: ${R(balanceCents)}; the smallest withdrawal needs ${R(needCents)}.</p>`
      + (lines ? `<ul>${lines}</ul>` : '')
      + `<p>The chat told them a person from the WaPay team will message them on WhatsApp. Reply from the business number, or credit them through a ledger entry if the money is theirs.</p>`,
  };
}

/**
 * "Send money" to the customer's own number (founder 2026-10-12, the Lisa
 * case: she meant "to my bank", typed her own number, and was offered a R350
 * voucher for R367). Sending to yourself is not a purchase: the reply says
 * so and names the two things they may have meant. The explicit
 * self-purchase ("buy an OTT voucher") never reaches this.
 */
export const SEND_TO_SELF_TEXT = '📵 That is your own number, so there is nobody to send it to. To move your WaPay money into your bank account, say *withdraw*. To buy a voucher for yourself, say *buy a voucher*.';

/**
 * A message that names a voucher the customer RECEIVED ("the voucher
 * Nieuwoudt sent me", "I got a R350 voucher") is a question about that
 * voucher, never a purchase. Pure.
 */
export const RECEIVED_VOUCHER_RE = /\b(?:received|got|get|was sent|been sent|sent me|gave me|given)\b[^.?!]{0,40}\bvouchers?\b|\bvouchers?\b[^.?!]{0,40}\b(?:received|i got|sent me|you sent|he sent|she sent|they sent|gave me|was sent)\b/i;
export function namesReceivedVoucher(text) {
  return RECEIVED_VOUCHER_RE.test(String(text || ''));
}

/** The answer about a received voucher, from the situation; null when the record shows none (the caller routes as before). */
export function receivedVoucherReply({ situation, now = new Date() } = {}) {
  const gifts = situation?.giftsReceived || [];
  if (!gifts.length) return null;
  const lines = gifts.slice(0, 2).map((g) => {
    const who = g.fromName ? ` ${g.fromName} sent you` : ' you received';
    return g.inBalance
      ? `🎁 The ${R(g.amountCents)}${who} ${whenSaid(g.at, now)} is in your WaPay balance: spend it here, or say *withdraw* to move it to your bank.`
      : `🎁 The ${R(g.amountCents)}${who} ${whenSaid(g.at, now)} is a voucher PIN (in that day's message). It is spent at shops that take WaPay vouchers; it is not part of your WaPay balance, so it cannot be sent on or withdrawn.`;
  });
  return `${lines.join('\n\n')}\n\nYour WaPay balance: ${R(situation?.availableCents || 0)}.`;
}
