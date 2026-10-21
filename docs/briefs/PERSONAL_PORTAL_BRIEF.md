# WaPay personal web portal — build brief (v1, 2026-10-21)

**Why now.** Meta restricted WaPay's WhatsApp number for 30 days on 20 October 2026 (21:30 UTC):
WaPay cannot reply to any customer until 19 November unless the review reverses it. Customers who
hold balances (six people hold R2,871 to R5,807 right now) write to WaPay and hear nothing, which
reads as a scam. They need a place that is not WhatsApp where they can log in, see their money,
get paid, and pay out. WaPay for Business already proves the shape (`pages/business/index.js`,
`pages/api/business/*`, `lib/business-auth.js`); this is the personal twin, mobile-first.

**The one rule that decides the design:** nothing on this portal may depend on WhatsApp. Login,
PIN reset, pay-outs and receipts must all complete without a single WhatsApp message. WhatsApp
notifications are optional and best-effort.

## Scope v1 (one build, one day)

| Area | What ships | Reuse |
|---|---|---|
| Host | `pages/app/*` (UI) and `pages/api/app/*` (API) on the existing Next.js app; reachable at `/app` on every host; the founder later points `app.wapay.co.za` at it | business portal routing |
| Login | South African cell number + the customer's WaPay PIN (4 digits, same PIN as the chat). Rate limit 5 tries / 15 min per number and per IP, then a 15-minute lockout. Session cookie `wapay_app` (HttpOnly, Secure, SameSite=Lax, 24 h), CSRF double-submit token on every POST | `@wapay/auth` `verifyPIN` (the real verifier, never a copy), `lib/business-auth.js` for the cookie, lockout and CSRF patterns |
| Forgot PIN | The ID or passport number on file (`payout_identities` or `profile.kyc`), compared on the last digits and a hash, then a new PIN twice. Accounts with no ID on file see "Ask WaPay on WhatsApp" plus a support e-mail | `lib/payout-beneficiaries.js` `loadPayoutIdentitySecret`, the chat's PIN-reset cool-off rule (24 h) |
| Home | Balance card (available = SPEND + CASH, with the two lines underneath), a status banner read from `/api/internal/flags`-style config ("WhatsApp replies are paused by WhatsApp until further notice. Your money is safe and everything here works."), four quick actions (Get paid, Top up, Send, Pay out), last 5 activity rows | `payoutBalances`, `listPayouts`, journal entries |
| Get paid | Create a payment link: amount + who owes you + optional note; shows the link with Copy and Share (Web Share API, falls back to copy); list of open and paid links with status and expiry | `lib/payment-requests.js` `createPaymentRequest`, `pages/pay/[code].js` already serves the link |
| Top up | Card (PayFast deposit, existing hosted flow, returns to `/app`), and voucher load only where `VAS_LIVE_*` says live; otherwise a "Coming soon" tile | existing deposit route and PayFast return handling |
| Send | To a WaPay member by cell number (free, instant); non-member: held with the 30-day refund rule, membership-neutral copy; step-up PIN entry before the move | `sendMoney` in the ledger send path (67024ce), `issuePinProof` |
| Pay out | Saved destinations first (labels only, never full numbers), or new details by method (PayShap, RTC, CashSend, Nedbank cash, FNB eWallet); fee and total shown before confirm; PIN step-up; the pay-out rules (new-account daily cap, KYC thresholds) answered with the chat's own copy; KYC required → a Didit session link opened in the same browser, with the pending pay-out resumed after VERIFIED | `requestPayout`, `quotePayout`, `checkPayoutRules`, `lib/payout-beneficiaries.js`, `lib/didit-kyc.js`, `lib/kyc-resume.js` |
| Activity | All money in and out with running labels (link paid, top-up, send, pay-out, fee, refund), newest first, 50 per page | journal entries + provider requests |
| Profile | Name, language, KYC status with a Verify button, saved pay-out destinations (label, remove), referral link with Copy, Change PIN, Log out | `lib/referrals.js`, `forgetPayoutDetails`, `setPayoutDestinationNickname` |
| Coming soon | Airtime, Data, Electricity, Fuel, In-store, Vouchers as greyed tiles with "Coming soon" (never a date), read from the capability registry / `VAS_LIVE_*` so they light up by env, not by deploy | capability registry |
| Help | One page: what the portal can do, "WhatsApp replies paused" explanation, support e-mail, and the pay-link safety line ("WaPay never asks for your PIN by message") | — |

**Non-goals v1:** no new money logic (every rand moves through the existing libraries), no admin
or business features, no push notifications, no dark mode, no native app, no new templates.

## Design (Revolut-like, simpler)

- Single column, phone-first (390 px), centred at 420 px on desktop with a soft grey page
  behind; 16 px gutters; cards with 16 px radius; brand green `#359853` for primary actions and
  positive amounts, near-black text `#111827`, grey `#6B7280`, surface white, page `#F4F6F8`;
  Inter (Google Fonts) with the system fallback; the Lovable W-mark as the logo (never a bubble).
- Home: greeting + logo row, the balance card (big number, two small lines), a 4-chip row of
  quick actions with simple line icons, the status banner (only when WhatsApp is paused), then
  "Recent" list rows (icon, title, sub-line, amount right-aligned, green for in, dark for out).
- Bottom navigation with four items: Home, Pay (get paid / send / pay out), Activity, Profile.
- Forms: one question per screen on mobile (amount first, large; then who; then confirm), a
  sticky primary button, inline validation, never a modal for money.
- Confirm screens always show: amount, fee, total, destination label, and the PIN field last.
- Copy is the chat's own copy wherever a rule applies (daily cap, KYC, non-member hold) so the
  two surfaces never disagree. The prototype at `docs/briefs/personal-portal/prototype.html`
  shows every screen; build to it, improving it where a real screen needs more.

## Security and rules (binding)

- The PIN is verified only by `@wapay/auth` `verifyPIN`; it is never logged, never in a URL,
  never compared in a new way. Lockouts follow the business portal's constants.
- Every money route (`send`, `payout`, `link create`) requires the session AND a fresh PIN proof
  (`issuePinProof` from a PIN re-entry, 2-minute TTL), checked server-side exactly as the chat.
- Identity and destination secrets are read at the moment of use (`load…Secret`), never cached,
  never returned to the browser beyond last digits.
- The golden thread holds: no customer data reaches any model; nothing here calls `packages/ai`.
- Audit rows for `APP_LOGIN`, `APP_PIN_RESET`, `APP_PAYOUT`, `APP_SEND`, `APP_LINK_CREATED`.
- Rate limit every POST by IP and by account; `GET` pages render nothing sensitive before login.
- Do not touch `pages/api/webhooks/*`, the processor, the onboarding package or any chat copy.
- Never run the chat harness (`pnpm qa:chat`) and never run two database tools at once: the
  session pooler allows 15 clients (memory: shared-db-pooler-and-qa-numbers).

## Acceptance

1. `node --test tests/*.test.mjs` green, including new tests: login (success, wrong PIN,
   lockout), forgot PIN (ID match, mismatch, no identity), each API route (happy path and every
   refusal: no session, no proof, rules, frozen), the money routes never reachable without proof.
2. `pnpm build` green.
3. Opened in a browser at phone width: login → home → create a link → share → pay out dry path
   to the confirm screen (no real money in testing; use the founder's account `cmi7t758h000dnf0ndpexchob`
   only with `dryRun` style stubs, never a live rail call from tests).
4. Docs: `docs/CAPABILITIES.md` row, `docs/CHANGELOG.md` entry (next number), a run sheet at
   `docs/testing/personal-portal-2026-10-21.md` (how to test on a phone, what is stubbed).
5. Work on branch `feat/personal-portal` in the worktree; commit with the attribution line;
   do not push; report: file list, how to test, what was left out and why.
