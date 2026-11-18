/**
 * The incidents the live alerts record (lib/incidents.js): one builder per alert, so the words an
 * agent reads are written once, beside each other, and tested. Each returns what recordIncident
 * takes. Pure: no number, no customer message, only the product's own words and where to look.
 */
import { OTHER_SENDER_ALARM_AT } from './meta-alerts.js';

const quoted = (phrases) => (phrases || []).map((p) => `"${String(p).slice(0, 40)}"`).join(', ');

/**
 * The loop guard replaced a reply (lib/loop-guard.js): the model told the customer to type words,
 * they typed them, nothing handled them before the model, and the model asked again.
 */
export function echoLoopIncident({ phrases = [], reply = '', accountId = null, displayName = null, source = null } = {}) {
  const words = quoted(phrases);
  return {
    severity: 'P1',
    category: 'stuck-loop',
    title: `The chat asked twice for words nothing handles: ${words}`,
    why: `The model told the customer to type ${words}; they typed it; no code handled it before the model, and the model asked for it again. The second reply was replaced with the round-in-a-circle line, which tells the customer a person will write to them.${source ? ` Brain action: ${source}.` : ''}`,
    fix: `Handle ${words} by code before the model (pages/api/webhooks/message-processor-v2.js, fresh routing, above the Pay agent dispatch), or take the instruction out of what the model reads (lib/how-it-works.js, lib/capabilities.js). Add a test that a reply names only handled commands (tests/login-ask.test.mjs is the pattern). The customer was promised a person: answer them.`,
    accountId,
    displayName,
    botQuote: reply,
    userQuote: (phrases || [])[0] || null,
  };
}

/** Meta reported a message carrying WaPay's mark to a number that never wrote to WaPay (lib/meta-alerts.js). */
export function ownStrangerSendIncident({ category = 'utility', reason = null } = {}) {
  return {
    severity: 'P1',
    category: 'security',
    title: `WaPay's own code sent a ${category} message to a number that never wrote to it`,
    why: `Meta's delivery status for a message that carries WaPay's mark names a recipient with no account opened by their own message${reason ? ` (${reason})` : ''}. Every business-initiated sender must ask lib/outbound-guard.js first, so one sender did not.`,
    fix: `Find the sender that skipped businessInitiatedAllowed: tests/spam-strike-guard.test.mjs lists every file that can send a template or a Direct Send. Start with the newest one. Until it is found, nothing new that sends a template should be deployed.`,
  };
}

/** A day held OTHER_SENDER_ALARM_AT minutes of unmarked business-initiated messages to numbers that never wrote. */
export function otherSenderVolumeIncident({ category = 'utility', minutes = OTHER_SENDER_ALARM_AT } = {}) {
  return {
    severity: 'P1',
    category: 'security',
    title: `Another sender on WaPay's number passed the daily alarm level of ${category} messages`,
    why: `${minutes} minutes in 24 hours held a ${category} message from WaPay's number that WaPay's code did not send (no WaPay mark on Meta's status), each to a number that never wrote to WaPay. UniFuel's voucher delivery sends from this number with its own code.`,
    fix: `Compare with UniFuel's deliveries for the day. If they account for it, this is a business decision (UniFuel on its own number, or a higher alarm level in lib/meta-alerts.js OTHER_SENDER_ALARM_AT). If they do not, the WhatsApp token is in someone else's hands: the founder replaces it in Meta and in Vercel.`,
  };
}
