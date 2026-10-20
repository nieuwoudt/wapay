# Referrals from the WaPay chat (2026-10-20)

*The founder's brief of 20 October 2026: a member invites a friend from the chat, the friend
arrives through WhatsApp carrying the member's code, the data shows per member who they
brought and how far those people got, and the reward is tracked from day one and paid later
behind a switch. The code is `lib/referrals.js`; the processor carries two hooks; the test is
`tests/referrals.test.mjs`. CHANGELOG 104. Change this page and the module together.*

## 1. How it works

1. **The member asks, in their own words.** "Create me a referral link for a friend to share",
   "referral link", "invite link", "invite a friend", "refer a friend", "share WaPay", "what is
   my referral code", "invite" (`matchInviteAsk`: case-insensitive, tolerant of "please", "can
   you", "me a", "my" and anything around the ask; never "I was invited" or a sentence carrying
   a code, which the first-contact hook answers). Only a member with a finished account reaches
   the command. They get ONE message, forwardable as it is:

   > Here is your WaPay invite. Forward it to anyone you like 👇
   >
   > 💚 Join me on WaPay, the wallet in your WhatsApp. Get paid by anyone with a link, pay
   > friends on WaPay for free and top up by card. Tap to start: https://pleasepayme.co.za/i/K7M2XQ4
   >
   > We are tracking your invites; rewards are coming.

   While `WAPAY_REFERRAL_REWARD_CENTS` is above zero the last line reads "You get R10 in your
   balance when a friend you invited adds money or gets paid for the first time." Never a date.
   The message goes through the usual send (`sendWhatsAppText`, localised), once per ask.
   Nothing reminds, nudges or follows up.

2. **The code.** `referralCodeFor(accountId)`: seven characters from an alphabet without 0, O,
   1, I and L, always at least two letters and one digit, so a code is never a run of digits
   and never a plain word, and it is derived from the account id, never from a phone number.
   It is stored on `profile.referral.code` the first time it is handed out
   (`ensureReferralCode`); if another account already holds that code the next deterministic
   candidate is issued instead. Once stored it never changes.

3. **The link.** `https://pleasepayme.co.za/i/<code>` is `pages/i/[code].js`: no database, no
   sends. A well-formed code redirects (302) to

   `https://wa.me/27760497624?text=Hi%20WaPay!%20A%20friend%20invited%20me.%20Invite%20code%3A%20K7M2XQ4&utm_source=referral&utm_medium=whatsapp&utm_content=K7M2XQ4`

   so web analytics on the short domain sees the channel and the code. The prefilled message
   carries the code only, never the inviter's name. A malformed code is a 404. The short domain's
   pay-link rewrite matches `PR` plus six letters at the root only, so `/i/<code>` is untouched.

4. **First contact.** The friend taps send. In the processor, before the ad flow and before the
   onboarding gate, `handleReferralCodeTurn` reads the code (`parseReferralCode`: "Invite code:
   K7M2XQ4", "code K7M2XQ4", or the code alone in a short message; digit runs, eight-letter
   pay-request codes and words never parse). Then:
   - a **brand-new number** is stamped and counted (`recordReferredContact`), told who invited
     them by first name only ("Thandi invited you to WaPay 💚 Let's open your account…"; memory
     keeps "A friend", `recordAs`) and goes straight to the OTP step, as an ad arrival does;
   - a number **mid-onboarding** is stamped silently and the step that is waiting answers;
   - a **member** (their own code or a friend's) is told once: "You already have a WaPay
     account, so there is nothing to join 😊 Say *home* … or *invite* to get your own link";
   - an **unknown code** or the member's own changes nothing: the ordinary welcome runs.

   The stamp, on `profile.attribution` (the same place the Growth tab reads):
   `referralCode`, `referredAt` (always; the first code wins), `referrerAccountId` (when none is
   there yet; a pay-link referrer stays), `source: 'referral'` and the top-level
   `acquisitionSource: 'referral'` (when the account was organic; an ad click or a pay link that
   came first keeps its source, and the invite is still counted for the inviter).

5. **The numbers, per member** (`referralStats`, read-only, on `GET /api/admin/customer` as
   `referrals`): `code`, `link`, `invited` (accounts that wrote in with the code), `onboarded`
   (onboarding complete), `funded` (first credit to the balance from anything but a reward),
   `paid` (first PAID please-pay-me link), `rewardEligibleCents` (accounts with either milestone,
   at the switch's value while on, else R10) and `rewardPaidCents` (what the ledger has actually
   credited as `REFERRAL_REWARD`). A member who never asked for an invite is shown the code the
   command would give them and zeros; nothing is written on a read.

## 2. The reward switch

`WAPAY_REFERRAL_REWARD_CENTS`, integer cents, default 0.

- **0 or unset: track only.** Milestones are recorded (`attribution.referralQualifiedAt`,
  `referralQualifiedBy`, `referralRewardCents: 0`); nothing is credited, nothing is sent; the
  invite message says the invites are tracked.
- **Above zero: paid.** The first qualifying event per referred account (first money in OR
  first paid link, whichever comes first) posts `buildReferralReward` through `postEntry`: debit
  `EXPENSE:PROMO:REFERRAL`, credit the referrer's SPEND balance, source `REFERRAL_REWARD`,
  idemKey `referral-reward-<referredAccountId>`. Exactly once per referred account, whichever
  hook fires first or again (the ledger replays on the key). The referrer gets ONE receipt
  ("💚 Thank you for inviting a friend to WaPay. Your R10 reward is in your balance. New
  balance: R…") through `notifyCustomer` (inside the window a text, outside it the direct or
  template rail), only when THIS call posted a fresh entry, and never to a member who said stop
  (the credit still lands). Golden thread 2.12.
- **No retroactive payment.** A milestone reached while the switch was 0 stays at rewardCents 0
  when the switch turns on. The gap is visible per member as `rewardEligibleCents` against
  `rewardPaidCents`; paying it is a founder decision and would be a one-off script through
  `postEntry` with the same idemKeys, never a direct wallet update.

The hooks: `onFunded` in `lib/card-settlement.js` and `pages/api/payfast/itn.js` after a fresh
credit; `onLinkPaid` in `deliverRequestPaidNotifications` (every rail, every redelivery,
idempotent); `referralCatchUp` in `growthOnTurn` on the referred account's own next turn, for a
voucher load, a send from a member or a held gift claimed at join that no hook saw (the earlier
of the two milestones is the trigger). All of them never throw and never slow a money flow.

## 3. Compliance rules (WhatsApp Business Messaging Policy; docs/WHATSAPP_POLICY_COMPLIANCE.md)

1. **WaPay never messages the invited person first.** The friend writes to WaPay by tapping
   the link; everything they get is a reply. No outbound to any number that has not written in,
   anywhere in this feature; the module never imports the transport.
2. **The inviter gets the invite only when they ask, once per ask.** No reminder, no nudge, no
   scheduled tip. The one receipt is the receipt of their own transaction (the reward credit).
3. **Copy.** No em dashes; none of the ad flow's banned words (banking, send money, transfer,
   withdraw, cash out); no reward amount while the switch is 0; never a date; nothing about
   products that are coming soon. `tests/referrals.test.mjs` runs every string through
   `copyViolations`.
4. **Golden thread.** No model sees the code owner's name: the prefilled message carries the
   code only, the welcome that names the inviter is stored as "A friend", and the first-contact
   turn makes no model call. Codes are never phone numbers. The reward is WaPay's money, posted
   once by idemKey; no customer balance is ever debited by this feature.
5. **Stop means stop.** A referrer who opted out is credited but not written to.

## 4. Switches and surfaces

- `WAPAY_REFERRAL_REWARD_CENTS` (env.template): the reward, 0 = track only.
- Capability registry: `INVITE` (help line `🤝 *Invite a friend* - "invite" for your link to
  share`, home-card line `🤝 *Invite*: "invite" to share WaPay with a friend`, the model prompt
  names "invite"), always live, free.
- Admin: `GET /api/admin/customer?q=<number>` → `referrals`.
- Logs (ids only, never a name or number): `referral_invite_ask`, `referral_contact`,
  `referral_code_from_member`, `referral_qualified`, `referral_link_opened`.

## 5. Not built, by design

- No outbound invitation from WaPay to the friend (a template campaign would need an opt-in).
- No Growth-tab panel yet; the customer profile carries the numbers.
- No schema change: the code lives on `profile.referral`, the stamp and the marks on
  `profile.attribution`, the money in the journal, exactly-once on the journal's unique idemKey.
