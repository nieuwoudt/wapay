# The app's landing screen and its install: run sheet (2026-11-24)

Piece 1 of the apps work (brief `docs/prompting/prompts/2026-11-24-app-landing-and-install.md`,
picture `docs/briefs/app-landing/mock.html`, CHANGELOG 151). Built on branch
`feat/app-landing-install`. **Not merged, not pushed, not deployed.** Nothing below is live.

## 1. What changed for a customer

- `/app` is one screen for everyone: the W-mark, a greeting, a message box, the pill menu
  (Chat, Pay, Activity, Profile).
- A member sees "Good morning, <first name>", the balance as a chip (the eye button hides it), and
  chips to Get paid, Send, Pay out, Top up and My links. Typing "balance", "recent", "my links"
  shows a card in the thread; "pay out", "top up", "send", "get paid", "help" open their screens.
- Someone not signed in sees what WaPay does and four chips: Open an account (their own WhatsApp
  opens with a message ready), Pay a link, What is WaPay?, Log in. Typing a cell number opens the
  log-in step. Pay, Activity and Profile are greyed and say "Log in or open your account first."
- A PIN, an ID number or an account number typed in the message box is shown as dots, answered
  with one fixed line, and sent nowhere.
- The whole app follows the phone's dark or light setting.
- The app can be added to the home screen and then opens full screen. With no connection it
  shows an offline screen and no balance.

Nothing here calls a model, sends a WhatsApp message or moves money in a new way. No new
environment variable is needed.

## 2. Run it locally on the fixture (no database, no real account)

From a checkout of the branch with dependencies installed (`pnpm install`, `pnpm build:packages`):

```sh
DATABASE_URL='postgresql://fixture:fixture@127.0.0.1:9/fixture' WAPAY_APP_DEV_FIXTURE=1 \
WAPAY_APP_SESSION_SECRET='<any 16+ characters>' PAYFAST_MERCHANT_ID=fixture PAYFAST_MERCHANT_KEY=fixture \
./node_modules/.bin/next dev -p 3021
```

Open `http://localhost:3021/app`. The log-in step shows the fixture's cell number and PIN (an
account that exists only in that process's memory). The service worker is registered only in a
production build, so a development server never serves a stale page; to see the offline screen run
`next build && next start`, load `/app`, then stop the server and reload.

## 3. The pass of 2026-11-24 (fixture, Chromium, 375 x 812 and 390 x 844, light and dark)

Screenshots are in `docs/testing/app-landing-2026-11-24/`.

| What was done | What was seen |
|---|---|
| `/app`, not signed in, light | The mark, "Welcome to WaPay", the one line, four chips, "Your cell number", the pill menu with three items greyed (`01`) |
| Tapped "What is WaPay?"; typed a PIN-shaped line | The ad flow's answer with an Open WhatsApp button; the typed line shown as dots and answered with the fixed line; the network log shows only the two GETs made on load (`02`) |
| Typed the fixture's cell number | The log-in step with the number filled in and the PIN boxes focused, forgot PIN, "New to WaPay?", the PIN safety line (`03`) |
| Typed the PIN in the PIN boxes, Log in | The member screen: "Good afternoon, Demo", the balance chip, five chips, "Ask WaPay anything", the whole menu live (`04`) |
| Tapped the balance chip; typed "my links", "can I buy airtime?", "what is the weather" | The balance card with spend and cash and the ID nudge, the last five movements; the open link; "Airtime: coming soon."; the fallback line (`05`) |
| Phone set to dark | The same screens on the dark set (`06`, `07`) |
| Every other page in dark: pay, get paid, send, pay out, top up, links, activity, profile, help, forgot PIN | All readable; cards, fields, PIN boxes, pills and notices on the dark set (`08`, `09`); light unchanged from before (`10`) |
| The eye button | The chip reads "Available ••••"; still hidden after a reload; the browser's storage holds that one choice and nothing else |
| Menu, Log out; tapped a greyed menu item | Back to the visitor screen; "Log in or open your account first." with the two buttons |
| Opened `/app/pay-out` signed out | Sent to `/app/login?next=/app/pay-out`: the same screen with the log-in step open; after log-in, the pay-out screen |

Automated: `node --test tests/*.test.mjs` 1,598 pass, 0 fail (1,586 before, 12 new in
`tests/app-landing.test.mjs`); `next build` passes.

Not covered by this pass: a real phone, an installed app, a production build's service worker.
Those are section 4.

## 4. The founder's phone checks (only a real phone and a real account can do these)

Do them on a build of this branch that the phone can reach, before it is merged. Every money
step is real money: stop at the confirm screen unless you mean it.

1. **Install on Android (Chrome):** open `/app`, log in, and take the "Add WaPay to your home
   screen" offer (or Chrome's menu, Add to Home screen). Open it from the icon: full screen, no
   address bar, the W-mark icon on white.
2. **Install on iPhone (Safari):** open `/app`, log in, follow the hint (Share, then Add to Home
   Screen). Open it from the icon: full screen.
3. **Dark and light:** switch the phone's setting; the app follows on the next open.
4. **Top up from the installed app:** Top up, a small amount, pay on PayFast, and watch where the
   phone lands afterwards. Expected: `/app/top-up` saying the money is in your balance. If the
   phone returns in its browser and not in the installed app, note it: the balance is right
   either way, and the note decides whether the return needs work.
5. **The ID check from the installed app:** Profile, Verify, and after Didit note where the phone
   lands. Same expectation and the same note.
6. **Offline:** switch on flight mode and open the installed app. Expected: "You are offline",
   no balance. Switch flight mode off and tap Try again.
7. **Keyboard:** on both phones tap the message box and check that the box stays visible above
   the keyboard while you type.
8. **A session that has ended:** leave the app a day (or change your PIN in the chat), open Pay
   out from the menu: the log-in step opens, and after the PIN you are on Pay out.

## 5. Left out of this piece (and where it goes)

- Sign-up on the web: one tap on WhatsApp to prove the number, a first PIN on the web. Piece 2,
  with its own brief and review, because it is a new way into an account and changes golden-thread
  rule 2.14. Until then "Open an account" opens the person's own WhatsApp.
- The Pay agent behind the message box, and the A2UI catalogue: pieces 3 and 4. Until then the box
  understands a fixed list, and says so honestly for anything else.
- Scanning a QR code, picking a contact, recorded voice, filling in an amount from a sentence.
- An idle lock, Face ID or fingerprint, notifications, other languages: not yet decided.
