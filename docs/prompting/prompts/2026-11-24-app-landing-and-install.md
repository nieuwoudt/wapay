# Build: the installable WaPay app and its chat landing screen (apps piece 1)

**Effort:** high · **Session type:** autonomous build · **Model:** Claude Fable 5.2 · **Repo:** WaPay (`~/Projects/wapay` fast copy; canonical iCloud `…/Desktop/WaPay /WaPay V1.01`)

*Approved by the founder, 2026-11-24. Formatted that day from his decisions (an annotated screenshot and two rounds of answers) with `docs/prompting/FEATURE_PROMPT_TEMPLATE.md`. This is the prompt the build ran. The picture is `docs/briefs/app-landing/mock.html`; the plan behind it lives in the private workspace.*

## Goal (one paragraph)

Anyone who opens app.wapay.co.za on a phone, member or not, lands on one screen: the W-mark, a greeting, a message box and a pill menu. A member is greeted by name, sees their balance, and reaches every everyday job with one tap or a few typed words, answered at once by code. Someone who does not know WaPay yet is told what it does and can log in, pay a link, or go and open an account. The app can be added to the home screen, opens full screen, and follows the phone's dark or light setting. This is the fast, fixed layer the AI chat (a later piece) will sit behind. Nothing in this piece calls a model, and nothing in it moves money in a new way.

## Hard constraints (never violate)

- `CLAUDE.md` invariants and `docs/GOLDEN_THREAD.md` 2.13 hold unchanged. **No money path is touched.** The money pages (`get-paid`, `send`, `pay-out`, `top-up`), `pages/api/app/*` and `lib/app-money.js` change only where the shared Shell or stylesheet changes how they look. No new route moves money or issues a PIN proof.
- **A PIN is typed only into `PinField` and posted only to `/api/app/auth` or `/api/app/pin`.** The message box never takes one: input shaped like a PIN, an ID or passport number, or any run of 7 or more digits that is not a South African cell number is answered on the page with a fixed line and is never sent, stored or logged. Add this to the golden thread (an addendum to 2.13) with the test that fails the build.
- **No model call and no WhatsApp send.** A `wa.me` link that opens the person's own WhatsApp is allowed (the customer writes first). The structure tests in `tests/app-portal.test.mjs` and `tests/no-whatsapp-sends-in-api-routes.test.mjs` keep passing.
- **Log-in stays membership-neutral:** the same screen and the same answer for every number typed, through the existing `appLogin` and nothing else.
- **What a visitor reads is the ad flow's own truth,** never new wording: built on the server from `lib/ad-flow.js` (`CAN_DO`, the FAQ answers), `lib/fee-facts.js` and the capability registry, passed through `webLine()`. Every visitor string must pass `copyViolations` (so no "send money", "transfer", "withdraw", "cash out" or "banking"). "Coming soon" never with a date; no em dashes; no time promises.
- **Brand:** the real W-mark from `public/brand` and the `marketing/brand` masters. New icon sizes are cut from the masters the way `marketing/brand/make-real-kit.mjs` does it, never redrawn. Green `#359853`, Inter. Take the mock's layout; do not copy another product's type or colours.
- **Security headers** in `next.config.js` stay on every `/app` page. The service worker never handles or caches anything under `/api/`, and never stores a response that carries customer data. Offline, the app says it is offline and shows no balance.
- No new dependency and no framework: Next.js pages router, `components/app/kit.js`, a hand-written service worker.
- Do not break anything: `node --test tests/*.test.mjs` 100% green (1,586 at `b134a31`), `pnpm build` green, and the dev fixture (`WAPAY_APP_DEV_FIXTURE=1`) still walks every screen.

## Scope

**In:**

1. **The landing screen at `/app`, in two states** (the mock is the picture; the founder's choices are in the plan, section 6.9):
   - *Someone not signed in:* the W-mark, "Welcome to WaPay", one line on what it does; chips Open an account · Pay a link · What is WaPay? · Log in; the message box reads "Your cell number"; the pill menu shows Chat, with Pay, Activity and Profile greyed.
   - *A member:* the W-mark, "Good morning, <first name>" (afternoon and evening by South African time), the balance as a chip under the greeting with a hide button top right; chips Get paid · Send · Pay out · Top up · My links, each opening the existing page; the message box reads "Ask WaPay anything".
2. **The message box, answered by code.** One pure module (`lib/app-chat-router.js`) reads what was typed and returns what to do; the page does it.
   - A visitor: a cell number opens the log-in step; a pay link or a `PR` code opens `/pay/<code>`; what WaPay is, the fees, how to open an account and how to log in get the fixed answers.
   - A member: balance, recent activity and open links appear as cards in the thread, built from the existing `/api/app/home` and `/api/app/links`; get paid, send, pay out, top up, links, activity, profile and help open their pages; anything else gets one honest line naming what works today, with the chips.
3. **Log-in folded into the landing screen:** the cell number, then `PinField`, "Log in", "Forgot your PIN?" and "New to WaPay? Open an account". `/app/login` keeps working (old links, the 401 redirect, `?next=` through `safeNext`) by showing the same screen with the log-in step open. `/app/forgot-pin` is unchanged.
4. **The pill menu:** Chat · Pay · Activity · Profile in `components/app/Shell.js`. Links moves under Pay (the Pay page already lists it). The coming-soon tiles move from home to the Pay page.
5. **Dark and light for every `/app` page,** following the phone's setting: the stylesheet in `kit.js` moves its fixed colours to variables with a dark set; `theme-color` for both.
6. **Installable:** `public/manifest.webmanifest` (name, icons 192 and 512 plus a maskable one, `display: standalone`, start at `/app`); a service worker scoped to `/app` that keeps only the static shell and an offline screen; an "Add to home screen" prompt on Android and a one-screen instruction on iPhone, each dismissible; registration from the Shell.

**Out (report as follow-ups, do not build):**

- Sign-up on the web (one tap on WhatsApp to prove the number, a first PIN on the web, the change to golden-thread rule 2.14). That is piece 2, with its own brief and security review.
- The Pay agent behind the message box, and the A2UI catalogue. Pieces 3 and 4.
- Scanning a QR code, picking a contact, recorded voice, and filling in an amount or a number from a typed sentence.
- An idle lock, Face ID or fingerprint, notifications, other languages: the founder has not decided these.
- The look of `/pay`, `/business` and `/admin`.

**Assumptions to state in the summary (decide, do not ask):**

- "Open an account" in this piece opens the person's own WhatsApp chat with WaPay, a greeting ready to send. Piece 2 replaces it.
- A person who is not signed in and taps Pay, Activity or Profile reads "Log in or open your account first"; the items are not links.
- Greeting hours, South African time: morning 05:00 to 11:59, afternoon 12:00 to 17:59, evening otherwise. With no first name on file the greeting has no name.
- What home showed before is kept, moved: the spend and cash lines, a held amount, the ID-check nudge and the last five movements sit in the balance card that opens in the thread; open links are under Pay and "My links".
- The microphone button puts the cursor in the box and points at the keyboard's own dictation key; the page records no audio. The + button offers "Paste a pay link" only.
- The hide-balance choice and the dismissed install prompt are the only things kept in the browser's storage.

## Acceptance (how we know it is done)

- [ ] On the fixture at 375 and 390 px, in light and in dark: both landing states match the mock, and every existing `/app` page is readable in both themes. Screenshots go in the run sheet.
- [ ] A typed cell number opens the PIN step; the right PIN lands on the member state; a wrong PIN and an unknown number read the same; `?next=` is honoured; `/app/login` still works.
- [ ] The message box: a PIN-shaped or ID-shaped entry never leaves the page (a test asserts nothing is fetched); a pay link or `PR` code opens the pay page; each member intent reaches the right page or card; unknown input gets the fallback line.
- [ ] Every visitor string passes `copyViolations` (a test runs them all through it).
- [ ] The balance chip hides and shows, and the choice survives a reload.
- [ ] Chrome reports the app installable; Android offers the prompt; iPhone shows the instruction; the installed app opens `/app` full screen with the right theme colour; offline shows the offline screen and no balance.
- [ ] A static test locks that the service worker's source never handles `/api/`.
- [ ] The run sheet lists the phone checks only the founder can do: a card top-up and an ID check started from the installed app each return to a working screen, on iPhone and on Android.
- [ ] Tests added beside their neighbours. The navigation assertions in `tests/app-portal.test.mjs` (the Links tab, the home link) change in the same commit, and the other tests that read `/app` files as source (`tests/card-refund.test.mjs`, `tests/payout-express-triage.test.mjs`) still pass.
- [ ] `/fable-review` (security and conversation lenses, read-only reviewers) on the diff before any push; findings verified before they are acted on.
- [ ] Docs in the same commit: `docs/CAPABILITIES.md` (the portal row), `docs/CHANGELOG.md` (151), `docs/SYSTEM_ARCHITECTURE.md` (the portal subsystem: new files, the manifest, the worker), the golden-thread addendum, a run sheet `docs/testing/app-landing-<date>.md`, the tracker delta, `WAPAY_STATUS.md` version, the programme board items.
- [ ] Activation written down: no new environment variable is needed; say so. Say NOT LIVE first for anything committed and not pushed.

## Working style (Fable 5.2)

You are operating autonomously. The user is not watching in real time and cannot answer questions mid-task, so asking "Want me to…?" or "Shall I…?" will block the work. For reversible actions that follow from this brief, proceed without asking. Stop only for destructive actions or genuine scope changes. Before ending your turn, check your last paragraph: if it is a plan, a question or a promise, do that work now instead of ending the turn.

Before you start, say in a line what you're about to do; brief updates while you work help the user follow along. Close with a short recap that stands on its own.

If you find a pre-existing bug or behaviour the task doesn't mention, don't fix or extend it unless the requested behaviour cannot work without it; report it as a follow-up. Where the task is ambiguous, implement the reading its wording and the surrounding code most directly support, state that assumption, and don't build for the other readings as well.

Surgically edit files rather than rewriting them when the result is the same (`pages/app/index.js` is the one file a rewrite suits). Remove all mannered prose. Use lists only when the content is multifaceted.

Every review or verify subagent you spawn is READ-ONLY: it must not Edit or Write any repo file; it reports findings and proposes mutations.

Work in a git worktree of the iCloud repo or the fast copy, never `pnpm install` in iCloud, never `rsync --delete`. Check `ListAgents` and tell any live session what you will touch (`components/app/Shell.js`, `components/app/kit.js`, `tests/app-portal.test.mjs`) before you touch it. The repository is public: no customer number, no provider reference, no secret in code, tests, docs or commit messages.

First privately list what you need next; then request every item that doesn't depend on another's result in this one response.
