/**
 * Proposal tools for the pay agent: the model PROPOSES an action with the
 * slots it heard; the processor re-validates every slot and starts the flow
 * at its FIRST step. Nothing here touches the ledger, a provider or a
 * database. `propose_note` used to be the one exception and wrote straight
 * to the customer's profile; it now proposes like everything else and the
 * runtime writes the note after the customer says yes (2026-09-18).
 *
 * Rules kept (do not weaken):
 * - A PIN, a voucher PIN, an OTP or any bearer secret is never accepted as
 *   an argument: secret-looking keys are dropped before the slots are built,
 *   and start_voucher_load carries no arguments at all (the customer types
 *   the PIN into the flow).
 * - Slots are normalised to the exact shape the dispatcher validates:
 *   integer cents or null, digits-only msisdn or null, short strings or null.
 * - The tool never decides the rail, the fee or the recipient's identity:
 *   that is the flow's job after this proposal.
 */
import { PROPOSAL_ACTIONS, SLOT_KEYS, WITHDRAW_METHODS, proposalToolByName } from './schemas.js';

const SECRET_KEY = /pin|otp|password|secret|token|cvv|code$/i;
const MAX_AMOUNT_CENTS = 500000; // the dispatcher's own ceiling (dispatchOrchestratorAction)
const LONG_DIGIT_RUN = /\d{7,}/g; // an account, ID, card or PIN-shaped run inside a free-text slot

function cleanCents(v) {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && n > 0 && n <= MAX_AMOUNT_CENTS ? n : null;
}

function cleanMsisdn(v) {
  const digits = String(v ?? '').replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 12 ? digits : null;
}

function cleanText(v, max) {
  if (v == null) return null;
  const s = String(v).replace(LONG_DIGIT_RUN, '').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || null;
}

function cleanBool(v) {
  if (v === true || v === false) return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function cleanMeter(v) {
  const digits = String(v ?? '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 13 ? digits : null;
}

function cleanMethod(v) {
  const m = String(v ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return WITHDRAW_METHODS.includes(m) ? m : null;
}

/** The empty slot set, every key present and null. */
export function emptySlots() {
  return Object.fromEntries(SLOT_KEYS.map((k) => [k, null]));
}

/**
 * Build the slot object for an action from raw tool arguments. Only the
 * slots that action uses are read; everything else stays null. Secret keys
 * are dropped whatever the action.
 */
export function slotsFor(action, rawArgs = {}) {
  const args = {};
  for (const [k, v] of Object.entries(rawArgs && typeof rawArgs === 'object' ? rawArgs : {})) {
    if (!SECRET_KEY.test(k)) args[k] = v;
  }
  const slots = emptySlots();
  switch (action) {
    case 'BUY_AIRTIME':
      slots.amountCents = cleanCents(args.amountCents);
      slots.msisdn = cleanMsisdn(args.msisdn);
      slots.self = cleanBool(args.self);
      slots.category = 'AIRTIME';
      break;
    case 'BUY_DATA':
      slots.productQuery = cleanText(args.productQuery, 80);
      slots.amountCents = cleanCents(args.amountCents);
      slots.msisdn = cleanMsisdn(args.msisdn);
      slots.self = cleanBool(args.self);
      slots.category = 'DATA';
      break;
    case 'BUY_ELECTRICITY':
      slots.amountCents = cleanCents(args.amountCents);
      // The dispatcher discards the meter and asks for it in the flow; it is
      // carried only so a re-validation can see what the model heard.
      slots.meterNumber = cleanMeter(args.meterNumber);
      slots.category = 'ELECTRICITY';
      break;
    case 'SEND_VOUCHER':
      slots.amountCents = cleanCents(args.amountCents);
      slots.msisdn = cleanMsisdn(args.msisdn);
      slots.recipientName = cleanText(args.recipientName, 40);
      slots.self = cleanBool(args.self);
      break;
    case 'REQUEST_MONEY':
    case 'DEPOSIT_START':
    case 'BUY_FUEL':
      slots.amountCents = cleanCents(args.amountCents);
      break;
    case 'WITHDRAW':
      slots.amountCents = cleanCents(args.amountCents);
      slots.method = cleanMethod(args.method);
      break;
    case 'REDEEM_VOUCHER':
    case 'HOME':
    case 'HELP':
    default:
      break;
  }
  return slots;
}

/** Run one proposal tool: { ok: true, proposal: { action, slots } }. Never throws. */
export function executeProposalTool(name, args = {}) {
  const def = proposalToolByName(name);
  if (!def) return { ok: false, error: 'UNKNOWN_TOOL' };
  try {
    return { ok: true, proposal: { action: def.action, slots: slotsFor(def.action, args) } };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
}

/** A pending intent from the reply tool, re-validated the same way (null when the action is unknown). */
export function cleanPendingIntent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const action = String(raw.action || '').toUpperCase();
  if (!PROPOSAL_ACTIONS.includes(action)) return null;
  return { action, slots: slotsFor(action, raw.slots || {}) };
}

// ---------------------------------------------------------------------------
// propose_note: the one write the model may propose (docs §5, number-free,
// about the customer, capped).
// ---------------------------------------------------------------------------

export const NOTE_MAX_CHARS = 120;
// How many notes are kept is the storage's business, not the tool's:
// NOTES_MAX lives with the writer in lib/user-profile.js.
const ABOUT_CUSTOMER = /\b(i|i'm|i've|i'd|i'll|me|my|mine|myself|you|you're|you've|you'd|your|yours|yourself|we|we're|our|ours|us)\b/i;

/** Why a note is refused, or null when it is acceptable. Exported for tests. */
export function noteRejection(note) {
  const text = String(note ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return 'EMPTY';
  if (text.length > NOTE_MAX_CHARS) return 'TOO_LONG';
  if (/\d/.test(text)) return 'HAS_DIGITS';
  if (!ABOUT_CUSTOMER.test(text)) return 'NOT_ABOUT_CUSTOMER';
  return null;
}

/**
 * The model may ASK to remember something the customer said about themself.
 * It may not remember it. This returns a pending note and writes nothing;
 * the runtime asks the customer once and writes on the yes
 * (`addNote` in lib/user-profile.js). Until 2026-09-18 this function wrote
 * the note the moment the model called it, which made the model the author
 * of a customer fact and broke the standing rule that it never is.
 *
 * Pure by design: no database, no clock, no context. `accepted` stays false
 * on every path here, so no caller can read a proposal as a stored fact.
 */
export function executeProposeNote(args = {}) {
  const text = String(args?.note ?? '').replace(/\s+/g, ' ').trim();
  const reason = noteRejection(text);
  if (reason) return { ok: true, accepted: false, note: null, reason };
  return { ok: true, accepted: false, note: null, pendingNote: { text }, reason: 'NEEDS_CONFIRM' };
}
