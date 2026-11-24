# Adversarial review: the app's landing screen and its install (2026-11-24)

Piece 1 of the apps work (brief `docs/prompting/prompts/2026-11-24-app-landing-and-install.md`,
CHANGELOG 151, branch `feat/app-landing-install`). Reviewed before any merge or push.

**How it was run.** Two read-only reviewers over the whole diff of the branch against `b134a31`,
each with the brief and the code and without the builder's conclusions: one on security (the
secret rule, the requests the screen makes, the return address, the service worker, the
headers), one on the conversation as a customer meets it (every chip and typed line, as a
visitor and as a member, on a phone). Reviewers changed no file. The lead checked every finding
against the code or by running the router, made every fix, and pinned each with a test that
fails on the old code (each guard was run against its fix undone before the commit).

**Counts.** 27 findings raised (26 distinct: the stale balance came from both reviewers), none
critical. As raised: 5 high (all usability), 11 medium, 11 low. 25 of the 26 were confirmed
against the code and fixed; the other (the Help page's wording) is older than this piece and is
listed for the founder. The reviewers also left eight notes: one fixed here (the missing
`nosniff`), one fixed outside this piece's own files (the Profile log-out), one that became a
test (the screen's written sentences against the word rules), three accepted with the reason,
and two older matters listed for the founder. The lead found two more faults in the router
while fixing.

**After the fixes:** suite 1,602 pass (1,599 before; `tests/app-landing.test.mjs` 13 to 16),
`next build` passes, and the changed screens were walked on the dev fixture at 390 x 844 and
390 x 600, light and dark. Commit `52d3acf`.

## Confirmed and fixed

| Sev | Finding | Fix | Guard (`tests/app-landing.test.mjs`) |
|---|---|---|---|
| MED (security) | **A failed log-out looked like a log-out.** The screen cleared itself whatever WaPay answered; on a dropped connection the session cookie lived on for up to 24 hours on a phone the person believed was signed out. | The answer is read first. A request that failed says "You are still logged in: the log-out did not reach WaPay" and changes nothing. The Profile screen's log-out had the same fault and has the same fix. | "money on the screen is read fresh, a failed log-out is not shown as one..." (both files; order of `if (!r.ok)` and the clearing) |
| MED (security) | **The offline screen said "Nothing has changed in your account."** The worker cannot know that: a payment may have gone through just before the connection dropped. | The line is gone. The screen says there is no connection and "If you were busy with a payment, look at Activity before you try it again." | "the service worker stores nothing..." (refuses any promise about the account); the run test reads the served page |
| HIGH | **A visitor who typed "Open my account" got the log-in step** ("my account" was read first). | Opening an account is read before logging in; "I don't have an account" (with or without the apostrophe), "sign up", "register", "join" all open one. | "a visitor: ..." |
| HIGH | **Answers landed off screen.** A new answer was added under a long thread, and the log-in step was always drawn last, so an answer could sit above it unseen. | The newest answer, or the log-in step, is scrolled to the top of what can be seen. Any step other than a cell number or "log in" puts the log-in step away. | "one screen for everyone..." (`scrollIntoView({ block: 'start' })`, `setLogin(null)`) |
| HIGH + LOW (both reviewers) | **A balance card could show an older figure**: it reused what the screen had loaded when it opened. | A card is drawn from a read made when it was asked for; a failed read says so and the older figure is dropped. Coming back to the app reads the balance again. | "money on the screen is read fresh..." (no `home ||`; `setHome(null)` on failure; the visibility read) |
| HIGH | **A pay code typed as a phone keyboard types it ("Prdemoef"), or inside a sentence ("pay PRDEMOEF"), was not a pay link.** For a member the second opened Send. | `payLinkCodeOf` reads the code in capitals anywhere in the line, and alone in any case, with a list of ordinary eight-letter words that start with "pr" so "problems" stays a word. | "a visitor: ..." and "a member: ..." |
| HIGH | **A visitor's question the screen did not understand got an answer that read as yes** (a bet, a loan, "is this a scam" all got the product pitch). | The fallback is one neutral line: what the screen can do, nothing about the question. A loan ask gets the ad flow's own "WaPay doesn't offer loans". "What is the weather" no longer gets the "what is WaPay" answer. | "the guide: ..." (fallback wording, loans); router tables (`unknown` cases) |
| MED | **"Where is my pay out" opened the pay-out form**, one tap from a second pay-out. | Status words ("where is", "when will", "arrived", "landed", "pending") show recent activity and are read before any action. A fee question about paying out is answered and opens nothing. | "a member: ..." |
| MED | **"Has Thandi paid", "did Sipho pay" were not understood.** | They show the links card. | "a member: ..." |
| MED | **Trouble words were too wide and too narrow**: "no problem" opened Help; "it didn't go through", "refund", "charged twice" did not. | One trouble rule with its exceptions ("no problem", "problem solved"); a member goes to Help, a visitor is given the support address on the screen. | both router tables |
| MED | **A mistyped cell number was scolded as a secret.** | A number typed where a cell number goes that is not one (too short, a landline, another country) is told so plainly. It is still shown as dots and sent nowhere. | "a number that is not a cell number is said so plainly..." |
| MED | **A visitor holding a pay link was sold an account.** | "I have a link", "someone sent me a link" ask for the link or its code. | "a visitor: ..." |
| MED | **No way back to the first view** once a thread had started. | "home", "menu", "back", "cancel" and pressing the Chat tab clear the thread and close the log-in step. | "one screen for everyone..." and the menu test (`onSame`) |
| MED | **No connection read as "not signed in"**, and a guide that failed to load left every answer as "could not load" for good. | A "No connection" notice with Try again; the guide is fetched again the next time it is needed. | "one screen for everyone..." |
| MED | **Hide balance hid the chip only**: the balance and activity cards still showed every amount. | Hidden means hidden in the cards too. A link's own amount stays, as on Your links. | "money on the screen is read fresh..." |
| LOW (security) | **The secret rule missed shapes**: "pin2580", "my pin is 2 5 8 0", full-width digits, digits of another script, a PIN typed beside a cell number, a secret typed beside a pay link. | `secretKind` rewritten: the line is folded (NFKC), digits of another script are never guessed at, a named PIN is caught however it is glued or spaced, a cell number is peeled off and the rest weighed. | "a PIN, an ID or passport number, or a long digit run is a secret..." (24 shapes) |
| LOW (security) | **The tests did not hold the file's own promises**: a request split over lines, an unchecked `router.replace`, a second use of the browser's storage, the clipboard's text or a console line would all have passed. | The tests now read every `api(` call whatever its line breaks, every address the screen can go to, every use of storage and of the clipboard's text, and refuse a console line. | "the landing screen posts only the log-in and the log-out..." |
| LOW (security) | **The return address** could be the log-in page itself, and was checked by a copy of the rule inside the component. | `safeNext` lives in `lib/app-chat-router.js`, the only copy, and maps the log-in page and anything that is not one of the app's own pages to `/app`. | "a return address after log-in..." (19 cases) |
| LOW | **Chat wording on the web**: "this phone", "three quick steps", the chat's own "Let's open your account" ending. | `guideLine` takes the chat-only parts off; the web says how an account is opened in its own line. | "the guide: ..." |
| LOW | **Accessibility**: the balance chip's fixed label hid the amount from a screen reader; the message box had no name; the menu claimed a role it did not behave as; greyed menu items were too faint. | Label only when hidden; the box is named by what it asks for; the role is gone; greyed items at 0.55. | "one screen for everyone..." |
| LOW | **Short screens** (a small phone, or the keyboard up): the hero pushed the chips under the message box. | Under 640 px of height the hero shrinks and the install hint hides; under 480 px the mark and the line go. | checked on the fixture at 390 x 600 |
| LOW | **The green "Open an account" chip** was 3.6 to 1 against its white text. | A stronger green for that chip (5.3 to 1). The brand green is unchanged everywhere else. | the colour test (a variable, both sets) |
| LOW | **"Not now" on the install hint was for ever.** | It puts the hint away for this visit; "Got it" and a finished prompt are remembered. | "one screen for everyone..." |
| LOW | **The manifest's bar colour** (green) did not match the pages' own (the page colour). | The manifest uses the page colour. | the manifest test |
| LOW | **Strings in the guide nothing could reach** (`login`). | Removed; the guide's keys are pinned. | "the guide route answers anyone..." |
| note (security) | The worker and the manifest were served without `nosniff`. | Added in `next.config.js`. | "the service worker stores nothing..." |

Found by the lead while fixing, not by a reviewer: "I dont have an account" (no apostrophe)
opened the log-in step, and "what is the weather" got the "what is WaPay" answer. Both are in
the router tables now.

A reviewer's note that became a test: nothing read the sentences written into the screen and
the offline page against the ad flow's word rules. One test does now, and it fails on a banned
phrase in either file.

## Accepted as they are

- **A bare four to six digits is read as a PIN even when the person meant an amount or a year**
  ("I was born in 1990"; the lead's own observation). The rule errs on the side of the secret;
  the cost is one line telling the person nothing was sent.
- **"Open an account" takes two taps**: the chip, then the Open WhatsApp button under one line
  that says what will happen. The second tap is the person's own, into their own WhatsApp.
- **The worker stores nothing at all**, where the brief allowed a cached shell. Stricter than
  asked: a page is always fetched from WaPay or the offline screen is shown.
- **The install hint is for members only.** A visitor is asked to open an account first.

## Older than this piece: for the founder, not changed here

- **`pages/app/help.js`** is one tap from the landing screen for someone who is not signed in,
  and its copy predates the word rules: "Send money", "cash at an ATM" without naming Nedbank
  and Absa, and a "Why WhatsApp is quiet" section from the October restriction.
- **The PIN boxes carry `autocomplete="current-password"`**, so a browser may offer to save the
  PIN. Good for a person's own phone, wrong for a shared one. A decision, not a bug.
- **`/api/app/auth` answers 423 "PIN is locked" only for a number that has an account**, which
  tells a stranger the number is a member. It needs its own fix and review: it is the sign-in.
- **A visitor asking "is this a scam" or "is it safe" has no approved answer** to be given; they
  get the neutral fallback. Wording is the founder's.
- **The visitor answers name PayShap and ATM cash** (the ad flow's own text) while every pay-out
  waits for approval. The ad flow says the same in the chat; whether it should is his call.

## The slide-over menu (added the same day on the founder's note, reviewed before the merge)

One read-only reviewer over the uncommitted change (`components/app/Drawer.js`, the landing
screen, the styles, the tests). Nothing high. Four medium and nine low points; all fixed but the
two listed last.

| Sev | Finding | Fix |
|---|---|---|
| MED | Closing the menu handed the keyboard back to whatever had it. On an iPhone that is often the message box, so the on-screen keyboard came back up. | The keyboard goes to the menu button, through a ref the screen passes in. |
| MED | The screen behind the open menu could still be reached by a screen reader. | While it is open everything behind it, the pill menu included, is `inert`. |
| MED | The visitor's row about airtime answered "Not yet, those are coming soon" with nothing above it for "those" to mean. | A question row shows its own label as the person's line first, and the rows are worded as questions. |
| MED | The menu's test pinned text, not behaviour. | It now checks that an item closes the menu and then acts, that every question row names a topic the guide has, that every address is a plain literal for one of the app's pages, and the order in which closing undoes things. It still reads source: rendering the component in a test needs a tool the repo does not have. |
| LOW | A greyed row tapped while the log-in step was open said its line above the step, out of sight. | The log-in step is put away first. |
| LOW | The menu took taps for a quarter of a second while sliding away (a double tap could act twice). | No taps unless open. |
| LOW | Dragging the shade or the end of the list scrolled the page behind. | Contained. |
| LOW | Close button 36 px; a faint focus ring; `role="dialog"` on an `aside`; the shade announced as a second close button; Escape only with the keyboard inside the panel; `aria-hidden` flipped with the keyboard still inside; a long tile note could collide with its label on a narrow phone. | 44 px; a green ring; a `div`; hidden from a screen reader; Escape from anywhere; no `aria-hidden` (closed is `visibility:hidden`); labels cut with an ellipsis. |

Left as it is: **the phone's Back button leaves the page with the menu open** instead of closing
the menu (doing it properly means writing to the browser's history beside the router; not worth
the risk on the day of a deploy). **A tile that is switched on** says "In the WaPay chat" and
offers a button to the person's own WhatsApp; nothing is bought in the web app.

## Not verified here

A real phone, an installed app, and the service worker in a real browser: the browser used for
the checks refuses to register any service worker, so the worker is covered by a test that runs
its code and by the founder's phone checks (`docs/testing/app-landing-2026-11-24.md` section 4).
