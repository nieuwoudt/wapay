/**
 * What the customer does once a withdrawal is paid: where the code arrives
 * and how to collect, per method. Pure strings, shared by the chat flow
 * (lib/payout-chat.js, right after "Done"), the finalisers (lib/payouts.js
 * payoutOutcomeMessage, for a pay-out that settled later) and the knowledge
 * base (lib/how-it-works.js). One source, so the three never drift.
 *
 * Founder 2026-10-04: the SMS the rail sends is not ours and carried an empty
 * code on the sandbox, so the chat itself must say where the code arrives
 * and what to do with it. Founder 2026-10-08 (first production run): Absa
 * sends TWO SMSes (a 10-digit reference and a 6-digit PIN); write the steps
 * as a numbered list and offer to guide step by step. Customer copy rules:
 * no em dashes, no partner named, no time promised.
 */

const maskMobile = (m) => {
  const d = String(m ?? '').replace(/\D/g, '');
  return d.length >= 3 ? `•••${d.slice(-3)}` : 'the number you gave';
};
const ASK = `If anything is unclear, just ask and I will guide you step by step.`;

/** Where the money or the code arrives, in one line. `mobile` may be full or already masked. */
export function arrivalLine(method, mobile = null) {
  const to = mobile ? maskMobile(mobile) : 'the cellphone number you gave';
  if (method === 'PAYSHAP' || method === 'RTC') return `🏦 It goes straight into your bank account. Your bank's own app or SMS will show the credit; there is nothing to collect.`;
  if (method === 'NEDCASH') return `📲 The withdrawal code is sent by SMS to ${to}.`;
  if (method === 'EWALLET') return `📲 The eWallet code is sent by SMS to ${to}.`;
  if (method === 'CASHSEND') return `📲 The collection code is sent by SMS to ${to}. You will get two SMSes from Absa: one with a 10-digit reference and one with a 6-digit PIN.`;
  return `📲 The code is sent by SMS to ${to}.`;
}

/** The steps at the ATM or till, as a numbered list. The SMS carries the exact codes. */
export function collectionSteps(method) {
  if (method === 'CASHSEND') {
    return [
      `Collecting at Absa:`,
      `1️⃣ Go to any Absa ATM, or a Pick n Pay or Boxer till.`,
      `2️⃣ Choose *CashSend*.`,
      `3️⃣ Enter the cellphone number that received the SMSes.`,
      `4️⃣ Enter the 10-digit reference from the first SMS, then the 6-digit PIN from the second.`,
      `5️⃣ Take your cash. No card needed.`,
      `The cash stays collectable for 30 days. ${ASK}`,
    ].join('\n');
  }
  if (method === 'NEDCASH') {
    return [
      `Collecting at Nedbank:`,
      `1️⃣ Go to any Nedbank ATM.`,
      `2️⃣ Choose *Cardless services*.`,
      `3️⃣ Enter the cellphone number that received the SMS.`,
      `4️⃣ Enter the withdrawal code from the SMS (and the PIN, if the SMS gives one).`,
      `5️⃣ Take your cash. No card needed.`,
      ASK,
    ].join('\n');
  }
  if (method === 'EWALLET') {
    return [
      `Collecting your eWallet:`,
      `1️⃣ Go to any FNB ATM.`,
      `2️⃣ Choose *Cardless services* then *eWallet*.`,
      `3️⃣ Enter the cellphone number that received the SMS.`,
      `4️⃣ Enter the ATM PIN from the SMS and choose the amount.`,
      `5️⃣ Take your cash. No card or bank account needed.`,
      ASK,
    ].join('\n');
  }
  if (method === 'PAYSHAP' || method === 'RTC') return `PayShap lands directly in your bank account; there is nothing to collect.`;
  return [
    `Collecting cash: the SMS tells you exactly which codes to enter.`,
    `1️⃣ At an Absa ATM choose *CashSend*; at a Nedbank ATM choose *Cardless services*; at an FNB ATM choose *Cardless services* then *eWallet*.`,
    `2️⃣ Enter the cellphone number that received the SMS, then the codes from the SMS.`,
    `3️⃣ Take your cash. No card needed.`,
    ASK,
  ].join('\n');
}

/** Both parts for a paid withdrawal: where it arrives, then how to collect (cash methods only get the steps). */
export function collectionInstructions(method, mobile = null) {
  const arrive = arrivalLine(method, mobile);
  if (method === 'PAYSHAP' || method === 'RTC') return arrive;
  return `${arrive}\n\n${collectionSteps(method)}\n\nIf the SMS does not arrive, message me here with your reference and I will check.`;
}
