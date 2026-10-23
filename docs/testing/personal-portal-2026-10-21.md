# Personal web portal: run sheet (2026-10-21)

The portal is the customer's own money on the web while WhatsApp replies are restricted
(brief `docs/briefs/PERSONAL_PORTAL_BRIEF.md`). It lives at `/app` on every host of the app.
Built on branch `feat/personal-portal`; **not pushed and not deployed**.

## 1. Before a phone test

Switches it reads in Vercel (names only):

| Variable | Needed for | Default when unset |
|---|---|---|
| `WAPAY_APP_SESSION_SECRET` (16+ characters) | signing in at all | falls back to `WAPAY_BUSINESS_SESSION_SECRET`, then `WAPAY_ADMIN_SESSION_SECRET`; with none of the three the portal answers "not switched on yet" |
| `WAPAY_PIN_PROOF_SECRET` (already set for the chat) | every money action | without it a correct PIN approves nothing ("Payments cannot be confirmed right now") |
| `WAPAY_PII_KEY` (already set) | saved pay-out details, the ID on file, forgot PIN | without it nothing is saved and forgot PIN has nothing to compare |
| `PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY`, `PAYFAST_PASSPHRASE`, `APP_BASE_URL` | top up by card | top-up says it is not available |
| `WAPAY_PAYOUT_ENABLED`, `OTT_PAYOUT_*`, `WAPAY_PAYOUT_KYC` and the rule envs | pay out | the pay-out screen says it is not switched on |
| `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID`, `DIDIT_WEBHOOK_SECRET` | the identity check | the rule line says the check is being switched on |
| `WAPAY_APP_WHATSAPP_PAUSED=off` | hides the "WhatsApp replies are paused" banner | banner shown |
| `WAPAY_APP_BANNER` | replaces the banner text | the brief's text |
| `WAPAY_SUPPORT_EMAIL` | the support address on Help, Profile and forgot PIN | `help@wapay.co.za` (check that this mailbox exists) |
| `WAPAY_APP_HOST` (for example `app.wapay.co.za`, once the domain is attached) | that domain's bare root opens `/app` | nothing changes |

`GET /api/internal/flags` (internal key) now carries `app: { configured, host, whatsappPausedBanner, supportEmail }`.

## 2. How the founder tests it on a phone

On the deployment (a preview of the branch, or production once merged), open
`https://<host>/app` on the phone. Use **your own WaPay account** with your real PIN: the portal
is your live balance, so every money step below is real money unless you stop at the confirm
screen.

1. **Log in**: your cell number and your WaPay PIN. A wrong PIN says "That cell number and PIN do
   not match a WaPay account" (the same for a number that is not on WaPay). Careful: wrong PINs
   count on the same counter as the chat. Five wrong in 15 minutes lock both the web and the chat
   PIN for 15 minutes; the web never goes past 8 wrong.
2. **Home**: the balance must equal the chat's (spend + cash), the banner shows, the last five
   movements, and the coming-soon tiles (airtime, data, electricity, fuel, in-store, vouchers).
3. **Get paid**: R10 (under R50 is free), a name for yourself, optional "For"; confirm with the
   PIN; Share opens the phone's share sheet (WhatsApp, SMS); Copy copies the link. Open the link:
   the pay page is the usual `pleasepayme.co.za/PR…`. Cancel it from "Your links" afterwards, or
   pay it by card to see "Link paid" land in Activity.
4. **Top up**: an amount shows amount + fee = what the card is charged; "Pay … by card or EFT"
   goes to PayFast and comes back to `/app/top-up`, which waits for the ITN and says when it
   landed. Cancel on PayFast to see "nothing was charged".
5. **Send**: amount, then a number, then the confirm (the words are the same whether or not the
   number is on WaPay). Stop at the PIN, or send R10 to a second phone you hold.
6. **Pay out**: a saved destination (labels only) or new details by method; the amount screen
   offers "Everything"; the confirm shows amount, fee, total, destination, name, ID (last three)
   and the PIN last. Stop there, or pay out the minimum to your own account. Rules (new-account
   cap, KYC thresholds, freeze) answer in the chat's words.
7. **Profile**: KYC status with Verify, saved details with Remove, "Get my link" for the invite,
   Change PIN (the chat then uses the new PIN too), Log out.
8. **Forgot PIN** (only if you are ready to wait 24 hours for new pay-out destinations): from the
   log-in screen, your cell number and the whole ID number you gave for pay-outs, then a new PIN
   twice. Afterwards, for 24 hours, pay-outs go only to destinations saved before, and the web
   will not send to other people. An account with no ID on file gets the same answer as a wrong
   ID, with the support e-mail.

The founder's account id for an operator dry run is `cmi7t758h000dnf0ndpexchob`; nothing in the
portal or its tests used it.

## 3. What is stubbed, and where

- **Tests** (`tests/app-portal.test.mjs`, 39 tests): every route runs against the in-memory
  database of `lib/app-dev-fixture.js`; `verifyPIN`, `requestPayout`, `sendMoney`,
  `createPaymentRequest`, the Didit session and the deposit intent are spies; proofs are real
  (`issuePinProof` / `verifyPinProof` under a test secret). No database and no rail are touched.
- **Local click-through without a database**: run `next dev` with
  `WAPAY_APP_DEV_FIXTURE=1`, a session secret and a dead `DATABASE_URL`, for example

  ```sh
  DATABASE_URL='postgresql://fixture:fixture@127.0.0.1:9/fixture' WAPAY_APP_DEV_FIXTURE=1 \
  WAPAY_APP_SESSION_SECRET='<any 16+ characters>' PAYFAST_MERCHANT_ID=fixture PAYFAST_MERCHANT_KEY=fixture \
  ./node_modules/.bin/next dev -p 3021
  ```

  then log in at `http://localhost:3021/app/login` with cell **060 000 0919**, PIN **2580** (an
  account that exists only in that process's memory; the login page shows the hint). The pay-out
  rail, sends, top-ups (they "pay" at once and come back) and the identity check are fakes. The
  fixture can never run in production: it needs `NODE_ENV=development` and no Vercel variable.

## 4. The manual pass of 2026-10-21 (fixture, phone width)

Run on the fixture above in the Browser pane at 390 x 844 (and 375 x 812), Chromium:

- `/app` with a stale cookie went to `/app/login?next=/app`. A wrong PIN showed the neutral
  answer and cleared the boxes; the right PIN opened Home.
- Home: R2,904.20 available (spend R2,904.20, cash R0.00), "Verify ID to lift limits", the four
  quick actions, the amber banner, five recent rows (link paid with the card fee, top-up, pay-out
  with its fee as its own row), six coming-soon tiles, the PIN safety line. Matches the prototype.
- Get paid: R150 typed, "Test Friend", confirm showed R150.00 from a balance and R141.40 by card
  (R8.60 fee), 7 days, "Ask for R159 instead"; the PIN boxes grew a fifth box after four digits;
  "Create link" made `pleasepayme.co.za/PR…`; Share fell back to copy ("Copied. Paste it into a
  chat or SMS."; this browser has no Web Share API); the new link sat first in "Your links".
- Pay out, saved destination: "Everything" gave R2,896 + R8 fee = R2,904, to "Mine: TymeBank
  account •••595 · PayShap", name, ID •••083 (saved), balance after R0.20, PIN last. On the fixture
  the confirm went on to "On its way" with the reference, no time promised, and Activity showed the
  pay-out in progress (grey, "held from your balance") with its fee.
- Pay out, new details: cash at a Nedbank ATM to my own number; R120 was refused in the chat's
  words ("ATMs give R50 and R100 notes…"); R100 confirmed as R100 + R18 = R118 to "Cellphone
  •••0919 · Nedbank cash", save box unticked, PIN last. Stopped at the confirm.
- Send: R100 to a fake number; the confirm read the membership-neutral line, fee R0.00, the
  number spaced, PIN last. Stopped at the confirm.
- Top up: R200 + R11 fee = R211; the fixture's checkout came straight back and the page said
  "R200 is in your balance". Voucher tile: coming soon.
- Forgot PIN: a wrong ID number got the single neutral answer naming help@wapay.co.za; the
  fixture's ID opened the new-PIN step; after saving, the cool-off line, then Home signed in.
  Pay out then offered only the saved destination with the chat's cool-off line, and Send refused
  with the web cool-off line.
- Desktop at 1280 px: the column is 420 px wide and centred, the bottom bar too. At 320 px no
  screen scrolls sideways.

Note for anyone repeating this in the Browser pane: when the pane is hidden the page gets no
animation frames, and `next dev` waits for one before it hydrates, so pages look stuck on the
spinner. Show the pane (or use a production build) and it carries on.

## 5. Left out of v1 (and why)

- Buying airtime, data, electricity, fuel or vouchers on the web: the brief keeps them as tiles;
  a live tile says "In the WaPay chat".
- Cash or voucher top-ups on the web: the tile follows `VAS_LIVE_*` and says where it works.
- A payer-side "pay someone's link from my balance" on the web: the pay page already handles it.
- Notifications of any kind (WaPay never starts a conversation; the restriction blocks them).
- Admin views of web sessions: logins and every action are in `audit_log` (`APP_*` events).
