# Review note · 2026-08-27 (evening)

Founder signed off the pay-page design (round 4) and asked for an end-to-end
conversational test rig ("a bug reporter that chats with our chat"). Both done.

## Shipped today (all pushed, all green)
- `fe3837f` — mid-flow intent switch: "payment link" asks detected anywhere,
  switch acknowledged out loud, sentence backstops in 8 collector states
  (BUGLOG #29, founder's live repro).
- `b887beb` — pay page round 4: big hero back (™ small/non-bold), card
  button lights up on a valid number, "Enter your WhatsApp number first."
  popup, iOS-autofill-safe.
- Chat QA harness (this commit): `pnpm qa:chat`.

## The harness, in one paragraph
It talks to the REAL WaPay brain — real database, real OpenAI orchestrator
and localizer — with exactly one thing swapped: outbound WhatsApp sends are
captured instead of delivered, so nothing can reach a real phone. It seeds a
zero-balance QA account (27600000901), runs 6 scripted conversations, writes
a bug-reporter-style verdict to `docs/testing/chat-qa-report-<date>.md`, and
deletes the account. No PIN is ever entered; no purchase completes; no money
exists to move.

## What its FIRST run caught (all fixed same evening)
1. **BUGLOG #30 — memory amnesia**: starting or ending ANY flow silently
   wiped the AI's conversation history. "What did I tell you my name was?"
   could never work after a flow. History now survives all transitions.
2. **BUGLOG #31 — products-menu hijack**: every sentence containing
   "what/which/show/list" was classified as a product query, so personal
   questions got the 🛒 menu instead of the AI.
3. **Em-dash leaks**: the 11 language confirmations and the AI's own
   free-text replies carried em dashes into client copy. Confirmations
   rewritten; model output now normalized before sending.

## Second run: 6/6 PASS
Founder repro (meter-state escape to a real R20 link) · fluidity chain
electricity→airtime→home→get-paid · replayed-message dedupe · AI recall ·
recall ACROSS a flow · isiZulu switch with live-localized balance (money
figures frozen) + Afrikaans inbound understood.

Unit suite 383/383 · production build green.

## Still open (unchanged)
- Founder live-test list in the tracker (voucher display, forwardable,
  preview card, PayFast prefill) — the harness does not replace on-phone UX checks.
- OTT payout portal credentials; counsel gate; website compliance before ads.
- Key rotation (existing item) — note: `env.template` in the repo carries a
  live-looking Meta access token; fold it into the rotation sweep.
