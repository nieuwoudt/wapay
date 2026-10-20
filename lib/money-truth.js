/**
 * What the customer reads when a model is kept away from their money
 * (BUGLOG #111, Lisa 2026-10-15). Her withdrawal timed out at the ID step;
 * four hours later she typed her ID, which went to the AI as a new message,
 * and the AI wrote "Now enter your WaPay PIN to confirm the payout". She
 * typed her PIN, which went to the AI too, and it wrote "Your payout is being
 * confirmed now". No pay-out existed; she waited a day for money never sent.
 *
 *   bareSecretKind(text)    a message that is only a PIN, an SA ID number or
 *                           a passport number. With no step waiting for it,
 *                           it never reaches a model: bareSecretReply answers.
 *   nothingPendingLine()    replaces a model reply the output gate stopped
 *                           for asking for the PIN or for saying a pay-out is
 *                           under way with none in the record.
 *   privacyBlockedLine()    the turn the model boundary refused.
 *   expiredStepText(state)  the next message after a flow timed out, when it
 *                           is a PIN, an ID or another secret.
 * Pure.
 */

const R = (c) => `R${(Math.max(0, Number(c) || 0) / 100).toFixed(2).replace(/\.00$/, '')}`;

/** SA ID: a real date of birth and the Luhn check digit (a 13-digit meter number rarely passes both). */
export function looksLikeSaId(digits) {
  const d = String(digits || '');
  if (!/^\d{13}$/.test(d)) return false;
  const mm = Number(d.slice(2, 4));
  const dd = Number(d.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
  let sum = 0;
  for (let i = 0; i < 13; i += 1) {
    let n = Number(d[12 - i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

const UNIT = /^\d+(?:MB|GB|KB|TB|MIN|MINS|SMS|KWH|KW|HR|HRS|DAY|DAYS|ML|KG)$/i;

/**
 * 'PIN' | 'ID' | 'PASSPORT' | null for a message that is nothing but one
 * secret. A phone number, an amount ("R1000", "1000 rand") and a 12- or
 * 16-digit voucher PIN are not this (other flows own those). Pure.
 */
export function bareSecretKind(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 40) return null;
  if (/^\d{4,6}$/.test(t)) return 'PIN';
  const digits = t.replace(/[\s-]/g, '');
  if (/^\d{13}$/.test(digits) && looksLikeSaId(digits)) return 'ID';
  if (t.split(/\s+/).length <= 2) {
    const token = digits.toUpperCase();
    if (/^(?=[A-Z0-9]*[A-Z])(?=(?:[A-Z]*\d){5})[A-Z0-9]{6,12}$/.test(token) && !/^R\d/.test(token) && !/^ZAR/.test(token) && !UNIT.test(token)) return 'PASSPORT';
  }
  return null;
}

/** The deterministic answer to a bare secret nothing was waiting for. Pure. */
export function bareSecretReply(kind) {
  if (kind === 'PIN') {
    return `🔐 Nothing is waiting for a PIN right now, so I did not use that number. Keep your PIN to yourself: I only ask for it at the last step of a payment you started.\n\nIf you meant an amount, say what it is for, like "withdraw 1000" or "deposit 1000".`;
  }
  return `🪪 Nothing is waiting for an ID or passport number right now, so I did not use it or keep it. If you were in the middle of a withdrawal, it stopped after waiting too long and nothing was sent. Say *withdraw* to start again.`;
}

/** Replaces a model reply that asked for the PIN or claimed a pay-out with none pending. Pure. */
export function nothingPendingLine(spendCents) {
  return `Nothing is waiting for your PIN and no withdrawal is in progress right now. 💰 Balance to spend: ${R(spendCents)}. To withdraw, say *withdraw* and the amount.`;
}

/** The turn the model boundary refused (a secret in the message). Pure. */
export function privacyBlockedLine() {
  return `🔒 For your safety I do not read ID, passport, bank account or PIN numbers in a chat message. Tell me what you want to do (like "withdraw" or "buy electricity") and I will ask for the number at the right step.`;
}

/** The next message after a flow timed out, when it is a secret. Pure. */
export function expiredStepText() {
  return `⏱️ That step timed out after waiting a while, so I did not use what you just sent, and nothing was paid. Tell me what you want to do and I will start again.`;
}
