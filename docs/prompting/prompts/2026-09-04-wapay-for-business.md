# Build: WaPay for Business (business portal + payment-link CRM)

**Effort:** high · **Session type:** autonomous build · **Repo:** WaPay (`~/Projects/wapay` fast copy; canonical iCloud `…/Desktop/WaPay /WaPay V1.01`)

*Formatted 2026-09-04 from the founder's spoken brief using `docs/prompting/FEATURE_PROMPT_TEMPLATE.md`. This is the prompt the build session ran.*

## Goal

Small businesses that already run on WhatsApp (the founder's local laundry is the design partner) register a WaPay for Business account, sign in to a business portal, keep their customer list there, and send each customer a "please pay me" link for what they bought. Every payment lands in the business owner's existing WaPay wallet with the same wallet features as any customer. The portal shows, per customer, who they are, when they joined, what they bought, what they paid and what is still outstanding; and, per business, all customers, all payments, outstanding links, and revenue by month over the last 3, 6 and 12 months. It replaces the laundry's current provider, where every customer's payment links must be reconciled by hand. Think POS-plus-CRM, sleek and modern: mirror-finish surfaces, rounded cards, high contrast.

## Hard constraints (never violate)

- `CLAUDE.md` invariants: all money via `postEntry`, integer cents, deterministic idemKeys; the existing payment-request rail (`lib/payment-requests.js`, `pages/pay/[code].js`, `pages/api/pay/checkout.js`, `pages/api/payfast/itn.js`) is the money path. Do not build a second one.
- Receiver pays the card fee, payer pays exactly the displayed amount (no surcharging in SA). Free under R50, free from a WaPay balance. Quote fee and net at composition.
- Cross-user rule: WaPay must never push a message to a stranger on a business's say-so. The default send path is the business's OWN WhatsApp (wa.me deep link with the prefilled message). Any WaPay-originated nudge is relationship-gated (prior paid relationship), informational-only, sanitised business name, rate-limited, env-flagged.
- Meta policy: no betting or cash-out language anywhere; out-of-window sends need a template or Direct Send (BUGLOG #33).
- Build on the existing stack and the admin console patterns (`lib/admin-auth.js`, `pages/admin/index.js`, `pages/api/admin/*`, hand-rolled SVG charts). Don't modify existing surfaces beyond the additive touches listed in Scope. 509/509 tests must stay green, `pnpm build` green.
- Secrets: never log OTP codes, session tokens, passwords or voucher PINs.

## Scope

**In:**
- Business registration and login at `/business` (host-gated like `/admin` via `WAPAY_BUSINESS_HOST`): owner's WaPay WhatsApp number + OTP (template push, or "business login" typed to WaPay from the phone), business name, optional password for computer logins.
- Customer list: add manually, import (paste CSV or vCard), auto-capture from paid links. Search, sort by spend, tags/notes.
- Customer profile: name, number, joined date, source, lifetime spend, count, average, last paid, spend over time, outstanding links, full payment-link history with line items and status.
- Payment links per customer from a POS-style composer: line items (name, qty, unit price) with a recent-items memory, reference, note, expiry up to 30 days, fee/net quote. "Send on WhatsApp" opens the business's own WhatsApp with the message prefilled; "Copy link"; mark as sent; cancel.
- Business dashboard: revenue paid (period), outstanding (count + value), customers (total, new), average ticket, payment-method split, fees, revenue by month (12 months) and 3/6/12-month totals, top customers, recent payments.
- CSV export of payments for reconciliation.
- Pay page shows the business name, line items and reference for business links. Paid notification to the owner names the customer and reference.
- Activation docs, CAPABILITIES row, CHANGELOG, tracker delta, memory note.

**Out (report as follow-ups):**
- Importing contacts through the WhatsApp Cloud API (it has no contact-list endpoint). Connecting a business's own WABA via Embedded Signup. Multi-user staff logins. Refunds. Recurring invoices. Restyling the existing admin console.

**Assumptions to state in the summary:**
- One business per WaPay account; the business's wallet IS the owner's SPEND wallet.
- "business.whatsapp.00" means a business subdomain of our platform, implemented as `WAPAY_BUSINESS_HOST` (e.g. `business.wapay.co.za`), unset = reachable on every host during setup.
- Link amount limits stay R5–R3000 (no-KYC exposure cap).

## Acceptance

- [ ] `/business` renders login/registration; a registered owner reaches Overview, Customers, Payment links, Settings.
- [ ] Creating a link for a customer produces a `pleasepayme.co.za/PRXXXXXX` URL, a wa.me deep link, and a fee/net quote; the pay page shows the business name and items.
- [ ] A paid link (card or balance) shows PAID in the customer profile and counts in revenue; outstanding drops.
- [ ] `node --test tests/*.test.mjs` green including the new `tests/business-portal.test.mjs`; `pnpm build` green.
- [ ] No processor change beyond the narrow "business login" hook, statically tested.
- [ ] Docs + activation envs written; tracker handover entry added.

## Working style (Fable 5.1)

You are operating autonomously. The user is not watching in real time and cannot answer questions mid-task, so asking "Want me to…?" or "Shall I…?" will block the work. For reversible actions that follow from this brief, proceed without asking. Stop only for destructive actions or genuine scope changes. Before ending your turn, check your last paragraph: if it is a plan, a question or a promise, do that work now.

Before you start, say in a line what you're about to do; brief updates while you work help the user follow along. Close with a short recap that stands on its own.

If you find a pre-existing bug or behaviour the task doesn't mention, don't fix or extend it unless the requested behaviour cannot work without it; report it as a follow-up. Where the task is ambiguous, implement the reading its wording and the surrounding code most directly support, state that assumption, and don't build for the other readings as well.

Surgically edit files rather than rewriting them when the result is the same. Remove all mannered prose. Use lists only when the content is multifaceted.

Every review or verify subagent you spawn is READ-ONLY: it must not Edit or Write any repo file; it reports findings and proposes mutations.

First privately list what you need next; then request every item that doesn't depend on another's result in this one response.
