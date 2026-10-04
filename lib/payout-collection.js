/**
 * What the customer does once a withdrawal is paid: where the code arrives
 * and how to collect, per method. Pure strings, shared by the chat flow
 * (lib/payout-chat.js, right after "Done"), the finalisers (lib/payouts.js
 * payoutOutcomeMessage, for a pay-out that settled later) and the knowledge
 * base (lib/how-it-works.js). One source, so the three never drift.
 *
 * Founder 2026-10-04: the SMS the rail sends is not ours and carried an empty
 * code on the sandbox, so the chat itself must say where the code arrives
 * and what to do with it. Generic enough to stay true: the SMS carries the
 * exact codes. Customer copy rules: no em dashes, no partner named, no time
 * promised.
 */

const maskMobile = (m) => {
  const d = String(m ?? '').replace(/\D/g, '');
  return d.length >= 3 ? `•••${d.slice(-3)}` : 'the number you gave';
};

/** Where the money or the code arrives, in one line. `mobile` may be full or already masked. */
export function arrivalLine(method, mobile = null) {
  const to = mobile ? maskMobile(mobile) : 'the cellphone number you gave';
  if (method === 'PAYSHAP' || method === 'RTC') return `🏦 It goes straight into your bank account. Your bank's own app or SMS will show the credit; there is nothing to collect.`;
  if (method === 'NEDCASH') return `📲 The withdrawal code is sent by SMS to ${to}.`;
  if (method === 'EWALLET') return `📲 The eWallet code is sent by SMS to ${to}.`;
  if (method === 'CASHSEND') return `📲 The collection code is sent by SMS to ${to}.`;
  return `📲 The code is sent by SMS to ${to}.`;
}

/** The steps at the ATM or till. The SMS carries the exact codes. */
export function collectionSteps(method) {
  if (method === 'CASHSEND') return `Collecting at Absa: go to any Absa ATM (or a Pick n Pay or Boxer till), choose *CashSend*, enter the cellphone number that received the SMS and the codes in that SMS, and take the cash. No card needed. The cash stays collectable for 30 days.`;
  if (method === 'NEDCASH') return `Collecting at Nedbank: go to any Nedbank ATM, choose *Cardless services*, enter the cellphone number that received the SMS and the withdrawal code in that SMS, and take the cash. No card needed.`;
  if (method === 'EWALLET') return `Collecting your eWallet: go to any FNB ATM, choose *Cardless services* then *eWallet*, enter the cellphone number that received the SMS and the ATM PIN in that SMS, choose the amount, and take the cash. No card or bank account needed.`;
  if (method === 'PAYSHAP' || method === 'RTC') return `PayShap lands directly in your bank account; there is nothing to collect.`;
  return `Collecting cash: the SMS tells you exactly which codes to enter. At an Absa ATM choose CashSend, at a Nedbank ATM choose Cardless services, at an FNB ATM choose Cardless services then eWallet; enter the cellphone number that received the SMS and the codes, and take the cash. No card needed.`;
}

/** Both lines for a paid withdrawal: where it arrives, then how to collect (cash methods only get the steps). */
export function collectionInstructions(method, mobile = null) {
  const arrive = arrivalLine(method, mobile);
  if (method === 'PAYSHAP' || method === 'RTC') return arrive;
  return `${arrive}\n\n${collectionSteps(method)}\n\nIf the SMS does not arrive, message me here with your reference and I will check.`;
}
