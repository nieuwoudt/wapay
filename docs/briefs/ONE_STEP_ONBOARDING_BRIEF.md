# One-step sign-up, deferred PIN, payer pre-registration — build brief (2026-10-22)

**Why.** Of 739 ad arrivals since 18 October, 177 never answered the welcome, 79 stopped at the
PIN step and 32 at the consent step (15% lost at those two steps alone; 61% finished). Sign-up
today is: welcome → name → PIN → consent → active. The founder wants: terms accepted by
continuing, no PIN until money moves, and every payer of a link invited into an account by the
receipt they already get. All three ship **behind flags, default OFF**, so the founder can turn
them on for his own number first, then for everyone, and conversion can be compared before/after.

## A. One-step sign-up (`WAPAY_ONBOARDING_ONE_STEP=on`)

- On the first message from an unknown number (and on the ad arrival path in `lib/ad-flow.js`),
  create the account and move it straight to `S5_COMPLETED`: no name step (use the WhatsApp
  profile name from the webhook contact; editable later via settings), no PIN step, no consent
  step. The existing per-number allowlist helper pattern (see `WAPAY_AGENT_V3_MSISDNS` /
  `VAS_ALLOWLIST_*` in `lib/launch-scope.js` or similar) must let the flag be "on for these
  numbers" as well as "on": `WAPAY_ONBOARDING_ONE_STEP=on` or a comma list of MSISDNs.
- **Consent by continuing, with evidence.** The first reply ends with one short line: "By using
  WaPay you agree to our Terms & Privacy Policy: https://wapay.co.za/legal/terms". Record it:
  `packages/auth/src/consent.ts` already stores consents with a `version`; write a consent row
  of type (or note) `IMPLIED_BY_USE` with the terms version, the inbound `waMessageId` and the
  time, plus an `auditLog` row `CONSENT_IMPLIED`. Never ask for "I accept" on this path.
- The first reply must be ONE message (policy: one reply per customer message; see
  `docs/WHATSAPP_POLICY_COMPLIANCE.md`): the welcome + "Who owes you, and how much?" (ad path,
  `lib/ad-flow.js` has the wording) or the home card for a non-ad arrival, with the terms line
  appended. No template on this path (MARKETING templates are already off; see
  `marketingTemplatesEnabled()` in `packages/auth/src/onboarding.ts`).
- Existing accounts in S1–S4 keep the old path unless the flag is on, in which case the next
  message completes them the same way (consent implied, PIN deferred).

## B. Deferred PIN (`WAPAY_PIN_ON_DEMAND=on`, same on/list shape)

- A PIN is required only for: pay-out (`startWithdraw` in `lib/payout-chat.js`), send to another
  person (the ledger send path, `sendMoney`), PIN-protected settings, and the web portal login
  (`lib/app-login.js`). Getting paid, creating links, balance, transactions never need one.
- When one of those starts and the account has no PIN (`verifyPIN` answers `PIN_NOT_SET`,
  `packages/auth/src/pin.ts`), run the PIN-creation sub-flow inline: "Choose a 4-digit PIN to
  protect your pay-outs" → confirm → continue the interrupted action in the same turn where
  possible (the pay-out flow keeps its pending data the way `lib/kyc-resume.js` keeps a pending
  withdraw). Reuse the PIN-setting code of `handleS3OtpVerified`/`handleS4PinSet`; do not write a
  second PIN store or a second verifier.
- Web portal: an account without a PIN gets, at login, "Set your WaPay PIN in the WhatsApp chat
  first (say *PIN*), then log in here." Setting a PIN on the web without the phone is not allowed.
- The agent path (`packages/ai/src/prompt.ts` rules) and the capability registry
  (`lib/capabilities.js`) must describe the PIN as "set when you first pay out or send", never
  as a sign-up step, when the flag is on.

## C. Payer pre-registration and the receipt reply (`WAPAY_PAYER_PREREGISTER=on`)

- When a link is paid (`lib/request-notify.js`, the payer receipt path with `payerNotifiedAt`),
  and the payer's number has no account: create the account record in `S0_INITIAL` with
  `profile.origin = { kind: 'PAYER', requestCode, paidAt }` so their history exists when they
  ever write. No message beyond the receipt they already get. POPIA note in the code comment:
  the number was given for the receipt; it is used for nothing else until they write to us.
- The receipt template: do NOT change `wapay_payment_receipt` in place. Specify a new UTILITY
  template `wapay_payment_receipt_v2` in `docs/templates/wapay_payment_receipt_v2.md` (body:
  the payment confirmation with the amount and the requester's first name; one neutral closing
  line "Reply to this message to see your receipt and your options."; one quick-reply button
  "My receipt"). The founder or the main session creates it through
  `POST /api/internal/template-create` (UTILITY only); the code sends it when
  `WAPAY_TEMPLATE_PAYMENT_RECEIPT_V2` is set, else the current template. Keep the template free
  of promotional words: a utility template that sells gets reclassified as marketing.
- The payer's tap on the button arrives as a button reply (`interactive.button_reply`) in the
  webhook: the processor must treat it as the payer's first message → one-step sign-up (A), with
  the first reply showing the receipt ("You paid R250 to Thandi on 22 Oct, reference …") and the
  home card in ONE message.

## D. Conversion tracking (always on, no flag)

- `GET /api/internal/funnel?since=YYYY-MM-DD&until=YYYY-MM-DD` (internal key): per day,
  accounts opened, finished sign-up, finished within 10 minutes, first link created within 24 h,
  first link paid within 72 h, pay-out within 72 h, and whether the one-step flag was on for that
  day (read from the per-account `profile.onboarding.path = 'ONE_STEP' | 'CLASSIC'`, which A must
  stamp at creation). Also a `summary` for the whole window with the same rates.
- Mission Control Growth tab (`pages/admin/index.js`): a "Sign-up funnel" card showing those
  rates by day with the path split, using the existing chart components in `lib/admin-charts.js`.
- The nightly audit (`lib/audit/*`) adds one line with yesterday's finished-rate by path.

## Rules (binding)

- Every change behind its flag; with all flags unset, behaviour and copy are byte-identical to
  today (the chat harness `pnpm qa:chat` must pass unchanged; add scenarios for the flagged paths
  and run the harness ONCE at the end with `WAPAY_SEND_CAP=50`, never two database tools at once,
  the pooler allows 15 clients — tell the main session in your report when you ran it).
- One reply per customer message everywhere. WaPay never starts a conversation. No new templates
  other than the receipt v2 spec. The golden thread holds (no customer data to any model).
- Do not touch `pages/api/webhooks/didit.js`, `lib/ops-*.js`, the portal's money routes beyond
  the "no PIN yet" line, or the pay page (`pages/pay/[code].js`, being changed by the main session).
- Tests: `node --test tests/*.test.mjs` green with new tests for A (consent row + audit row +
  profile stamp + the one-message reply), B (each gate asks for a PIN once, then continues; web
  login line), C (pre-registration creates S0 with origin; button reply routes to sign-up; v2
  template used only when the env is set), D (funnel maths on fixture data). `pnpm build` green.
- Docs: `docs/ONBOARDING.md` section for the flags; `docs/CHANGELOG.md` next number;
  `docs/testing/one-step-onboarding-2026-10-22.md`: the founder's end-to-end test script on his
  own phone (turn the flags on for his number, delete/park his test account or use a second
  number, the exact messages to send, what he should see at each step, how to read the funnel
  endpoint and the Growth card before and after).

## Where to work

Canonical repo: "/Users/nieuwoudtgresse/Library/Mobile Documents/com~apple~CloudDocs/Desktop/WaPay /WaPay V1.01"
(trailing space in the parent folder: always quote). Worktree: `git -C "<repo>" worktree add
"$HOME/Projects/wapay-onboarding" -b feat/one-step-onboarding`; copy `~/Projects/wapay/.env`
there; `pnpm install --frozen-lockfile` there (never in iCloud). Commit on the branch with the
line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; do not push; report commit
hashes, file list, test/build/harness output lines, the founder's test script path, and what
was left out and why. Keep customer data out of the report.
