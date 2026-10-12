# WaPay withdrawals (OTT pay-outs): handover v2, 2026-10-12

Written by the "WaPay payouts end-to-end" thread for its successor thread (same name, "round 5").
Read in order: `CLAUDE.md`, `WAPAY_STATUS.md` (iCloud root), this file, `docs/HANDOVER_PAYOUTS_V1.md`
(the first brief and its 2026-10-08 addendum), `docs/PAYOUTS.md` (every dated status section),
`docs/testing/payouts-production-test-2026-10-08.md` (evidence of the production run and the
round-4 sign-off sheet), memory `payouts-live-run-2026-10-04`, BUGLOG #83 to #98.

## 1. Where the rail stands (production, 2026-10-12)

- **Withdrawals are LIVE on OTT production** since 2026-10-08: PayShap (provider 66), ABSA
  CashSend (67) and Nedbank Cardless (4) have each paid real money from the founder's phone;
  OTT's production webhook finalises a 99 within about a minute. Float R246.68 on 2026-10-10
  (R500 funded; four pay-outs since). Standard Bank Instant Money (2) is on the merchant,
  unmapped. FNB e-wallet is not on the production merchant. Build `1d81d21` (round 4) is the
  last pay-out change; later commits (b93ee70 growth dashboard) do not touch the rail.
- **Rules in the code:** cash methods R50 minimum in multiples of R50 (ATM notes, BUGLOG #98);
  PayShap any amount from R50; product cap R3,000. Saved destinations (encrypted, `WAPAY_PII_KEY`
  is set in production), labels computed on read, nicknames, "forget my bank details".
- **Allowlist: the founder REMOVED the pilot gate on 2026-10-12** ("I'm going to have a lot more
  people start testing"). `WAPAY_PAYOUT_ALLOWLIST` is unset in Vercel, so `payoutAllowedFor`
  returns true for every customer, and `WAPAY_PAYOUT_KYC=off` means no identity check. The
  thread said this once and the founder decided; record it as the standing state, and raise it
  again the day counsel or SARB questions come, or before any public launch. Identity checks
  (Didit, `WAPAY_PAYOUT_KYC` unset) remain the gate for a public launch.
- The sandbox PayShap of 4 October was released against production ("no record", R58 back).
- OTT emails outstanding: 9 (commercials) and 11 (SMS text per merchant, PayShap 99 end state on
  test, CashSend 97 on test, PII in failure e-mails, the float's fee lines). Add from this
  round: which providers accept a FOREIGN ID or passport and the exact `id_type` value and
  country field they want (the founder has OTT's word that ABSA and Nedbank do).

## 2. The Lisa case (2026-10-10 to 10-12): what happened and what it taught

The founder sent R350 to a non-member (his employee, a foreign national with a Capitec account).
"Send money" to a non-member mints an OTT voucher (`VOUCHER_GIFT_OTT`, R350 + R3 fee) on OTT's
TEST host (the issuing rail has never been switched to production), delivered as a PIN when she
joined. Her wallet was R0. She asked ten times over eleven hours, in plain words, to have her
money in her bank; every time the withdraw entry gate answered "Withdrawals start at R50 plus the
fee … you have R0 available". "Send money" (she meant to her bank) opened the gift flow, she typed
her own number, and the bot offered to sell her a R350 voucher for R367 (PayFast link opened, not
paid). "Did my payment go through" was answered "PayFast is still confirming your R350". The
how-it-works answer promised "(R8, minutes)" and demanded a 13-digit SA ID. Full transcript and
ledger trail in the thread's report of 2026-10-12 (reproduced in `docs/testing/lisa-case-2026-10-12.md`
once the successor writes it from this file; the raw turns are in `conversation_turns` for account
`cmv2g0tu4002jd6jcc3kq81wo`).

**Resolved 2026-10-12 on the founder's instruction:** one idempotent ledger entry
`manual-gift-to-wallet-cmv2foj8f001fd6jcamn6pjld` (source `MANUAL_GIFT_TO_WALLET`: CLEARING:OTT
debit 35000, her SPEND credit 35000) put R350 in her balance; a money event in her history says
so; the gift row stays DELIVERED (the table allows ISSUED, DELIVERED, CANCELLED only), the journal
entry is the record. She can now withdraw once the foreign-ID work below lands (PayShap to Capitec is the first test; the founder says OTT confirmed foreign IDs
work for ABSA and Nedbank).

## 3. The founder's decisions of 2026-10-12 (all approved; build in this order)

1. **Gift to a non-member becomes BALANCE when they join** (voucher only if they never join, at
   expiry). Owner: gifting (`lib/gifting.js`, the processor's claim flow) with the main session;
   this thread specifies and tests the money side: the gift's CLEARING:OTT leg must not be posted
   until a voucher is actually minted, or must be reversed on claim-to-wallet exactly as the
   manual entry above does. Until this ships, every "send money" to a non-member creates the
   same trap.
2. **The R0 withdraw gate reads the customer's situation** (`startWithdraw` entry gate): a
   delivered-but-unspent gift, a pending deposit link, a held pay-out, no SA ID. Say where the
   money is in one plain sentence before any minimum. Never the same gate line twice in a row:
   the second time, the fuller explanation and the two or three things they can do; the third
   time, offer a person.
3. **"Send money" to the customer's own number is refused** ("that is your own number; to put
   money in your bank say withdraw"), and a message that names a received voucher never opens a
   purchase.
4. **"Did my payment go through" never says "still confirming" for a link nobody paid**: a
   PENDING deposit intent with no PayFast ITN is "you have not paid that link; ignore it if you
   did not mean to buy".
5. **Foreign ID / passport pay-outs**: the ID step accepts a 13-digit SA ID or a foreign ID /
   passport number (6 to 12 letters and digits), then asks the issuing country (GetCountryCodes
   or a short table), sends `id_type`, `country_of_issue`, `nationality`; `payout_identities`
   gets `idType` = PASSPORT (column exists) plus a `countryOfIssue` column (migration). KYC with
   a passport is Didit's normal path. Confirm the exact `id_type` value with OTT (email).
6. **No time promises anywhere**: the how-it-works brief still says "(R8, minutes)" and
   "arrives in minutes"; `lib/how-it-works.js` withdraw brief and answer.
7. **The gift message** ("reply BALANCE to open your own WaPay") reworded for someone already
   onboarding; the home card must not advertise "Withdraw" to a customer the gate would refuse
   (registry, main session).

8. **From the founder's round-4 review (screenshots received 2026-10-12):**
   - **"lets do a withdrawal to my bank account" must not show the generic menu.** Bank words
     ("to my bank account", "into my account", "bank transfer") map to the bank family; with no
     RTC on the merchant that is PayShap. Open with the customer's situation and the price:
     "PayShap to your bank account: R8 fee, the cheapest way into your bank. You have R86.50, so
     up to R78. No bank account? Cash at an Absa or Nedbank ATM costs from R18. How much?" (the
     amount question merged in). `matchWithdrawAsk` returns RTC for bank words today and
     `startWithdraw` drops a method that is not offered; fix both.
   - **The deposit flow** ("add 50 of deposit?") went straight to the PayFast link. When the
     customer's preferred deposit method is known (profile), that is right; when it is not, the
     same message must also offer cash: buy a Blu voucher (or an OTT voucher once redemption is
     live) at a till and load it here. Deposit flow is the main session's; specify, do not fork.
   - **Nickname follow-up at the save step.** After a bare "yes" (no name), ask once: "Saved.
     What should I call it? Reply *mine*, or a name like *mother*." A second question, optional,
     skippable with anything else. When the number is not the customer's own WhatsApp number,
     ask it every time.
   - **"can you save my number used above as mine?" must be a real action.** The agent answered
     "Saved, Nieuwoudt 😊 I'll remember that the number used above is yours" and saved nothing
     (the second false save claim in a week). Build a deterministic hook: /save (my|this|the)
     (number|account) … as (\w+)/ and "call it X" update the nickname of the most recently used
     destination (`payout_destinations.nickname`, the row touched last), and the agent is told,
     in its rules and its output gate, that it never claims to have saved, noted, stored or
     remembered anything.
   - **Cellphone labels show the last four digits** ("Mine: cellphone •••1175"); ID numbers and
     bank accounts keep three. The main session's pack and about-me line read the same label
     function, so one change covers all; tell the main session (its convention was three).

Also decided: **no pay-outs to other people** (a saved destination is the customer's own); the
**+R2** on cash stays open; **OTT issuing and redemption go to production** (section 5).

## 4. "Way more intuitive, for every literacy level": the mechanism, not a wish

What failed for Lisa was not vocabulary; it was that no reply knew her situation. Build this:

- **One money-situation function** (`lib/money-situation.js`, new; the pack already has most of
  it): balance to spend, held, delivered-but-unspent gifts received, pending deposit links,
  pending pay-outs, saved destinations, identity on file (SA ID / passport / none), pilot flags.
  Every deterministic gate (withdraw entry, send, deposit status, the R0 refusals) and the agent
  read it before composing. A gate that cannot see the situation is a bug.
- **Intent before vocabulary**: "put / move / transfer / pay (in|into|to) my (bank) account",
  "how much can I withdraw", "withdraw X from waypay" are all WITHDRAW; "send money" with the
  customer's own number is WITHDRAW; a received voucher mentioned is VOUCHER-HELP, never BUY.
  The slot rescue the main session built for "50 and 2" is the right home for this table.
- **Repeat detection**: if the reply about to be sent equals the last reply, do not send it;
  send the explanation tier instead (what they have, what it can and cannot do, the one next
  step), and on the third repeat offer a person (the founder's number for the pilot).
- **Plain-language copy rules for refusals**: lead with their money ("You have R0 to withdraw.
  The R350 Nieuwoudt sent you is a voucher…"), then the one thing to do, never a product fact
  first ("Withdrawals start at R50").
- **The Lisa transcript as a permanent test**: her sentences become harness scenario 6d (the
  gate explains the voucher; "send money" + own number is refused; "did my payment go through"
  with an unpaid link; passport at the ID step) so the behaviour can never regress unseen.

## 5. Going to production on OTT issuing and redemption, and Blu: what must happen to test real vouchers

OTT issuing (WaPay vouchers, gifts):
1. Live host = `https://api.ott-mobile.com` (the test URL without `test-`); the live portal
   credentials were received and never applied (`WAPAY_STATUS.md` rails table). Vercel:
   `OTT_BASE_URL`, `OTT_MERCHANT_BASE_URL`, `OTT_MERCHANT_API_KEY`, `OTT_VENDOR_CODE` to the
   production values; redeploy. Never call `GetAPIKey` (rotates the key); GetBalance is the check.
2. The issuing float is prepaid: fund the production float with OTT (the Reseller agreement is
   executed; 4% issuing commission is SIGNED and still booked as 0 in the ledger, a Money Map
   finding). First test: one R10 self-purchase from the founder's phone, the PIN checked with
   OTT's CheckVoucher, then one R10 gift to a second pilot number.
3. Until decision 1 ships, a gift to a non-member still mints a real voucher on production: that
   is real money leaving the float for a spend-only PIN. Ship decision 1 first or accept it.

OTT redemption (loading an OTT voucher into a WaPay balance):
4. Lives on the same host (`docs/OTT_REDEMPTION_API.md`: CheckVoucher, RemitVoucher,
   CheckRemitVoucher). The Merchant (Redemption) agreement is NOT signed (6% + VAT; counsel's
   definition point on wallet credit). Do not go live on redemption until it is signed or the
   definition side letter exists; WaPay's own gifts do not need it once decision 1 ships.

Blu (airtime, data, electricity, and Blu voucher cash-in):
5. `docs/BLU_PRODUCTION_CUTOVER.md` (Blu thread) is the checklist: production host, Basic auth
   user and password, voucher and VAS keys, the IP-whitelisting answer, then the env flip and
   the first vends on the founder's phone. Blocked on Phuti issuing production credentials;
   nothing in code. Blu voucher cash-in is tested with a real voucher bought at a till after
   the flip.

## 6. Standing rules (unchanged)

Never release a hold on an indeterminate answer; GetPaymentStatus request errors never release;
one PerformPayout per intent; `payoutOutcomeMessage` is the one wording; no "Sent" on a timeout;
no time promises; no partner named in customer copy; ID numbers, account numbers and cellphones
masked everywhere; no em dashes in customer copy or emails; never push a red test; `pnpm test` and
`pnpm build` before every push, never `pnpm build` while the harness or `next dev` runs; stage by
path; coordinate with live peers (ListAgents / SendMessage; the processor write-lock protocol in
memory `review-agents-read-only`); `git rm` in the iCloud repo for deletions; apply migrations to
production before the deploy that reads them; after each push, confirm the build on
`/api/internal/payout-status` and that the WhatsApp webhook answers 403 on a bare GET (never 500);
if Vercel shows no status for a commit on GitHub's commit-status API, an empty re-trigger commit
deploys it.

## 7. Where things are

Code this thread owns: `lib/payouts.js`, `lib/payout-chat.js`, `lib/ott-payout.js`,
`lib/payout-beneficiaries.js`, `lib/pii-vault.js`, `lib/payout-collection.js`,
`pages/api/internal/payout-*.js`, `pages/api/webhooks/ott-payout.js`, `pages/api/cron/payout-reconcile.js`.
Docs: `docs/PAYOUTS.md`, `docs/OTT_PAYOUT_API.md`, `docs/PAYOUT_COMMERCIALS.md`,
`docs/testing/payouts-*.md`. Tests: `tests/payout-*.test.mjs`, `tests/payouts.test.mjs`,
`tests/review-2026-09-18.test.mjs` (the offer mechanics), harness scenarios 6b and 6c.
Operator tools: `GET /api/internal/payout-status`, `GET /api/internal/payout-reconcile[?reference=]`,
`GET /api/cron/payout-reconcile`; the probe route refuses production by design. Internal key in
`~/Projects/wapay/.env`. The founder's phone 27787051175 is the pilot; Lisa's account is
`cmv2g0tu4002jd6jcc3kq81wo` (R350 to spend since 2026-10-12).
