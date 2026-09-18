/**
 * The Pay agent's pilot list (docs/AGENT_ARCHITECTURE_V2.md, Phase 2).
 *
 * `WAPAY_AGENT_V3_MSISDNS` is a comma-separated list of the numbers whose
 * turns go to the agent instead of the regex hooks and the two-tier engine.
 * Unset means nobody. It is the whole of the Phase 3 promotion mechanism, so
 * it lives in one file a test can import, rather than inside the processor
 * where the only way to test it was to slice it out of the source text and
 * eval it.
 *
 * WHY NORMALISATION (2026-09-18). The list was an exact string match against
 * the wa_id Meta sends ("27787051175"). A human setting the variable in the
 * Vercel dashboard has four equally natural ways to write the same number:
 * "27787051175", "+27787051175", "0787051175", "+27 78 705 1175". Three of
 * them silently matched nobody, and the failure is invisible: the bot keeps
 * answering normally, the pilot simply never starts, and the week of shadow
 * turns the promotion gate needs never accrues. Matching is now on the
 * canonical digits (`normaliseMsisdn`, the same normalisation every other
 * number in the product goes through), so every spelling of one number is
 * that number.
 *
 * Normalisation never widens the list to a DIFFERENT number: it maps a
 * spelling to a canonical form and compares the whole string, so a prefix, a
 * superstring or another number still does not match.
 */

import { normaliseMsisdn, isValidSaMsisdn, toWaId } from './msisdn.js';

/** The raw entries of the pilot list, in the order they were written. */
export function shadowListEntries() {
  return String(process.env.WAPAY_AGENT_V3_MSISDNS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Is this customer on the pilot list? An unset list is nobody, never everybody. */
export function agentV3For(waId) {
  const wanted = normaliseMsisdn(waId);
  if (!wanted) return false;
  return shadowListEntries().some((entry) => normaliseMsisdn(entry) === wanted);
}

/**
 * What Mission Control shows about the list, without ever printing a whole
 * number: for each entry its last four digits and whether it reads as a real
 * SA mobile number. An entry that does not is the single most likely reason a
 * pilot week is empty, and it should be visible on the card rather than
 * inferred from an absence of rows a week later.
 */
export function shadowListDiagnostics() {
  return shadowListEntries().map((entry) => {
    const normalised = normaliseMsisdn(entry);
    return {
      tail: normalised ? normalised.slice(-4) : null,
      valid: isValidSaMsisdn(entry),
      waId: toWaId(entry),
    };
  });
}
