# WaPay cards: PayCentral now, Paymentology direct at scale: feasibility, architecture, onboarding

> **Current route (2026-10-16): PayCentral.** On the call of 2026-10-16 Paymentology said
> working with them directly needs a minimum of **30,000 cards**. They referred WaPay to
> **PayCentral**, a South African programme manager that runs on Paymentology's processing and
> serves smaller volumes. Section 0 is the plan for PayCentral. Sections 1 to 11 below are the
> Paymentology-direct analysis of 2026-10-15. That route needs 30,000 cards; keep it for when
> we get there. Its ledger, KYC, card-page and policy analysis still applies wherever section 0
> says so.

## 0. The PayCentral route (2026-10-16)

PayCentral's website, knowledgebase and API host (`paycentral.co.za`, `help.paycentral.co.za`,
`api.paycentral.co.za`) are refused by this session's network policy, like Paymentology's. So
this section rests on search extracts of their pages, their published fee pages and their
terms, and labels inference as inference.

### 0.1 Who PayCentral is

- **What they are.** A South African fintech (Rivonia, founded about 2016 per a data
  aggregator, unverified) that issues prepaid
  Mastercard cards to businesses for employee pay, expenses and incentives. They call themselves
  "the largest independent issuer of physical and virtual prepaid cards in South Africa", with
  more than 463,000 cards issued and over 1,000 business clients
  ([Paymentology client story](https://www.paymentology.com/client-story-paycentral),
  [paycentral.co.za](https://paycentral.co.za/)).
- **Issuer and processor.** Their platform terms name **Standard Bank** as the banking partner
  ("for the time being the Standard Bank of South Africa Limited"). Paymentology (formerly
  Tutuka) processes the pre-funded cards
  ([terms PDF](https://paycentral.co.za/wp-content/uploads/2026/06/PayCentral-Terms-and-Conditions-EC130126.pdf)).
  So the issuer is **Standard Bank, not Bank Zero**; section 2's party table changes
  accordingly.
- **Products.** **DigiCentral** is a virtual card (launched with Mastercard in December 2020).
  **CashCentral** and **CashCentral+** are physical cards with ATM access
  ([Mastercard release](https://www.mastercard.com/news/eemea/en/newsroom/press-releases/en/2020/december/paycentral-and-mastercard-enable-small-businesses-to-go-digital-and-pay-employees-with-virtual-cards-tapping-into-the-booming-digital-economy/)).
- **Volumes.** The minimum order is one card. Branded (white-label) cards carry a minimum order
  of unstated size ([FAQ](https://paycentral.co.za/faqs/)).
- **API.** The knowledgebase advertises "reference docs, sandboxes and SDKs for every PayCentral
  API surface". The one visible call is `GET https://api.paycentral.co.za/v1/wallet` with a
  bearer token ([help.paycentral.co.za](https://help.paycentral.co.za/)). Their FAQ also offers
  custom development by their in-house team (the page the founder shared:
  `paycentral.co.za/payment-solutions/custom-development/`).

### 0.2 What this changes in the plan

| Topic | Paymentology direct (sections 1 to 11) | PayCentral |
|---|---|---|
| Minimum | 30,000 cards | 1 card; a branded minimum to be quoted |
| Issuer / sponsor | Bank Zero (alliance) | Standard Bank |
| API we integrate | Paymentology Banking.Live (FAST, PaySecure, PayControl) | **PayCentral's own API** (`api.paycentral.co.za/v1`). It is not Paymentology's API, even though Paymentology processes underneath |
| Where the card balance lives | Our ledger (ActiveFAST): one balance | **At PayCentral / Standard Bank** (pre-funded): the business funds its PayCentral account by EFT and loads cards from it. Two balances: the WaPay wallet and the card |
| Authorisations | We answer every one in about 2 seconds, with STIP behind us | PayCentral and Paymentology decide against the card balance. We only read transactions |
| Physical cards | Possible later | Available now (CashCentral): R50 card, ATM up to R5,000 a day on the published list |
| Card details (PAN/CVV) | Our web page with PaySecure, decrypted in the browser | PayCentral sends the details to the cardholder by email or SMS ([virtual payment solutions](https://www.paycentral.co.za/virtual-payment-solutions/)). Our systems never see a card number. Confirm whether an API or a hosted display is offered |
| Data residency | Stockholm hosting is an open issue | Card data stays with PayCentral in SA. We hold only references and the last four digits |
| Build size | Large: auth endpoint, hold lifecycle, STIP, FAST, SFTP | **Small**: load and unload calls on the existing two-phase pattern, card issue and status calls, a transaction feed, float and reconciliation |

**Is the API "the same as Paymentology's"? No.** The concepts match (cardholder, card, load,
status, transactions), so the provider-neutral `CardProvider` design in section 7 holds and
PayCentral becomes provider number one. The calls, authentication and messages are
PayCentral's own. Nothing in sections 3 and 5.3 (FAST messages, STIP, TID/RID) applies unless
PayCentral offers remote authorisation, which nothing we found suggests (email question 3).

### 0.3 Architecture on WaPay's code (pre-funded model)

The card is a **destination** for money, like a withdrawal, not a rail that spends our balance.

```
Customer: "add R500 to my card"
  └─ preview (fee quoted) → YES → PIN
       └─ reserveHold(SPEND, amount + fee, idemKey card-load-<intent>)      lib/ledger-post.js
            └─ PayCentral load card API (our reference = idemKey-derived)    packages/providers/paycentral
                 ├─ success → settleHold(buildCardLoad)                       lib/ledger-core.js
                 ├─ failure → releaseHold
                 └─ timeout → ask PayCentral for the load's status, then settle or release
                              (the OTT TIMEOUT_CHECK_REQUIRED pattern; never release on unknown)
```

**Ledger (new builders, same shape as `buildCashout`):**

| Movement | Postings | Notes |
|---|---|---|
| Load card | `Dr WALLET:<acc>:SPEND` (amount + fee) / `Cr CLEARING:PAYCENTRAL` (amount) / `Cr REVENUE:FEE:CARD_LOAD` (fee) | The customer's money leaves WaPay's books and becomes a Standard Bank prepaid card balance |
| PayCentral's own load fee to us | `Dr EXPENSE:PROVIDER:PAYCENTRAL` / `Cr CLEARING:PAYCENTRAL` | Grossed up for the VAT we cannot recover, as `cashoutRailCostCents` does |
| Unload card to wallet (if offered) | `Dr CLEARING:PAYCENTRAL` / `Cr WALLET` | The published "load reversal" costs R125, so treat unload as an exception path, not a feature |
| Fund the PayCentral float | Ops EFT; `CLEARING:PAYCENTRAL` is our position | Same as the OTT payout float: Mission Control floats card, low-float alarm |

**What this removes from section 5.4:**
- the one-shot hold problem;
- forced posts that overdraw a wallet;
- TID/RID idemKeys;
- the 2-second authorisation endpoint and its cold-start risk;
- STIP;
- the PaySecure card page;
- SFTP;
- most of the 3DS question, since PayCentral or its ACS handles the challenge (to confirm).

All of them belonged to us holding the balance.

**What stays:**
- the idemKey discipline (BUGLOG #17), with keys derived from the intent;
- timeout recovery before any release (BUGLOG #15);
- quote-binding fees (invariant 10);
- PIN-gated deterministic flows, and the AI never stating a card balance (invariants 6 and 7);
- the betting-MCC block, which must now be configured at PayCentral;
- a verified cardholder identity record (section 5.4 item 4), now holding the FICA fields
  PayCentral asks for.

**New pieces:**
1. **Provider client.** `packages/providers/paycentral`: auth, create cardholder, issue a
   virtual card, order a physical card, load, unload, status (freeze, unfreeze, cancel),
   balance, transactions.
2. **Records.** A `Card` table (provider, provider card id, last four, expiry, type
   VIRTUAL/PHYSICAL, status) plus the `ProviderRequest` row per load, as payouts do.
3. **Transaction feed.** Webhooks if PayCentral has them, else a polling job, feeding card
   history and purchase alerts. These are informational only: they move no WaPay money.
4. **Card balance from the source.** "My card" shows PayCentral's own balance, fetched
   deterministically. It is never computed by us and never stated by the AI.
5. **Reconciliation.** Loads in our journal against PayCentral's statement; the float against
   `CLEARING:PAYCENTRAL`.
6. **Physical cards.** Delivery address capture, courier status, activation and PIN
   (PayCentral's process, to confirm), and ATM copy under the cash-out policy.

### 0.4 Regulatory: simpler, with one new question

- **Where the money sits.** The open-loop spending happens on a Standard Bank prepaid card
  that PayCentral manages, so section 4.1 largely answers itself. The money on the card sits
  with the bank, and the WaPay wallet keeps its current shape.
- **The new question.** Loading a card from the wallet is a **money-out movement**, the same
  class as a withdrawal (`lib/payouts.js`), so it sits under the same counsel brief as payouts.
  A physical card with ATM access is cash-out by definition.
- **Consumer cardholders.** PayCentral's product is built for businesses paying their own
  people. WaPay would be the business client issuing cards to the public. PayCentral and
  Standard Bank must confirm that this is allowed and on what terms (email question 1).
- **FICA.** Their homepage says R25,000-limit products need name, surname, cellphone and an SA
  ID or valid work permit. That is lighter than a liveness check, and Didit can verify it.
  Card issuance still requires it, whatever `WAPAY_PAYOUT_KYC` says.

### 0.5 Commercials: the published list prices are too expensive for us; negotiate

Published client and cardholder fees (fee pages, checked through search 2026-10-16; the pages
disagree with each other in places, so treat them as indicative):

| Product | Card | Monthly | Load | Other | Limits |
|---|---|---|---|---|---|
| DigiCentral (virtual) ([fees](https://paycentral.co.za/client-fees/digicentral/)) | none | none | **4.00% to 5.00% of the load, excl VAT** (tiered by size) | Load reversal R125; dormancy R15 after six months without a reload | Loads R25,000 a month; online R25,000 daily and monthly |
| CashCentral (physical) ([fees](https://paycentral.co.za/client-fees/cashcentral/)) | R50 once | R9 | R17 per load | Wallet-to-card transfer R16 | Loads and POS R25,000 a month; ATM R5,000 a day, 3 a day, 12 a month |
| CashCentral+ (physical) ([fees](https://www.paycentral.co.za/cardholder-fees/cashcentral-plus/)) | | R9 | R45 | | Loads R50,000 a month (page about a year old) |

**Why that kills the margin.** At 4% to 5% plus VAT, a R200 load costs R9.20 to R11.50.
- WaPay's whole fee model is flat and small: PayShap R8, deposits banded.
- A customer adding R200 to a card would pay more than a PayShap withdrawal of the same money.
- **Ask for:** a flat per-load price, or a percentage of 1% or less with a cap; no dormancy
  fee; the branded-card minimum. The custom-development page suggests they will price a
  bespoke programme.
- **Not fixed by them:** any customer card fee stays a founder decision under the flat-fee,
  quote-first rule.

### 0.6 Branding

PayCentral's FAQ says they help with "Mastercard licensing and card issuing" and offer branding
across physical cards, printed collateral and their platforms, with a minimum order for
branded cards. A WaPay-branded physical card is therefore on offer, subject to that minimum.
To confirm for the virtual card:
- whether DigiCentral card art can carry the WaPay logo;
- whether the card-details email or SMS can carry WaPay's name rather than PayCentral's.

### 0.7 Dummy cards and the next step

- **Sandbox.** PayCentral advertises sandboxes, and the minimum order is one card. So test
  cards are realistic as soon as PayCentral gives us sandbox credentials. This is faster than
  the Paymentology route, where test access only came with onboarding.
- **What the sandbox lets us build:**
  - the provider client and the `Card` table;
  - "get a card", "add money to my card", "my card", freeze and unfreeze in WhatsApp;
  - the float card in Mission Control.

  That is all against their sandbox, with tests in the existing style, behind
  `WAPAY_CARDS_ENABLED` and an allowlist.
- **To send.** `EMAIL_TO_PAYCENTRAL_1_ONBOARDING.txt` is the first email, with the questions
  that decide the build.
- **What we need to read their API.** Allow `paycentral.co.za`, `help.paycentral.co.za` and
  `api.paycentral.co.za` in this environment's network settings, or paste the API reference.

### 0.8 The NDA and the product deck (2026-10-20)

PayCentral sent its standard NDA and its "Full Product Deck 2026". They told the founder WaPay
can start issuing virtual and physical cards whenever it is ready. Neither document is in the
repo: the filled NDA stays with the founder.

**NDA (8 pages, mutual): signable.** WaPay's details were filled in on 2026-10-20:
- **Clause 1.2:** WAPAY Proprietary Limited, registration 2025/759220/07.
- **Clause 12.2.2:** arbitration in Johannesburg.
- **Clause 13.1:** WeWork, 80 Strand Street, Cape Town City Centre, Cape Town, 8001;
  niev@wapay.co.za; Nieuwoudt Gresse (Director).
- **Page 8:** WaPay signs in the block labelled "For the Supplier".

The founder signs by hand.

Terms worth knowing:
- **No commercial strings:** no exclusivity, no non-compete, no non-solicit.
- **Duration:** obligations last forever (clause 9).
- **Indemnity:** mutual and uncapped, including attorney-and-client costs (clause 6).
- **Disputes:** 10 business days to remedy a breach (clause 11), then AFSA arbitration.
- **Advisors:** information may be shown to advisors on a need-to-know basis (5.2), so counsel
  can see it.
- **Changes after signing:** need a handwritten pen signature, never a data message (15.1).
- **Purpose (3.1):** the template's generic text ("a prepaid card online portal which includes
  gift cards, virtual cards and international cards") was left unchanged. The definition of
  Confidential Information (2.2.4) covers anything about the negotiations whatever 3.1 says,
  so the risk is low. The cover email records our reading: card issuing to WaPay customers
  and API integration.
- **Not a POPIA agreement.** No cardholder personal data goes to PayCentral until the main
  agreement exists.
- **Our obligation:** reasonable care for their information (5.1, 7.3). That is why the repo
  went private on 2026-10-20, before any PayCentral pricing or API document arrives.

**Product deck (9 slides).**
- **Partners:** Standard Bank, Mastercard **and Bank Zero**. Ask which bank issues WaPay's
  cards.
- **"Motivate People" range:**
  - GiftCentral and GiftCentral+ (gift cards);
  - DigiCentral (virtual);
  - BeyondCentral (international gift card).
- **"Pay People" range:**
  - CashCentral and CashCentral+ (physical, cash at ATMs and selected tills);
  - FuelCentral, a fuel card. It is worth a look as an alternative to the wiCode fuel product
    that is still waiting on Yoyo.
- **Client journey:**
  1. Onboard through PayCentral's eKYC.
  2. Order cards against an invoice. Physical cards are dispatched within 48 hours **to the
     client's door**, so in bulk to WaPay, not to each cardholder.
  3. Assign each card with the cardholder's details and **ID or passport**, so passport holders
     can get cards.
  4. Fund the profile by EFT, then load cards instantly from it.

  This confirms the pre-funded model in 0.2 and 0.3.
- **Cardholder journey:**
  - purchases in person or online, local or international depending on the card;
  - cash at ATMs or tills;
  - opt-in SMS alerts from PayCentral;
  - balance and transactions on getmybalance.co.za or the PayCentral app;
  - PayCentral's own support (phone, after hours, WhatsApp).

  The cardholder therefore sees PayCentral's brand unless those channels can carry WaPay's
  brand or be switched off.
- **Not in the deck:** the API, pricing and branding.

**What this adds to the open questions:**
1. Which bank (Standard Bank or Bank Zero) issues our cards.
2. Courier to each cardholder for physical cards, or WaPay distributes them.
3. Whether PayCentral's SMS alerts, app and balance site can be WaPay-branded or switched off.
4. Who supports WaPay's cardholders: lost cards, disputes, chargebacks.

**Pilot without code (proposed).** Order a few DigiCentral cards in the portal for the founder
and two or three testers, fund them with company money by EFT, and load them from the portal.
Then test online purchases, 3DS, the SMS alerts and how card details arrive. No customer
wallet is involved, so the ledger is untouched. The WhatsApp integration waits for the API
docs and sandbox.

### 0.9 Staging API v2.1.5, static IPs, products and prices (2026-10-23)

Odette (PayCentral) sent the "Staging Platform API Specification v2.1.5" (34 pages), the
onboarding document and the white-label deck. Diego Langeveldt is the sales contact and
Shyanne Hendricks the onboarding coordinator. The documents are not in the repo; this section
is the working summary. The reply is `EMAIL_TO_PAYCENTRAL_2_STAGING.txt`.

**Products chosen by the founder:** **DigiCentral** (virtual) and **CashCentral+** (physical,
reloadable, ATM access), with the white-label pack to follow. **FuelCentral** (fuel card) was
added the same day to power the UniFuel fuel product (`docs/UNIFUEL_INTEGRATION.md`); it uses
the same API.

**Standard prices (onboarding document; negotiate, do not build on these):**

| Card | Card | Load | Monthly | Other |
|---|---|---|---|---|
| DigiCentral | none | 5.00% (R1 to R249,999) down to 3.75% (above R5M), by volume band | none | SMS load alert R1.50; dormancy R15 after 6 months; valid 3 years |
| CashCentral+ | R50 excl VAT | **R45 incl VAT per load** | R9 incl VAT | Load limit R50,000 a month; PIN reset R13.50; valid 5 years; dormancy R15 |
| CashCentral | R50 excl VAT | R17 incl VAT | R9 incl VAT | Load limit R25,000 a month |
| FuelCentral | R50 excl VAT | R25 incl VAT per load | none | Fuel station swipes free; SMS load alert R1.50; load limit R25,000 a month; valid 5 years; dormancy R15 after 12 months |
| BeyondCentral (international) | R50 excl VAT | 7.5% | R9 | R2.50 per transaction alert; international till use R20 + 1% |

At our ticket size (R50 to R500 loads) both standard models are unusable: R45 on a R200 load
is 22.5%. The white-label quote must be a flat fee per load or per active card per month.

**Static IP (mandatory).** The API admits only whitelisted IPs ("IP whitelisting as a primary
security measure").
- PayCentral's fees: staging R950 excl VAT for 3 months, including an R100 profile load and
  two cards; production R1,500 a month excl VAT.
- Vercel functions have no fixed outbound IP by default.
- **Plan: Vercel Static IPs.** It is a Pro or Enterprise add-on at $100 per project per month
  plus $0.15 per GB (Vercel pricing and KB, read 2026-10-23). It gives a pair of IPs per active
  region; ours is `arn1`. No code change.
- **Trade-off:** the pair comes from a pool shared with other Vercel customers. PayCentral
  still requires our credentials, so the whitelist is not the only lock.
- **If PayCentral wants a dedicated address:** use Vercel Secure Compute (Enterprise) or a
  dedicated static-IP egress proxy used only for PayCentral calls (a small code change: a
  proxy agent on that client).
- **Testing:** calls work only from the whitelisted IPs, so staging tests run on Vercel
  deployments, not on laptops.

**The API (REST/JSON).**
- **Base URL:** `https://staging-api.paycentral.co.za`; production URL to come.
- **Auth:** `POST /authenticate` with email and password, which returns a bearer JWT.

| Our need | Endpoint | Notes |
|---|---|---|
| Issue a virtual card | `POST /card/virtualAllocate` (cellphoneNumber, firstName, lastName, idOrPassportNumber, loadAmount) | Returns `card_no`, `seq_no`, `expiry_date` **and `secure_code` (the CVV)**. See PCI below |
| Assign a physical card | `POST /card/allocate` (cardIdentifier of a pre-printed card, names, ID/passport, **emailId required**, cell, address, optional base64 ID and address documents) | Cards come in stock; we allocate them |
| Add money to a card | `POST /card/load` (cardIdentifier, amount, notes, `reference_no` "any 12 digit (unique)") | The reference is our idempotency handle |
| Confirm a load after a timeout | `POST /get/auditlog` (reference number) | Returns the original request and response: the status check before any release (BUGLOG #15 pattern) |
| Move money back from a card | `POST /card/transfertoprofile` (cardIdentifier, amount, notes) | **No reference_no:** not idempotent as specified. Ask for one before using it |
| Card balance | `GET /card/balance` | "Balance amount in Rands" |
| History, alerts | `POST /card/cards_statement` (dates DD/MM/YYYY) | Types 0 fee, 1 load, 2 fee (in the example), 3 ATM/POS. **No webhooks are documented**, so alerts mean polling |
| Freeze / unfreeze | `POST /card/cancel` (stopReasonID: lost, stolen, pending query, consolidate, no longer active, PIN tries, fraud, emergency replacement) / `POST /card/stopcancel` | The ID numbers are not given; ask which ones are reversible |
| Close a card | `POST /card/deactivate` | |
| PIN (physical) | `POST /card/resetpin` | |
| Change the cell number | `POST /cardholder/updatecontact` | PayCentral's SMS alerts go to this number |
| Cardholder lookup | `GET /card/info` | Returns the **full card number and ID number** |
| Per-card wallet | `GET /wallet/balance`, `POST /card/wallet_statement`, `POST /card/load_card_from_wallet` | What "wallet" means relative to profile and card is unclear; ask |

Ignore `/card/dunloopallocate` (a client-specific flow) and `/card/uploaddocument` (KYC
documents per card).

**What the spec changes in section 0.3:**

1. **Card data (PCI).**
   - `virtualAllocate` returns the CVV, and many calls accept or return the full card number.
   - Rule: identify cards by `seq_no`, store only `seq_no` and the last four digits, and redact
     every PayCentral response before it is logged or stored.
   - **Never store or forward the CVV.** The customer gets the card details from PayCentral
     directly (SMS), or from a one-time secure page if PayCentral offers one. Never in
     WhatsApp (invariant 8).
   - Ask PayCentral to deliver the details itself and to drop the CVV from the response.
2. **Amounts.** Fields say "Integer ... in Rands", but the examples load "0.1". Confirm that
   cents are accepted before converting from our integer cents; refuse non-whole-rand loads
   until then.
3. **References.**
   - `reference_no` is described as 12 digits, while the examples show "REF123456789" and a
     15-digit number.
   - Derive it deterministically from the load's idemKey, for example 12 digits from a hash.
     A standalone 12-digit run does not trip the epoch guard.
   - Ask whether a repeated reference is refused rather than loaded twice.
4. **Personal data.** Allocation sends the customer's name, ID or passport and cellphone to
   PayCentral. That needs the main agreement's POPIA terms, the ID read from the vault at the
   moment of use (golden thread §3), and the customer's consent in the flow.
5. **No webhooks.** Purchase alerts in WhatsApp need a polling job over active cards
   (`lib/jobs.js`). Ask for webhooks and the allowed polling rate.
6. **Email is required** on physical allocation. Most of our customers have none; ask whether
   it is optional.
7. **Float.** No profile-balance endpoint is documented. Ask for one: the Mission Control float
   card and the daily reconciliation need it.

**Next steps:**
1. Founder: enable Vercel Static IPs and send the pair to PayCentral.
2. Founder: send the reply (`EMAIL_TO_PAYCENTRAL_2_STAGING.txt`) with the signed onboarding
   document, an ID copy and the CIPC documents, and pay the R950 staging fee.
3. Build, once the staging credentials and whitelist are live, on a branch behind
   `WAPAY_CARDS_ENABLED` and an allowlist:
   - `packages/providers/paycentral`;
   - the card-load flow on the two-phase pattern with audit-log recovery;
   - "get a card", "add money to my card", "my card", freeze;
   - the float card.

---

## Paymentology direct (2026-10-15; the route at 30,000 cards)

*Discovery written 2026-10-15. Nothing is built. This is the single answer to "can WaPay issue
cards, how would it fit our code, and what do we ask Paymentology". The onboarding text and the
follow-up email are in `EMAIL_TO_PAYMENTOLOGY_1_ONBOARDING.txt` (repo root). The founder's own
generic architecture brief ("WaPay Card Issuing Architecture v1.0", pasted 2026-10-15) is
reconciled against the codebase in section 7.*

**How the research was done.** This session's network policy refused
`developer.paymentology.com` and `www.paymentology.com`, so their pages were read through
search-engine extracts, not in full. Every Paymentology fact below carries its source URL and a
confidence mark. **Doc** means a Paymentology developer page, seen through a search extract.
**Press** means a news release or the trade press. **Inference** means our reading, not a
statement by anyone. Five pages were never seen at all: plan options, product options,
onboarding, card programme specifications and platform overview. Re-run this research with the
domains allowed, or paste those pages in, before signing anything.

---

## 1. The answer in brief

- **Can we issue virtual cards? Yes, technically, and there is a South African route.**
  Paymentology is an issuer processor, not a bank. In April 2026 it became Bank Zero's first
  "alliance partner", a model built for fintechs and platforms to launch their own branded
  Mastercard products under Bank Zero's licence. Mukuru's account and card already run with Bank
  Zero as sponsor (section 2).
- **Can the card spend the existing WaPay balance (one balance, no "load the card")? Probably.**
  Paymentology's **ActiveFAST** mode sends every authorisation to the client, whose ledger
  approves or declines it. That is exactly WaPay's model: our ledger stays the truth and the card
  becomes one more rail. STIP (stand-in processing) covers the times we are unreachable.
  Paymentology must confirm ActiveFAST is available for a Bank Zero ZAR programme (section 3).
- **Can we brand the card with our logo? Very likely yes.** Virtual cards carry a card image
  from a per-client template configured in Paymentology's PayControl. Mastercard's design
  standards require the full-colour Mastercard mark and identification of the issuing bank, and
  Bank Zero and Mastercard approve the artwork (section 8).
- **Commercials: nothing is public.** No price, set-up fee or minimum appears anywhere we could
  reach. Paymentology prices by quote. Section 9 lists what to ask for and the cost lines that
  are ours regardless.
- **What actually decides this is not code.** It is (1) where customer funds must sit once a
  bank-issued open-loop card spends them, which puts the wallet's "closed-loop, spend-only"
  framing in front of counsel and Bank Zero, and (2) Bank Zero's KYC standard, given that
  identity checks are switched off for withdrawals today. Section 4.
- **Recommended sequence:** send the form now, hold the discovery call, get Bank Zero's and
  counsel's answers on funds and KYC, and only then build. The build reuses the ledger, holds,
  jobs queue, KYC and capability registry, and adds four real pieces: a card hold lifecycle in
  `lib/ledger-post.js`, a FAST authorisation endpoint, a secure card-details web page, and
  report-based reconciliation (sections 5 and 10).

## 2. Who does what

| Party | Role in a WaPay card | Source |
|---|---|---|
| **WaPay** | Programme manager: owns the customer, the WhatsApp experience, the wallet and ledger, the approve/decline decision (ActiveFAST), customer support | Inference from the model below |
| **Paymentology** | Issuer processor: card and account records, the Mastercard connection, FAST messages, STIP, tokenisation, PaySecure (PAN/CVV/PIN crypto), PayControl portal, scheduled reports | Doc: [PayControl](https://developer.paymentology.com/bankinglive/docs/ui-paycontrol), [FAST overview](https://developer.paymentology.com/bankinglive/docs/data-fast-overview) |
| **Bank Zero** | Licensed SA bank, BIN sponsor and legal issuer. Carries the financial and compliance obligations, sets KYC/AML standards and approves the programme and the card art | Press: [Paymentology x Bank Zero, 1 Apr 2026](https://www.paymentology.com/newsroom/paymentology-and-bank-zero-partner-to-expand-access-to-south-africas-financial-ecosystem), [FinTech Futures](https://www.fintechfutures.com/partnerships/bank-zero-partners-paymentology-card-issuance); Paymentology's own blog puts liability on the issuing bank ([roles](https://www.paymentology.com/blog/what-are-the-different-roles-and-duties-within-a-card-programme)) |
| **Mastercard** | Scheme: network, brand rules, MDES tokenisation (Apple Pay / Google Pay), chargebacks | [Mastercard brand requirements](https://www.mastercard.com/brandcenter/us/en/brand-requirements/mastercard.html) |

Supporting facts:
- Paymentology says it does not hold the licence itself. Instead it offers "access to BIN
  sponsors worldwide" through Mastercard Fintech Express (press,
  [BIN sponsoring](https://www.paymentology.com/en/bin-sponsoring)).
- Mastercard and Paymentology announced a collaboration on card issuance for SA fintechs in
  March 2025 (press,
  [Mastercard](https://www.mastercard.com/news/eemea/en/newsroom/press-releases/en/2025-1/march/mastercard-strengthens-collaboration-with-paymentology-to-drive-financial-inclusion-in-south-africa/)).
- **Mukuru precedent.** Mukuru's own terms name Bank Zero as the sponsoring bank of the Mukuru
  account and card ([Mukuru terms](https://www.mukuru.com/sa/legal/mukuru-card-service-bank-zero/)).
  A secondary source names Paymentology as the processor and Mastercard as the scheme
  ([Innovation Village](https://innovation-village.com/mukuru-evolves-into-a-neobank-with-new-south-african-account-and-card/)).
- Paymentology has a Johannesburg regional head office and grew out of Tutuka, a South African
  processor (press).
- **Two plans and two doc sets.** On Banking.Live, Pro is multi-tenant cloud with a decision
  engine, credit products and real-time data. Enterprise adds on-soil processing and a private
  scheme connection (doc,
  [plan options](https://developer.paymentology.com/v3.0/docs/start-plan-options)). The doc
  does not say which balance model each plan offers. "Sprint" is the separate, older Tutuka API
  set; its terms ("Companion API", "Remote API", Load/Unload) are not Banking.Live's.
- **Lume.** On 3 June 2026 Paymentology launched **Lume**, a cloud-native issuer platform on which
  "future product updates" will be built
  ([newsroom](https://www.paymentology.com/newsroom/paymentology-launches-lume-to-accelerate-growth-for-fintechs-and-banks)).
  Whether a new client lands on Banking.Live or Lume is unknown; this is email question 5.

## 3. The decision that shapes everything: where the balance lives

Paymentology offers two authorisation modes (doc,
[FAST overview](https://developer.paymentology.com/bankinglive/docs/data-fast-overview),
[FAST transaction interface](https://developer.paymentology.com/docs/data-fast-transaction-interface)):

| | **ActiveFAST** (recommended target) | **PassiveFAST** (fallback) |
|---|---|---|
| Who decides | WaPay. Paymentology sends an authorisation request (ISO-8583 style 0100) and our endpoint answers approve or decline (0110). In the doc's words, the client "checks the requested authorization amount... against their account record of the card and takes the approve or decline decision" | Paymentology, against a balance it holds; WaPay is told afterwards |
| Customer sees | One WaPay balance. Card spend reserves and settles exactly like airtime does today | Two balances: WaPay wallet and "card balance". Spending by card needs a "move R500 to my card" step (a load), and leftovers need an unload |
| WaPay must run | A 24/7 authorisation endpoint with a short deadline, plus STIP rules and a balance pushed for STIP | Load/unload calls and event ingestion only |
| Fit with our invariants | Perfect: `reserveHold → settleHold/releaseHold`, idempotent by message id | Workable: a load is a payout-shaped movement (`WALLET → CLEARING:PAYMENTOLOGY`) |

Facts on the timing (doc,
[message scenarios](https://developer.paymentology.com/v3.0/docs/data-message-scenarios),
[STIP action](https://developer.paymentology.com/bankinglive/docs/stip-action),
[STIP advices](https://developer.paymentology.com/docs/stip-advices),
[balance update API](https://developer.paymentology.com/bankinglive/docs/stip-balance-update-api)):

- **Response window.** It is configurable from 500 ms to 60,000 ms, with three retries by
  default. Scheme deadlines are seconds, so expect Paymentology to set ours to a few seconds.
  This is email question 7.
- **STIP.** When we time out or cannot be reached, Paymentology decides using the STIP rules
  configured for the programme. It then sends us **STIP advices**: code 900 for a timeout,
  930 for other failures, each carrying `original_RID`. We must apply them even when they
  overdraw the wallet, because the merchant has already been approved.
- **Balance for STIP.** `pws_update_balance` pushes actual and blocked balances, up to 25
  accounts per call. This is how STIP knows what a customer can spend while we are down.
- **For comparison only.** Paymentology's older Sprint platform documents the only figure we
  have: the full authorisation cycle must finish within 5 seconds, so the balance holder must
  answer within 2 seconds
  ([Sprint manage funds](https://developer.sprint.paymentology.com/companion-api/manage-funds/)).
  Assume a similar budget until Paymentology states ours.
- **STIP has two levels.** Basic STIP declines when we do not answer in time. Enhanced STIP
  approves within its rules against the shadow balance we pushed, otherwise declines
  ([STIP blog](https://www.paymentology.com/blog/what-is-stand-in-processing-stip)). A slow
  answer from us is therefore a decline at the till, or an approval on a stale balance.

**Messages and identifiers (doc,
[message protocol](https://developer.paymentology.com/bankinglive/docs/data-message-protocol),
[TID and RID](https://developer.paymentology.com/bankinglive/docs/data-tid-and-rid),
[incremental authorisation](https://developer.paymentology.com/bankinglive/docs/txn-incremental-authorization),
[clearing](https://developer.paymentology.com/bankinglive/docs/txn-clearing-settlement-reconciliation),
[refunds and reversals](https://developer.paymentology.com/bankinglive/docs/txn-refunds-and-reversals)).**

- **Format.** FAST posts JSON to a URL Paymentology configures during implementation. The body
  carries the raw ISO-8583 message plus Paymentology's own validations, rules output and a
  suggested response code; "the final decision would be from the client".
- **Message types.**
  - 0100/0110: authorisation and our answer.
  - 0120: advice, including the completion of an incremental authorisation, which recalculates
    the blocked amount.
  - 0400/0410 and 0420/0430: reversal and reversal advice.
  - 1240: presentment (clearing). "No response is required from the client for presentment
    messages." The clearing file import starts within 3 minutes of arrival and takes about 10
    minutes.
- **Identifiers.**
  - TID links the authorisation, advices, reversals and settlement of one transaction.
  - RID identifies each message and stays the same when a message is replayed.
  - TID is unique only per card token, so match on token plus TID, and dedupe on RID.
  - A presentment carries the authorisation's RID in `Add_Ref_RID`.
- **Refund or reversal.** A reversal undoes something not yet posted; a refund is a new credit
  against a posted purchase.
- **Chargebacks.** Disputes go through the API (`POST /disputes` with a `unique-request-id`
  header).

**Latency on our stack (inference).** Functions and the database both run in Stockholm
(`vercel.json` `regions: ["arn1"]`; dashboards went from 3.7 s to 0.3 s after co-location,
CHANGELOG). Where Paymentology's FAST sender runs is unknown. Sprint's published test IPs look
like AWS Ireland, which is about 40 ms from Stockholm. Johannesburg would be roughly 170 to 200
ms. One `reserveHold` transaction is a few milliseconds next to the database. A warm function
fits a 2 second budget easily. **The real risk is the cold start**: a Next.js route that loads
Prisma and opens a connection can spend most of a second before our code runs. So the endpoint
is a measured decision. Run the Card Test Simulator against UAT and record p50 and p99:
- If p99 sits well under one second on Vercel, keep it there.
- If not, move only the FAST endpoint to an always-on Node process in the same region. It
  imports the same `lib/` modules and uses the same database, so the money logic does not fork.

Two design rules follow either way:

1. The authorisation route does only the decision and the hold, inside one transaction. It
   writes the alert as a `lib/jobs.js` row in the same step and answers. Nothing runs after the
   response (the mute-bot rule).
2. The STIP balance push runs as a job after every wallet change, and STIP limits are set
   conservatively (a low per-transaction cap) so an outage costs little.

**Data residency.** Bank Zero and Paymentology's announcement stresses South African
regulatory and data-residency requirements, and Paymentology's Enterprise plan sells on-soil
processing. Our cardholder and transaction data would sit in Stockholm, which may not be
acceptable. This is email question 9. If SA hosting is required, it is a platform move, not a
card task.

**Recommendation.** Target ActiveFAST, because it is the product the founder described ("one
WaPay balance, multiple rails"). Write the adapter so PassiveFAST stays possible: a load/unload
pair behind the same `CardProvider` interface. Bank Zero may refuse a balance held outside the
bank (section 4), and then PassiveFAST is the honest answer.

## 4. Regulatory and funds: the questions for counsel and Bank Zero

These are open questions, not conclusions; the answers come from counsel and Bank Zero.

1. **The wallet's framing changes.** Code and docs describe the WaPay balance as closed-loop and
   spend-only, and so outside e-money (`lib/gifting.js` header; `lib/payouts.js` says cash-out
   "is the thing that makes WaPay look like e-money rather than a closed-loop voucher"). A
   Mastercard that spends the balance at any merchant is open-loop by definition. In a
   bank-sponsored programme the bank is the issuer. Counsel must say what that makes the
   WaPay balance behind the card, and whether all of it, or only card-eligible funds, must sit
   with Bank Zero. The scale model already assumes "e-money authorisation lands in month 13"
   (`lib/scale-model.js`). A sponsor-bank structure may be the faster route to a defensible
   stored-value position for the whole wallet, not just the card. That is counsel's call.
2. **Where the money sits.** Under ActiveFAST, Bank Zero settles with Mastercard daily and debits
   a **prefunded settlement account** that WaPay keeps topped up. Today customer money sits in
   WaPay's own bank account and the supplier floats. We need from Bank Zero: whether customer
   funds must be ring-fenced (trust or segregated account), the prefund sizing rule, and any
   reserve or collateral.
3. **KYC.** Bank Zero sets the standard. Today identity checks are **off** for withdrawals
   (`WAPAY_PAYOUT_KYC=off`, founder decision 2026-10-12, `docs/PAYOUTS.md`). Card issuance must
   require a VERIFIED Didit result whatever that switch says. Expect Bank Zero to want the full
   ID number, date of birth and possibly an address. Today we store only `idNumberMasked` from
   Didit (`lib/didit-kyc.js`), so a verified cardholder identity record is a build item.
4. **PASA / third-party provider status.** The Adumo work hit the same question: who
   processes on whose behalf (`docs/ADUMO.md` section 1). Ask Bank Zero what registration WaPay
   needs as programme manager.
5. **Policy fit (repo invariants).**
   - **Betting:** a Mastercard spends at betting merchants, and a WhatsApp purchase alert would
     echo the merchant's name into chat. That breaks the zero-betting rule for WhatsApp copy.
     Block gambling MCCs (7995 and related) at programme level, and decline them on our side as
     well (email question 15).
   - **Cash:** a virtual card has no ATM use. Keep ATM and cash-back off, and make no cash
     claims in copy.

## 5. Architecture on WaPay's codebase

### 5.1 Shape

```
Merchant ─► Mastercard ─► Bank Zero (issuer) ─► Paymentology (FAST, STIP, PaySecure, reports)
                                                     │  0100 auth / advices / clearing
                                                     ▼
                         pages/api/webhooks/paymentology-fast.js   (verify ─► decide ─► hold ─► 0110)
                                                     │
              lib/cards/authorise.js ── lib/policy.js (card ACTIVE, limits, MCC, KYC)
                                                     │
                     lib/ledger-post.js  reserveHold / adjustHold / captureFromHold / releaseHold
                                                     │           (only writer of Wallet balances)
                     lib/ledger-core.js  buildCardPurchase / buildCardRefund / buildCardFee
                                                     │
                     lib/jobs.js  CARD_ALERT · CARD_STIP_BALANCE · CARD_REPORT_INGEST · CARD_RECON
                                                     │
        WhatsApp (message-processor-v2 ─► lib/cards/chat.js)      Web: /card/[token] (PaySecure, browser-side decrypt)
        Mission Control: /api/admin/card-reconciliation, card float on /api/admin/floats
```

There are no separate services. WaPay is one Next.js app with modules in `lib/`, and the
provider client goes in `packages/providers` next to OTT's. That is the brief's "Card Service"
and "Paymentology Adapter" in our idiom.

### 5.2 What we reuse as-is

| Need | Existing piece | Notes |
|---|---|---|
| Atomic, idempotent money movement | `postEntry` (`lib/ledger-post.js`) | Conditional decrement closes the overspend race; replay returns the original |
| Authorisation hold | `reserveHold` / `releaseHold` | A card authorisation is a hold on the SPEND wallet, exactly like a VAS sale in flight |
| Owed to the card rail | `ACCT.clearing(RAIL.PAYMENTOLOGY)` | New `RAIL.PAYMENTOLOGY`. `CLEARING:PAYMENTOLOGY` is what we owe the issuer for presented spend, cleared when the settlement account is debited |
| Async work, outbox | `lib/jobs.js` | Idempotent on (kind, key), atomic claim, backoff, FAILED left for a human |
| Inbound verification | `lib/webhook-security.js` pattern | Paymentology's scheme: mTLS, IP allowlist or signing, asked in onboarding |
| Encrypted identity | `lib/pii-vault.js` (`WAPAY_PII_KEY`) | For the full ID number and date of birth the issuer needs |
| KYC | `lib/didit-kyc.js`, `profile.kyc` | Card eligibility is `VERIFIED`, independent of `WAPAY_PAYOUT_KYC` |
| Gating and advertising | `lib/capabilities.js` + `lib/policy.js` (`minKycTier`) | New `CARD` capability with `minKycTier: 1`, `WAPAY_CARDS_ENABLED` + `WAPAY_CARDS_ALLOWLIST` (the `VAS_ALLOWLIST_*` idiom) |
| Ops views | payout reconciliation and floats cards in Mission Control | Same shape for cards: held vs open authorisations, journal vs Paymentology reports, settlement prefund vs `CLEARING:PAYMENTOLOGY` |

### 5.3 Money events mapped onto the ledger (ActiveFAST)

| Card event (FAST) | WaPay call | Journal | Notes |
|---|---|---|---|
| Authorisation request (0100), approved | `reserveHold({ idemKey: card-auth-<token+TID+RID key>, amount: billing ZAR cents })` then 0110 approve | none (a hold is a promise) | Decline on `INSUFFICIENT_FUNDS`, card not ACTIVE, limit, blocked MCC. A replayed 0100 has the same RID, so the hold replays and we answer the same |
| Authorisation request, declined | none | none | Store the decline row for the customer's history |
| Incremental authorisation (same TID, new RID) | `adjustHold(+)` **(new)** | none | Hotels, car hire, fuel. The 0120 completion advice resets the hold to the final amount |
| Full / partial reversal (0400/0420, same TID) | `releaseHold` / `adjustHold(−)` **(new)** | none | Idempotent on the reversal's own RID |
| Presentment (1240) | `captureFromHold` **(new)**: posts `buildCardPurchase` for the presented amount, reduces the hold, leaves the rest held for later presentments | `Dr WALLET:<acc>:SPEND` / `Cr CLEARING:PAYMENTOLOGY` (+ fee line if a card fee is ever charged) | Linked to the authorisation by TID and `Add_Ref_RID`. Can be LESS (rest released at expiry or on the last presentment) or MORE (tips, FX) than the hold: the excess posts with `allowNegative`. No answer to Paymentology is needed, so this can run as a job |
| Presentment with no authorisation | `postEntry(buildCardPurchase, { allowNegative: true })` | same | Offline or force post: the bank has already paid; block the card while the balance is negative |
| STIP advice (approved while we were down) | as an approved authorisation, `allowNegative` if needed, deduped by `original_RID` | none until presentment | |
| Refund (credit presentment) | `postEntry(buildCardRefund)` | `Dr CLEARING:PAYMENTOLOGY` / `Cr WALLET` | |
| Hold expiry, never presented | job releases after the scheme window | none | A late presentment after release posts as "no authorisation" |
| Chargeback won / lost | `buildCardRefund` / nothing | | Disputes flow later |
| Daily settlement | ops entry | `Dr CLEARING:PAYMENTOLOGY` / `Cr` the prefund (asset) | Reconciled against Paymentology's SFTP reports |

### 5.4 Real gaps (what has to be built, not configured)

1. **The hold is one-shot today.** A hold goes `ACTIVE → SETTLED | RELEASED`, and
   `settleHold` already allows settling for less. Cards also need: increments, partial
   reversals, several presentments against one authorisation, presentment above the hold,
   expiry, and late presentment after expiry. Plan:
   - add `adjustHold` and `captureFromHold` to `lib/ledger-post.js`, so that file stays the only
     writer of `Wallet.availableCents/pendingCents` (invariant 2);
   - add a `CardAuthorization` table (Paymentology ids, merchant, MCC, held and captured cents,
     status, expiry) that points at the hold's idemKey.
2. **Negative balances.** A force post and a STIP overdraw must post. `postEntry` already has
   `allowNegative`. Add a rule: a negative wallet blocks the card and nets off the next load.
   Ops sees every negative wallet.
3. **idemKeys from Paymentology ids.**
   - **The guard.** The epoch guard in `lib/ledger-core.js` rejects any standalone 13-digit
     run starting with 1, or 10-digit run starting 16 to 19.
   - **The risk.** If TID or RID are long digit strings they can match that pattern. The key
     would then be refused at capture time, after the merchant was paid (BUGLOG #17's
     failure).
   - **The key.** Build each key from what identifies the message: token plus TID for the
     transaction, RID for the message. Encode as `card-<event>-<base64url(sha256(token|TID|RID))>`.
     Do not use a hex digest: its digit runs can still trip the guard, about once per
     thousand keys.
4. **A verified cardholder identity.** Didit's result is stored masked. Store the full verified
   fields encrypted (`lib/pii-vault.js`), sourced from the Didit decision, never typed by the
   customer.
5. **The authorisation endpoint.** `pages/api/webhooks/paymentology-fast.js` must:
   - verify the caller;
   - parse the message;
   - dedupe on the message id in a `CardEvent` table, unique on (provider, id);
   - decide and hold in one transaction, enqueue the alert, and answer within the deadline.
6. **The card-details page.** PAN and CVV never travel through WhatsApp. That is invariant 8
   and PCI, and WhatsApp history is not a place for card data. Proposed page:
   - "View card" sends a short-lived signed link, PIN-confirmed first, to
     `wapay.co.za/card/<token>`.

   PaySecure V2 `sc_get_pan` returns the PAN encrypted with an AES key that the caller
   generates. The caller wraps that key with Paymentology's RSA public key and sends it in the
   `Session-Id` header (doc,
   [sc_get_pan](https://developer.paymentology.com/bankinglive/reference/v2_sc_get_pan),
   [PaySecure](https://developer.paymentology.com/bankinglive/docs/security-paysecure-api)).
   Whoever generates that key can read the card number. So:
   - the page generates the AES key in the browser (WebCrypto) and wraps it with
     Paymentology's public key;
   - our server adds the `X-API-KEY`, relays the call, and passes the ciphertext back;
   - only the browser decrypts. Our servers never hold the key or the plaintext.

   Open points:
   - the pages disagree on GCM versus CBC;
   - no hosted card-details component was found;
   - Paymentology must confirm the browser-generated key is acceptable (email question 12);
   - a QSA should confirm the PCI scope this leaves us.
7. **Report ingestion and reconciliation.** Paymentology pushes the daily authorisations
   report (CSV, `ClientName_auth_YYYYMMDD.csv`) to a **client-hosted SFTP** folder. It also
   forwards Mastercard's raw T112, T140 and TQR4 files (doc,
   [authorisations report](https://developer.paymentology.com/bankinglive/docs/data-authorizations-report)).
   - **SFTP.** Vercel cannot host an SFTP server. Either use a managed SFTP front onto object
     storage that a Vercel cron reads, or ask Paymentology to deliver to their SFTP or to
     storage we name (email question 11).
   - **Recon job.** It matches the files to journal entries and raises exceptions in Mission
     Control. Webhooks alone are never the books.
   - **Doc conflict.** The protocol page says a 1240 transfers funds; the clearing page says
     clearing messages "do not actually exchange or transfer funds". Settlement truth is the
     scheme's net position on Bank Zero's account (email question 11).
8. **3-D Secure.** SA card-not-present payments are 3DS-challenged, and WaPay has no SMS rail.
   - Banking.Live documents enabling 3DS per card; the methods offered are OTP, biometrics and
     risk-based.
   - On the Sprint platform Paymentology "will send the OTP to your platform, which you can
     then send on to the cardholder", and out-of-band approval is supported
     ([Sprint secure cards](https://developer.sprint.paymentology.com/companion-api/secure-cards/)).
   - If Banking.Live offers the same, the code or approval goes through WhatsApp and is
     confirmed with the WaPay PIN. SMS by the ACS is the last resort. Email question 14.
9. **Alerts cost money.** Purchase and decline alerts outside the 24-hour window are
   utility-template sends with a per-message Meta fee. Budget for them (section 9) and
   template them (`wapay_card_*`).

## 6. Card lifecycle in WaPay terms

- **Provisioning.** On "get a card":
  1. `CARD` capability gate (enabled, allowlist, KYC VERIFIED).
  2. Show Bank Zero's cardholder terms (`Consent` row) and take the PIN.
  3. Create or reuse the Paymentology customer, account and card (`api_call_unique_identifier`
     = a deterministic key such as `card-issue-<accountId>-primary`; V2 APIs return the same
     response on a repeat, per the doc).
  4. Store mapping rows (`Card`, provider ids, last four, expiry month and year, status) and
     confirm in chat with the last four only.

  Virtual is card type 2 in Create card v2 (doc,
  [Create card v2](https://developer.paymentology.com/bankinglive/reference/v2_pws_create_card)).
  The state machine (REQUESTED → ACTIVE, FAILED, MANUAL_REVIEW) and the
  audit rows follow the brief's sections 12 and 13 (`AuditLog` exists).
- **Freeze / unfreeze.** Under ActiveFAST the freeze is instant on our side, because we
  decline from the next authorisation onward. We also set the card status at Paymentology so
  STIP declines too. The chat confirms "frozen" once our flag is written. The brief's warning
  (section 29) applies only to the PassiveFAST fallback.
- **Limits and controls.** Per-transaction, daily, monthly, e-commerce and international are
  enforced in our decision function. They are mirrored into Paymentology only for STIP.
- **Terminate.** The status change at Paymentology goes first, then ours. Open holds stay until
  presented or expired.
- **The AI proposes, never executes.** Card intents ("freeze my card", "show my card",
  "card limit R2000") dispatch onto deterministic, PIN-gated flows. The model never states a
  card balance or a transaction status (invariants 6 and 7).

## 7. The founder's brief against the codebase

| Brief section | Keep | Change for WaPay |
|---|---|---|
| 3, 8, 9 Provider-neutral `CardProvider`, mapping tables, WaPay ids primary | Yes | Lives in `packages/providers/paymentology` + `lib/cards/`; same pattern as OTT |
| 4 to 7 Identity, Wallet, Ledger, Card "services" | The responsibilities | No microservices: they exist as `packages/auth`, `lib/ledger-*`, `lib/didit-kyc.js` |
| 6, 16 Ledger "Dr Available / Cr Card Auth Hold" journal at authorisation | The intent | WaPay holds are not journal entries: `reserveHold` moves available to pending and the journal posts at capture. Keep our convention; it is tested and reconciled (`scripts/verify-ledger-db.mjs`) |
| 14 to 19 Authorisation, reversal, presentment rules | Yes, all of them | Built on ActiveFAST messages; needs the hold extensions in 5.4 |
| 22, 23 Event store, idempotency, canonical events | Yes | `CardEvent` table unique on (provider, id); canonical event names internal only |
| 24 Outbox + message bus | Outbox yes | `lib/jobs.js` is the outbox; there is no bus and none is needed at our size |
| 25, 26 Reconciliation independent of webhooks | Yes | SFTP reports, modelled on the payout reconciliation card |
| 28 to 30 WhatsApp UX and alerts | Yes | Alert copy is deterministic and from the ledger. Gambling MCCs are blocked, so their names never reach chat. No balance in AI text |
| 31 Apple Pay / Google Wallet | Later | No native app, so the mobile SDK and in-app push provisioning do not apply. Paymentology offers Apple Pay **web** provisioning, which needs a signed Apple agreement, an Apple Pay Partner ID and an onboarded card template ([web provisioning](https://www.paymentology.com/web-provisioning)). That is the path from the card page; manual entry is the fallback |
| 32 to 38 Security, audit, observability, money representation | Yes | Integer cents and the wallet `Int` columns are already the rule; `AuditLog` exists |
| 42 Feature flags | Yes | `WAPAY_CARDS_ENABLED`, `WAPAY_CARDS_ALLOWLIST`; more only when needed |
| 52 "Engineering can begin before the agreement" | Partly | Only the zero-regret items in 10 (phase 1). The hold extensions and endpoint wait for ActiveFAST to be confirmed |
| 53 Do not hardcode programme facts | Yes | A `CardProgramme` config row (provider ids, BIN, product, auth mode) |

## 8. Branding: can the card carry the WaPay logo?

What the docs say about card images (doc,
[Create card v2](https://developer.paymentology.com/bankinglive/reference/v2_pws_create_card)):

- Virtual cards are generated with an image template, "predefined and loaded per client" and
  configured in PayControl.
- The create call can return the image as Base64, encrypted, or not at all. A mask chooses
  which details (PAN, CVV, expiry, name) are printed on it.
- A product configuration id carries the card art reference for later tokenisation, which is
  the Apple Pay and Google Pay art.

Mastercard's side:

- Card designs follow the Mastercard Card Design Standards, which require the full-colour
  Mastercard mark on any card image shown digitally.
- The issuer must be identified, by name or logo on the card, or by a licensee statement
  ([Mastercard brand requirements](https://www.mastercard.com/brandcenter/us/en/brand-requirements/mastercard.html)).
- MDES card art is submitted through MDES Manager
  ([MDES digital card art](https://developer.mastercard.com/mdes-digital-card-art-service/documentation/)).
- The Bank Zero alliance is explicitly about fintechs launching "branded Mastercard products".

**Answer: yes, in all likelihood.** The card face can carry WaPay's logo and colours, with the
Mastercard mark and Bank Zero named, subject to Bank Zero and Mastercard approving the art.
The design is used in three places:
- the card page (the image Paymentology renders, or our own render of the masked details);
- Apple Pay and Google Pay (the MDES card art);
- WhatsApp (the last four only, never an image of the full card).

## 9. Commercials

**From Paymentology:**
- Nothing public, on the developer portal or the website. No set-up fee, minimum, per-card
  or per-transaction price appears anywhere we could reach.
- Third-party summaries say pricing is quote-based and turns on "supported markets,
  transaction volume, card portfolio size, and implementation requirements"
  ([guideflow](https://www.guideflow.com/blog/payment-card-issuance-software)).
- One low-confidence source flags per-active-card fees and monthly minimums as a burden for
  low-activity portfolios
  ([rfp.wiki](https://www.rfp.wiki/payments-fraud/card-issuing-virtual-credit-cards-vcc/paymentology/treasury-prime)).
- The only doc mentions are billing artefacts: fee fields in FAST messages, Apple Pay quarterly
  billing reports, and "each setting" billed separately on the older Sprint platform.

**What to get in writing.** Email questions 18 to 20:
- implementation fee;
- monthly minimum;
- per card issued and per active card fees;
- per authorisation and per presentment fees;
- 3DS and tokenisation fees;
- chargeback fees;
- Bank Zero's own programme fees;
- the interchange share (our main card revenue line);
- scheme fees and reserve or prefund requirements.

**Costs that are ours regardless** (to add to `docs/COMMERCIALS.md` as rows with status
UNKNOWN once quoted):
- Didit KYC per verified cardholder (about $0.33 per full check, `docs/KYC.md`);
- Meta utility-template fees per purchase or decline alert outside the 24-hour window;
- the opportunity cost of the settlement prefund;
- support for disputes.

**No customer fee is proposed here.** Any card fee is a founder decision under the flat-fee,
quote-before-confirm rule.

**Fraud cost to design for (inference).** Stolen cards loading WaPay through PayFast and then
spending through our virtual card is the classic laundering loop. Options: a holding period on
card-funded balance before it is card-spendable, velocity rules, and blocking crypto and gift
card MCCs. This is a founder decision before pilot.

## 10. Build plan and gates

| Phase | What | Gate to start |
|---|---|---|
| **0. Commercial and regulatory** (now) | Send the form; discovery call; email (B); Bank Zero alliance terms; counsel on sections 4.1 to 4.4; prepare the due diligence pack (programme overview, funds flow, customer journey, KYC/AML, fraud, PCI scope, projected volumes) | none |
| **1. Zero-regret foundations** | Verified cardholder identity record (encrypted, from Didit's decision); the CARD capability stub (off, `minKycTier: 1`); `RAIL.PAYMENTOLOGY` and the card builders in `lib/ledger-core.js` with unit tests | Founder says go |
| **2. Integration on UAT** (`uat.banking.live`) | Provider client (REST/JSON, static `X-API-KEY`, idempotent V2 calls); create customer, account and card; link; status (`pws_set_card_status`, token flags); limits. The FAST endpoint with `adjustHold`/`captureFromHold`, **with latency measured on the simulator before choosing Vercel or an always-on process**. STIP balance job (`pws_update_balance`); the SFTP drop and report ingestion. Card Test Simulator scenarios: approve, decline, partial and full reversal, incremental, partial and multiple presentment, over-presentment, force post, refund, STIP advice, duplicate and out-of-order delivery | ActiveFAST confirmed, UAT credentials, counsel's answer on funds |
| **3. Customer surfaces** | WhatsApp flows (get card, my card, freeze, unfreeze, limits, transactions, alerts) and the card-details page; copy through `lib/localize.js`; policy tests for betting and cash copy | Phase 2 green on UAT |
| **4. Books** | Card reconciliation and settlement-prefund cards in Mission Control; the daily recon job; dispute intake | Before any real card |
| **5. Pilot** | Founder's card, then an allowlist; real R5 purchases; reconcile against reports and Bank Zero settlement | Bank Zero programme approval; Paymentology certification |
| **6. Later** | Apple Pay / Google Pay; physical companion card | Separate decision |

Definition of done is the brief's section 54, plus our own: suite 100% green, `pnpm build`,
a BUGLOG entry with a guard for every bug, and CAPABILITIES updated on each ship.

## 11. Open items

- Founder: send the form (part A), then email (B) once a contact replies; pick who briefs
  counsel; decide the betting-MCC block and the card-funded holding period.
- Research: re-read the unseen Paymentology pages with the domains allowed (product options,
  onboarding, card programme specifications, platform overview). Still missing from the docs:
  - the ActiveFAST timeout for this programme;
  - ZAR settlement;
  - FAST transport security, retries and ordering;
  - partial-approval handling and authorisation-hold expiry;
  - an unload endpoint (only `pws_load_balance` was found);
  - the card-art process.
- Not found in Paymentology's docs at all: any price. Commercials come only from the quote.
- Nothing in this document changes code. CAPABILITIES lists Paymentology under providers as
  "discovery".
