# The golden thread

*The security and money-safety rules every change to WaPay must keep. The founder asked for it on 2026-10-16, after Lisa's withdrawal: "you can never leak personal information to the AI, ever … even the bank information needs to be securely stored, and the IDs … safeguards in place that we can't transfer funds from a customer's account … structurally and architecturally implemented so that this never, ever, ever happens again."*

Every rule names three things:

- **the rule**, in one sentence;
- **where it is enforced**, a piece of code that every path goes through;
- **the test that fails the build** if a change breaks it.

A rule that has only a comment is not on this thread.

**Read this at session start** (repo `CLAUDE.md` points here). A change that adds a model call, a money path, a stored secret or a customer-facing promise adds its line here in the same commit, with its guard. A change that breaks a rule does not ship.

---

## 1. Personal data never reaches an AI model

**Why.** On 2026-10-15 Lisa's withdrawal timed out at the ID step. Four hours later she typed her passport number, and it went to the two-tier AI as a new message. Then she typed her PIN, and that went to the AI too. The AI asked for the PIN and wrote "Your payout is being confirmed now". Nothing had been sent (BUGLOG #111).

| # | Rule | Enforced in | Test |
|---|---|---|---|
| 1.1 | **One door.** Every request to a model provider is made in one of four places, and all four cross the model boundary: `packages/ai/src/orchestrator.ts` (two-tier), `packages/ai/src/agent.ts` (Pay agent), `lib/localize.js` (translation), `lib/vas-embeddings.js` (product search). A new model call anywhere else fails the build. | `packages/ai/src/boundary.ts`: `guardChatMessages` inside `callStructured` and `runAgentTurn`, `assertGuarded` inside `callModel` (the last line before the client), `guardTranslation`, `guardEmbeddingInput` and `guardEmbeddingBatch` | `tests/model-boundary.test.mjs` "structure" (scans `lib`, `pages`, `packages`, `apps`, `scripts` for provider calls) |
| 1.2 | **A secret refuses the call.** The call never goes out if the customer's message holds an SA ID or passport number, a bank account number, a PIN (bare, or named as "my pin is…"), a voucher PIN or token, or any other run of 7 or more digits. It fails with `AI_PRIVACY_BLOCK`, the customer gets a fixed answer (`privacyBlockedLine`), and the log records the kinds, never the value. On the agent path the `agent_turns` row records the reason. | `findSecrets` and `guardChatMessages` (boundary.ts); `handleAIChat` catch and the `handleAgentTurn` error branch (processor) | `tests/model-boundary.test.mjs` (Lisa's shapes refused; on the agent loop, the provider is never called) |
| 1.3 | **What the model needs, it gets as a token.** Phone numbers become `[[P1]]`, e-mail addresses `[[E1]]`, and the names we know `[[N1]]`: the customer's own, the account holder typed in a flow, saved people, a pay-out's counterparty. Our own references in the record and in tool results become `[[S1]]`. All of them are restored in the slots, tool arguments and reply on the way out. | `tokenize`, `restore`, `restoreDeep`, `tokenizeDeep` (boundary.ts); names come from `lib/privacy-names.js` and the request's privacy scope (`runWithPrivacy` wraps `processMessage`; `addPrivacyNames` adds names along the way) | `tests/model-boundary.test.mjs` (the provider sees no name, phone, e-mail or reference; the tool gets the real number; the reply reads the real names) |
| 1.4 | **A bare secret is answered before the model.** A message that is only a PIN, an SA ID or a passport number, with no step waiting for it, gets a fixed answer (`bareSecretReply`). On both brains this happens before the model, and on the agent it also happens before the turn budget. | `bareSecretKind` (`lib/money-truth.js`) at the top of `handleAIChat` and after `agentGuard` in `handleAgentTurn` | `tests/payout-timeout.test.mjs`, `tests/phase2.test.mjs` (order: guard → bare secret → budget → context → model), harness 6f |
| 1.5 | **Memory keeps no secret and no account-holder name.** `conversation_turns` stores: digits hidden at PIN, account and ID steps; `[name]` for the name typed at the withdrawal's name step; and `Name on the account: [name]` in our own confirmation. That memory is what the next turn's model sees. | `redactForMemory` (`lib/turns.js`); `recordInbound` flags in the processor | `tests/payout-timeout.test.mjs`, `tests/turns.test.mjs` |
| 1.6 | **Translation sends no personal data.** Our deterministic copy goes to the translator with amounts, codes and digits frozen, and with names, passports and e-mails as tokens. If anything unsafe survives, or a token comes back missing, the customer gets the English original. | `guardTranslation` in `localizeOutbound` | `tests/model-boundary.test.mjs` (translation) |
| 1.7 | **Logs carry kinds and masks, never values.** Model refusals log kinds only; payout metadata keeps masks; the webhook and state logs hide bare digits. | boundary `refuse`, `lib/payouts.js` `masked`, processor log masking | `tests/pin-reset.test.mjs` (log masking), `tests/payouts.test.mjs` (masked recipient) |

**Residual risk, stated honestly.** A name the customer types in free text that WaPay has never seen (a new recipient, as in "send R50 to Sipho") reaches the model as typed: the boundary can only hide the names it knows. The flows ask for every name the money needs at a step of their own (the account holder, a recipient), and those steps never reach a model.

- **The daily conversation audit (2026-10-19, docs/audits/DAILY_AUDIT.md)** reads redacted transcripts (numbers masked, the full-name step masked by position, account ids only) and sends them to the model through `callStructuredOnce` in `packages/ai/src/orchestrator.ts`: the same door as every chat turn, names tokenised, secrets refused, and with `restore:false` so the tokens stay tokens in what is stored. Its findings carry account ids and quotes of the bot's own lines, never a customer's name or number.

## 2. No money leaves a customer's balance without the customer

**Why.** The founder's rule: WaPay itself, a bug, an AI, an operator or anyone holding a link must never be able to move a customer's money out. The read-only inventory of every money path (2026-10-16, summarised in §8) found that every customer debit in chat verifies the PIN in the same request, and that no admin route and no AI tool posts money. One door was still too wide: the PIN was checked in the chat, but the pay-out function itself accepted any caller (BUGLOG #112).

| # | Rule | Enforced in | Test |
|---|---|---|---|
| 2.1 | **A pay-out needs the customer's proof.** That means a proof that this customer typed their PIN, or that the business owner passed the portal step-up, for this intent and this exact amount, at most two minutes ago. `requestPayout` is the one door to the rail. It checks the proof before it writes a row, moves a cent, reserves a hold or calls the rail. `executeWithdraw` checks it before it decrypts a saved destination. | `verifyPinProof` (`packages/auth/src/pin-proof.ts`) in `lib/payouts.js` `requestPayout` and `lib/payout-chat.js` `executeWithdraw` | `tests/money-out-safeguards.test.mjs` (no proof, a stale one or another amount: nothing written, moved, held or sent; source order: proof → row → cent → hold → rail) |
| 2.2 | **Only a correct PIN or a correct step-up can issue a proof.** `verifyPIN` issues one on its success path when told what the PIN approves. `verifyStepUp` issues one on a correct password or one-time code. No other code can, and no dependency can stand in for the verifier. | `issuePinProof` call sites | `tests/money-out-safeguards.test.mjs` "structure" |
| 2.3 | **No secret, no proof, no withdrawal.** The proof key is a deployment secret with no default in source. | `proofKey` (pin-proof.ts) | `tests/money-out-safeguards.test.mjs` (fail closed) |
| 2.4 | **A proof is single use.** It is bound to one intent, and an intent pays out at most once: `requestPayout` replays on the intent id, one PerformPayout per intent, ever. | the `payout-${accountId}-${intentId}` idemKey | `tests/payouts.test.mjs` (replay never reaches OTT) |
| 2.5 | **A late PIN never approves.** A PIN or a YES that arrives after its step timed out is not used. The confirmation is shown again, with the money read fresh. | `resumeLateWithdraw` (`lib/payout-chat.js`) in the processor's idle-expiry branch | `tests/payout-timeout.test.mjs`, harness 6f (the late PIN reaches no rail) |
| 2.6 | **The AI proposes, never executes.** No agent tool imports a ledger writer. Every proposal is handed to a deterministic flow that ends at a PIN step. | `dispatchOrchestratorAction`, `lib/agent/tools` | `tests/phase2.test.mjs`, `tests/agent-tools.test.mjs` |
| 2.7 | **Every purchase checks the PIN inside its route.** Airtime, data, electricity, fuel and voucher-gift execute routes stand behind the internal key and verify the PIN before touching the preview. | `pages/api/vas/*/execute.js` | `tests/vas-routes-internal.test.mjs`, `tests/pin-reset.test.mjs` |
| 2.8 | **A reset without a second check pauses withdrawals to new destinations.** After a PIN reset with no ID check, a withdrawal can only go to a destination saved before the reset, for 24 hours (`WAPAY_PIN_RESET_COOLOFF_HOURS`; 0 switches it off). | `pinResetCoolOff`, read in `startWithdraw` and `executeWithdraw` | `tests/pin-reset.test.mjs` |
| 2.9 | **A card callback mints nothing it cannot prove.** Without the whole merchant configuration nothing is approved: an empty secret signs for anyone, and an empty merchant id matches an empty claim. Adumo's public sandbox secret never approves outside the sandbox. | `verifyJwtHs256` and `verifyAdumoResponse` (`lib/adumo.js`) | `tests/money-out-safeguards.test.mjs`, `tests/adumo.test.mjs` |
| 2.10 | **No operator route changes a balance.** Admin routes are read-only. A manual credit is a `postEntry` with an idemKey, never a direct wallet update. | constitution invariant 2 | `tests/ledger-core.test.mjs`, `tests/ledger-post.test.mjs`, inventory 2026-10-16 |
| 2.11 | **A send moves money only inside WaPay, with the sender's proof.** "Send money" moves balance to balance (a member) or into WaPay's held-gift liability (anyone else), never a voucher and never a rail. The route verifies the sender's PIN for this preview and amount; `sendMoney` checks the proof before any write. Held money is claimed once into the recipient's balance, or refunded to the sender after 30 days. What the sender reads is the same whether or not the number is on WaPay. | `lib/send-money.js`, `pages/api/wallet/send/*`, `lib/pending-gifts.js` (`claimHeldGiftsToBalance`, `refundExpiredHeldGifts`; voucher claims exclude rail WAPAY) | `tests/send-money.test.mjs`, harness 6g |

## 3. Bank and ID details are stored encrypted

| # | Rule | Enforced in | Test |
|---|---|---|---|
| 3.1 | **Saved details are encrypted.** A saved bank account, cellphone and ID or passport are encrypted with AES-256-GCM under `WAPAY_PII_KEY` (key versioned for rotation) and decrypted only at the moment of use. "forget my bank details" erases them. | `lib/pii-vault.js`, `lib/payout-beneficiaries.js` | `tests/payout-beneficiaries.test.mjs` |
| 3.2 | **Details typed mid-flow are sealed.** The account number, the ID number and a pending passport number in an open withdrawal are sealed in `Account.conversationData` on every write and opened only on read. Without the key nothing is sealed (as before) and old rows still read. A sealed row that cannot be opened makes the flow start fresh, never half. | `lib/flow-seal.js` in `updateConversationState` / `getConversationState` (`pages/api/webhooks/user-manager.js`) | `tests/payout-timeout.test.mjs` (sealing) |
| 3.3 | **Provider records keep masks only.** For example `•••678`, `•••1175` and `PASSPORT/ZW`, never a full number. | `requestPayout` `masked` | `tests/payouts.test.mjs` |
| 3.4 | **Memory is redacted before it is stored** (see 1.5). | `lib/turns.js` | `tests/turns.test.mjs` |

**Switch to check:** `WAPAY_PII_KEY` must be set in production for 3.1 and 3.2 (`/api/internal/payout-status` → `switches.piiKey`).

## 4. The chat never claims what the ledger does not say

| # | Rule | Enforced in | Test |
|---|---|---|---|
| 4.1 | **A model never asks for the wallet PIN.** A PIN is typed only at a flow's own PIN step; a voucher's PIN is a different thing and may be asked for. | `outputGate` `PIN_ASK` (`lib/agent/guards.js`) on both brains' replies | `tests/payout-timeout.test.mjs` (Lisa's exact sentence), `tests/agent-guards.test.mjs` |
| 4.2 | **A model never says a pay-out is under way unless the record has one pending.** The replacement is `nothingPendingLine` with the real balance. | `outputGate` `MONEY_CLAIM` with `payoutPending` from the pack, on both brains | same, plus `tests/phase2.test.mjs` and `tests/phase2-review.test.mjs` (both reply sites) |
| 4.3 | **Receipt-shaped model replies are blocked**, and finalised pay-out wording has a single source. | `looksLikeReceipt`, `payoutOutcomeMessage` | existing |
| 4.4 | **No time promises, no partner named in customer copy.** | copy tests | `tests/how-it-works.test.mjs`, `tests/payout-round5.test.mjs` |

## 5. The chat never traps a customer

| # | Rule | Enforced in | Test |
|---|---|---|---|
| 5.1 | **A late answer is never handed to the AI.** When a flow times out (30 minutes, `WAPAY_STATE_IDLE_MINUTES`) and the next message answers the step that expired, what happens is deterministic. In a withdrawal, the flow carries on (account, bank, cellphone, name, ID) or is confirmed again (YES or a PIN), for 24 hours (`WAPAY_PAYOUT_RESUME_HOURS`); after that it says it stopped. In any other flow, a late PIN or ID is told the step timed out. | processor idle-expiry branch, `resumeLateWithdraw`, `expiredStepText` | `tests/payout-timeout.test.mjs`, harness 6f |
| 5.2 | **"forgot PIN" works from anywhere,** a wrong PIN never ends a flow, and a running reset is never restarted by its own words. | `lib/pin-reset.js` | `tests/pin-reset.test.mjs`, harness 6e |
| 5.3 | **No round in a circle.** A reply that asks the customer to type what they just typed is never sent. | `lib/loop-guard.js` on both brains | `tests/pin-reset.test.mjs` |
| 5.4 | **The never-trap standing rule** of the v1.3 loop applies to every flow. | `docs/HANDOVER_V1.3.md` | harness |

## 6. Secrets have no default in source

The PIN proof key and the PIN token secret have none: without the env, nothing is signed. Adumo's published sandbox secret is refused outside the sandbox.

No credential value is committed anywhere in the repository, docs and scripts included: a doc names the variable and says `<set in Vercel>`. `tests/no-committed-credentials.test.mjs` walks every tracked text file and fails the suite on a credential-shaped string; published test values are allowed only by their SHA-256 with the source named (BUGLOG #132).

**Legacy, open:** `PIN_PEPPER` still falls back to a value in source (`packages/auth/src/pin.ts`). Changing it would break every stored PIN hash, so production must set it; `switches.pinPepperSet` on `/api/internal/payout-status` says whether it does. A rehash-on-verify migration is the way off the default.

## 7. Production switches (read them, never guess)

`GET /api/internal/payout-status` (internal key) answers with booleans and numbers only:

- `piiKey`: rules 3.1 and 3.2;
- `pinProofSecret`: rule 2.3;
- `pinPepperSet`: §6;
- `pinResetCoolOffHours`: rule 2.8;
- `payoutResumeHours`: rule 5.1;
- `stateIdleMinutes`: rule 5.1.

## 8. Open items (found 2026-10-16, not yet closed)

These come from the read-only inventory of every money path. Each one needs an owner and a decision. None of them is a path for a stranger to take a customer's money in chat today.

| # | Finding | Recommendation |
|---|---|---|
| O1 | **A PIN reset without an ID on file needs only the phone.** Afterwards purchases, voucher gifts to another number and paying someone's request work at once with the new PIN; only withdrawals wait (2.8). | Extend the cool-off to money sent to another person (voucher gifts to another number, paying requests) for the same 24 hours. Decision for the founder. |
| O2 | **The business portal pays out on the owner's step-up** (portal password, or a code to the owner's WhatsApp), not the wallet PIN, and has no PIN-reset cool-off. It is now proof-bound (2.1). | Decide whether the step-up should be the wallet PIN plus the code. |
| O3 | **PayFast ITN:** no `merchant_id` comparison, the passphrase is optional, and the source-IP check is opt-in. | **Two of three closed 2026-10-16 (CHANGELOG 89):** `merchant_id` must equal `PAYFAST_MERCHANT_ID` and the passphrase must be configured, both refused before `verifyItn` in production. Source IP stays warn-only on purpose: PayFast's live network sends from ranges beyond the published CIDRs (a real R20 was refused 2026-08-21); enforce it only once PayFast supplies a current range list. |
| O4 | **Cron routes trust an `x-vercel-cron` header**, and `CRON_SECRET` also travels in the query string. The impact is limited (reconciliation against provider status). | **Closed 2026-10-16:** `lib/cron-auth.js`, Bearer `CRON_SECRET` only (timing-safe), fails closed and logs when the secret is unset; the three cron routes import it; `payout-status` reports `cronSecretSet`. Founder: confirm `CRON_SECRET` (16+ chars) is set in Vercel, or the 02:00 sync stops with a 401 in the log. |
| O5 | **`BLU_VAS_STUB_MODE=true` has no production refusal:** a purchase would debit and deliver nothing. | **Closed 2026-10-16:** `assertBluStubAllowed` in the Blu provider throws `BLU_STUB_FORBIDDEN_IN_PRODUCTION` at every stub site (airtime, data, network lookup) and in the electricity route, before any hold; outside production the stub still works for QA. |
| O6 | **Concurrent executes of the same preview** (airtime, data, voucher) can call the supplier twice. The customer is debited once; any loss is WaPay's. | **Closed 2026-10-16:** fuel's atomic PENDING/RECONCILE → EXECUTING flip (`updateMany` on the current status, 409 `IN_PROGRESS` for the loser, stale takeover after 120 s) now runs on airtime, data and voucher execute, after the PIN and before the hold. |
| O7 | **`pages/api/test-deposit.js` answers in production** (moves nothing), and `apps/api` has an unauthenticated deposit route (deployment unconfirmed). | **Closed 2026-10-16:** both files removed and the scaffold's registration deleted; a test asserts they stay gone. |
| O8 | **`PIN_PEPPER` default in source** (§6). | **Code closed 2026-10-16, env open:** `pepperCandidates()` tries the current pepper, then `PIN_PEPPER_PREVIOUS`, then the in-source default; a PIN that verifies under an old pepper is rehashed under the current one in the same update. Production logs `pin_pepper_default_in_production` once per instance until the founder sets `PIN_PEPPER` (any 32+ random bytes); no customer is locked out by the change. |
| O9 | **The leaked supplier and Meta secrets are not rotated yet** (memory `key-rotation-deferred`). | **Code side closed 2026-10-20 (CHANGELOG 104, BUGLOG #132):** every value in the repository replaced with a placeholder, and the suite fails on a credential-shaped string (§6). **Rotation still open** (founder, in progress): Supabase database password, Meta WhatsApp token and webhook verify token, Blu QA password and API keys, Yoyo client secret; the repository made private. History keeps the old values until they are rotated, and it is not rewritten: no force-push, commits only (founder, 2026-10-20). |
| O10 | **KYC is off for every customer** (`WAPAY_PAYOUT_KYC=off`, the founder's open-pilot decision of 2026-10-12). | Revisit with counsel before scale. |
| O11 | **"Send money" is a wallet-to-wallet transfer since 2026-10-18 (BUGLOG #117).** One customer's balance credits another's, or WaPay holds it for a non-member. That is e-money, not a closed-loop voucher sale. This is the founder's open-pilot stance, like O10. | Take it to counsel with O10 before a public launch. |

## 9. History

- 2026-10-16: the thread created; §1 to §7 implemented and tested. The read-only money-path inventory produced §8. BUGLOG #111 to #114.
- 2026-10-16 (main session, CHANGELOG 89): O3 (two of three), O4, O5, O6, O7 closed in code; O8 closed in code, waiting on the `PIN_PEPPER` env. Open: O1, O2, O9, O10, the IP half of O3.
- 2026-10-20 (CHANGELOG 104): the repository found public with credentials in setup docs and scripts; values replaced, the no-committed-credentials guard added to §6, O9 closed on the code side, rotation open.
