/**
 * Spend catalogue — the single data-driven source of "where can WaPay money
 * be spent", for BOTH the AI brain (prompt knowledge) and the deterministic
 * surfaces (the "where can I spend?" reply, redemption guides).
 *
 * v1.3 mandate (founder, 2026-08-29): the merchant catalogue is DATA, not
 * hardcoded copy — Yoyo will enable more merchants over time, and the list
 * must grow without a copy rewrite. Extend it via WAPAY_WICODE_CATALOGUE_JSON
 * (a JSON override/extension, see catalogue()) or by editing the DEFAULTS
 * below; every customer-facing string in this module is BUILT from the data.
 *
 * Gating rules (do not weaken):
 * - Real-redemption claims for wiCode fuel/retail are gated on the
 *   production-live flag (WAPAY_WICODE_LIVE). Until it is 'true', fuel and
 *   retail are presented as COMING SOON — Yoyo test vouchers do not work at
 *   pumps, and nothing customer-facing may claim otherwise.
 * - Only onboarded partners are ever advertised, always with the
 *   "participating stations" caveat — never "any station".
 * - The retail merchant list is not advertised until the redeemable
 *   catalogue is verified with Yoyo (advertised: false).
 * - ZERO betting/gambling references (Meta policy — WABA-existential).
 * - No em/en dashes in customer copy (founder decree 2026-08-25).
 * - Never a date promise for anything coming soon.
 */

/**
 * wiCode production flag. False = Yoyo TEST environment: the pipeline may
 * run end-to-end internally, but customers see fuel/retail as coming soon.
 */
export function isWicodeLive() {
  return process.env.WAPAY_WICODE_LIVE === 'true';
}

/**
 * Default catalogue. Ground truth from Yoyo (July 2026, via UniFuel):
 * Shell on Figment POS at ~85% of stations (pump + convenience store),
 * Engen on Winbranch (forecourt till only). TotalEnergies is NOT onboarded
 * (POS transition) and must never be advertised until it is.
 */
const DEFAULT_CATALOGUE = {
  fuel: [
    {
      name: 'Shell',
      onboarded: true,
      coverage: 'about 85% of stations',
      redeemAt: 'at the pump or in the convenience store',
    },
    {
      name: 'Engen',
      onboarded: true,
      coverage: 'participating stations',
      redeemAt: 'at the forecourt till, for fuel',
    },
    {
      name: 'TotalEnergies',
      onboarded: false,
      coverage: null,
      redeemAt: null,
    },
  ],
  /**
   * Retail wiCode merchants. Structure ready; advertised stays false until
   * the redeemable catalogue is verified with Yoyo (2026-08 position: the
   * network exists but WaPay advertises nothing it has not verified).
   */
  retail: [],
};

/**
 * The catalogue, with an env-JSON override so merchants can be added
 * without a deploy of new code. WAPAY_WICODE_CATALOGUE_JSON replaces the
 * top-level keys it provides; malformed JSON falls back to the defaults.
 */
export function catalogue() {
  const raw = process.env.WAPAY_WICODE_CATALOGUE_JSON;
  if (!raw) return DEFAULT_CATALOGUE;
  try {
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CATALOGUE, ...parsed };
  } catch {
    return DEFAULT_CATALOGUE;
  }
}

/** Onboarded fuel partners, ready to be advertised when the flag is live. */
export function advertisedFuelPartners() {
  return catalogue().fuel.filter((p) => p.onboarded);
}

/**
 * The honest cash-out position (founder script, 2026-08-29): not available
 * YET, coming soon via our payouts capability (agreement signed 2026-08-25),
 * NEVER a date, then warmly redirect to everywhere the money already works.
 */
export function cashoutScript() {
  return (
    `💸 Cash withdrawals are not available just yet, but they are coming soon! ` +
    `We have signed with our payouts partner and the plumbing is being built right now. 🔧\n\n` +
    `In the meantime, your WaPay money already works hard:\n` +
    spendDestinationLines({ wicodeLive: isWicodeLive() }) +
    `\n\nJust tell me what you would like to do. 😊`
  );
}

/**
 * The bullet list of live spend destinations, built from data. Founder
 * structure (2026-08-31): the in-app breakdown first, then "you can also
 * spend at these participating retailers" from the catalogue. The OTT line
 * says it is ACCEPTED without listing places — the dedicated accepted-at
 * answer exists for whoever asks (ottAcceptedFacts).
 */
export function spendDestinationLines({ wicodeLive = isWicodeLive() } = {}) {
  const lines = [
    `📱 *Airtime and data* for your number or any other SA number`,
    `💡 *Prepaid electricity* for any meter`,
    `💸 *Send money* to friends and family on WhatsApp`,
    `🙏 *Get paid* with a "please pay me" link you can share anywhere`,
    `🎟️ *WaPay vouchers* (OTT), accepted at many online stores. Ask me "where are OTT vouchers accepted" any time`,
    `💳 *Add money* by card or EFT ("deposit R100"), or with a Blu voucher bought for cash at any till`,
    `💰 And just say "balance" any time to see where you stand`,
  ];
  if (wicodeLive) {
    const retailerLines = [];
    const partners = advertisedFuelPartners();
    if (partners.length > 0) {
      retailerLines.push(
        `⛽ *UniFuel fuel vouchers* at participating ${partners.map((p) => p.name).join(' and ')} stations ("buy fuel")`
      );
    }
    const shops = catalogue().retail.filter((m) => m.advertised);
    if (shops.length > 0) {
      retailerLines.push(`🛒 *Shopping vouchers* at ${shops.map((m) => m.name).join(', ')}`);
    }
    if (retailerLines.length > 0) {
      lines.push(`\nYou can also spend at these participating retailers:\n` + retailerLines.join('\n'));
    }
  }
  return lines.join('\n');
}

/**
 * Where OTT vouchers are accepted — the dedicated answer for whoever asks.
 * Truthful and policy-safe: named categories only, the live merchant list
 * belongs to OTT's own site, and betting is NEVER mentioned (Meta policy).
 */
export function ottAcceptedFacts() {
  return (
    `OTT vouchers are accepted as a payment method at many South African online stores and platforms, ` +
    `including mobile top-up sites, streaming subscriptions, and selected retail and tech stores. ` +
    `The full up-to-date list of places is on OTT's own site: ottvoucher.com. ` +
    `Pick OTT at checkout and enter the voucher PIN.`
  );
}

/**
 * The warm "where can I spend my WaPay money?" answer — the reply that
 * should have gone out on 2026-08-29 instead of the bare Help Menu.
 */
export function buildSpendDestinationsReply({ wicodeLive = isWicodeLive() } = {}) {
  const comingSoon = wicodeLive
    ? ''
    : `\n\nComing soon: ⛽ fuel vouchers and 🛒 shopping vouchers for big-name stores. Watch this space!`;
  return (
    `🛍️ Great question! Here is everywhere your WaPay money works right now:\n\n` +
    spendDestinationLines({ wicodeLive }) +
    comingSoon +
    `\n\nJust tell me what you would like to do. 😊`
  );
}

/**
 * Post-issuance redemption guide per voucher type — how to actually use the
 * thing the customer just bought. Bearer codes themselves are NEVER in this
 * copy; the guide travels alongside the code, not around it.
 */
export function redemptionGuide(voucherType) {
  if (voucherType === 'FUEL_WICODE') {
    // Founder copy calls (2026-08-31): brand it a UniFuel voucher, keep the
    // station line SIMPLE ("a participating Shell or Engen station" — the
    // coverage detail lives in docs, not chat), and say "wiCode" only in
    // the attendant step where the word is operationally needed.
    const partners = advertisedFuelPartners();
    const names = partners.map((p) => p.name).join(' or ');
    return (
      `⛽ *How to use your UniFuel fuel voucher*\n\n` +
      `1️⃣ Drive to a participating ${names} station.\n` +
      `2️⃣ BEFORE they start filling up, tell the attendant you are paying with a wiCode and show them your UniFuel voucher code.\n` +
      `3️⃣ They enter it at the till and your fuel is paid. 🎉\n\n` +
      `💡 If you use less than the full amount, the balance stays yours and we send you a fresh code for what is left.`
    );
  }
  if (voucherType === 'RETAIL_WICODE') {
    return (
      `🛒 *How to use your shopping voucher*\n\n` +
      `1️⃣ Shop at a participating store and take your basket to the till.\n` +
      `2️⃣ Tell the cashier you are paying with a wiCode and show them the number.\n` +
      `3️⃣ They enter it at the till and you are paid up. 🎉\n\n` +
      `💡 If you spend less than the full amount, the balance stays yours and we send you a fresh code for what is left.`
    );
  }
  // Default: the OTT-issued WaPay voucher.
  return (
    `🎟️ *How to use your WaPay voucher*\n\n` +
    `Spend it online at any store that accepts OTT vouchers as payment: choose OTT at checkout and enter your voucher PIN. ` +
    `It cannot be exchanged for cash, so keep the PIN safe until you are ready to spend it. 😊`
  );
}

/**
 * The warm coming-soon reply for fuel purchase asks while the wiCode flag
 * is off. Excitement without a single redemption claim or date promise.
 */
export function fuelComingSoonReply() {
  return (
    `⛽ Fuel vouchers are coming to WaPay soon, and we are just as excited as you are! 🎉\n\n` +
    `You will be able to buy a fuel voucher right here in chat and use it at participating stations.\n\n` +
    `While we get that ready, here is what your WaPay money can do today:\n` +
    spendDestinationLines({ wicodeLive: false }) +
    `\n\nWhat would you like to do? 😊`
  );
}

/**
 * The knowledge block injected into the AI category agents each turn.
 * Built from the SAME data as the customer copy, with claims pre-gated so
 * the model cannot claim more than is live. English; the model localizes.
 */
export function buildBrainKnowledge({ wicodeLive = isWicodeLive() } = {}) {
  const parts = [
    `WHERE WAPAY MONEY WORKS (answer "where can I spend / use my money" questions warmly and specifically from THIS list, never with a menu):`,
    spendDestinationLines({ wicodeLive }),
  ];
  if (wicodeLive) {
    const partners = advertisedFuelPartners();
    parts.push(
      `FUEL VOUCHER REDEMPTION FACTS (only claim these because fuel is LIVE): ` +
        partners.map((p) => `${p.name}: ${p.coverage}, redeem ${p.redeemAt}`).join('; ') +
        `. Always say "participating stations", never "any station". ` +
        `A wiCode is a number the attendant enters at the till or pump. Partial redemption: the remaining balance stays with the customer and a fresh code is sent for it.`
    );
  } else {
    parts.push(
      `FUEL AND RETAIL WICODE VOUCHERS ARE COMING SOON, NOT LIVE. If asked about buying fuel or shopping vouchers: warm excitement, coming soon, NEVER promise a date, NEVER claim they can be redeemed at a station or store today. Then guide them to what works right now.`
    );
  }
  parts.push(
    `WHERE OTT VOUCHERS ARE ACCEPTED (answer this when asked, without a menu): ${ottAcceptedFacts()} NEVER name or imply gambling or betting platforms in any answer.`
  );
  parts.push(
    `BRANDING: the fuel voucher is a "UniFuel fuel voucher" and its code is a "UniFuel voucher code". The word wiCode is used only when telling the attendant at the till.`
  );
  parts.push(
    `CASH-OUT POSITION (the honest script): withdrawals are not available YET but are COMING SOON through our payouts partner (agreement signed, integration underway). NEVER promise a date. Identity verification will apply to withdrawals only, when they arrive. After saying so, warmly walk through everywhere the money already works today.`
  );
  return parts.join('\n\n');
}
