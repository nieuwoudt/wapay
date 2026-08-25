/**
 * WhatsApp Message Processor V2
 * 
 * Integrates onboarding state machine with message routing.
 * Includes structured logging for debugging VAS flows.
 */

import { getOrCreateUser, getUserBalance, updateConversationState, getConversationState, addToConversationHistory, getConversationHistory, setActiveCategory, getActiveCategory, clearActiveCategory, wasMessageProcessed, markMessageProcessed, wasErrorSent, markErrorSent } from './user-manager.js';
import { sendWhatsAppText, sendWhatsAppTemplate, sendWhatsAppCtaUrl } from '@wapay/whatsapp';
import prisma from '../../../lib/prisma.js';
import { resolveGift, buildRecipientNotification, buildVoucherClaimMessage, maskMsisdn } from '../../../lib/gifting.js';
import { hasPendingGifts, claimPendingGifts, revertGiftDelivery } from '../../../lib/pending-gifts.js';
import {
  createPaymentRequest,
  cancelPaymentRequest,
  getPaymentRequest,
  getLatestPendingRequest,
  markRequestPaid,
  paymentRequestUrl,
  maskedRequesterLabel,
  MIN_REQUEST_CENTS,
  MAX_REQUEST_CENTS,
} from '../../../lib/payment-requests.js';
import {
  rememberBeneficiary,
  findBeneficiariesByName,
  formatBeneficiary,
  isSavedBeneficiary,
} from '../../../lib/beneficiaries.js';
import {
  getProfile,
  setLanguage,
  noteLanguage,
  noteDepositMethod,
  noteMeterNumber,
  noteInterest,
  formatProfileContext,
} from '../../../lib/user-profile.js';
import crypto from 'crypto';
import { BluClient, BluVasClient } from '@wapay/providers-blu';
import { buildLoad, buildSend, RAIL } from '../../../lib/ledger-core.js';
import { postEntry, ensureWallet } from '../../../lib/ledger-post.js';
import { buildCheckoutUrl } from '@wapay/providers-payfast';
import {
  depositFeeCents,
  createDepositIntent,
  getLatestDepositIntent,
  matchDepositStatusRequest,
  MIN_DEPOSIT_CENTS,
  MAX_DEPOSIT_CENTS,
} from '../../../lib/deposits.js';
import { orchestrate } from '@wapay/ai';
import { isValidSaMsisdn, normaliseMsisdn } from '../../../lib/msisdn.js';
import { localizeOutbound, matchLanguageSwitch, LANGUAGE_CONFIRMATIONS } from '../../../lib/localize.js';
import { getCategoryDisplayName, getLiveCategories, isCategoryLive, isCategoryEnabledForWaId } from '../../../lib/vas-config.js';
import { apiUrl, internalJsonHeaders } from '../../../lib/api-url.js';
import { parseSlots } from '../../../lib/slot-parser.js';
import { sendTextOnce } from '../../../lib/error-guard.js';
import { searchProducts } from '../../../lib/vas-search.js';
import {
  verifyPIN,
  getOnboardingState,
  handleS0Initial,
  handleS1WelcomeSent,
  handleS2OtpSent,
  handleS3OtpVerified,
  handleS4PinSet,
  handleResendOTP,
} from '@wapay/auth';

/**
 * Structured logging helper for Vercel logs
 */
function logStructured(type, data) {
  console.log(JSON.stringify({
    type,
    ...data,
    timestamp: new Date().toISOString(),
  }));
}

/**
 * Ensure user-facing messages never expose raw JSON blobs.
 */
function sanitizeUserText(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return null;
  return text;
}

function missingFromSlots(slots, requiredKeys = []) {
  return requiredKeys.filter((k) => !slots?.[k]);
}

function logSlotFill({ intent, text, slots, routeDecision, missing = [], from, accountId }) {
  logStructured('slot_fill', {
    intent,
    text,
    slots: {
      amountCents: slots?.amountCents,
      msisdn: slots?.msisdn,
      meterNumber: slots?.meterNumber,
      productHint: slots?.productHint,
      retailer: slots?.retailer,
      dataMb: slots?.dataMb,
      periodType: slots?.periodType,
      networkCode: slots?.networkCode,
      confidence: slots?.confidence,
    },
    routeDecision,
    missing,
    from,
    accountId,
  });
}

async function sendWhatsAppErrorOnce({ to, errorKey, text }) {
  const res = await sendTextOnce({
    to,
    errorKey,
    text,
    wasSent: wasErrorSent,
    markSent: markErrorSent,
    send: sendWhatsAppText,
  });
  if (!res?.dedup && !res?.deduped) {
    await addToConversationHistory(to, 'assistant', text);
  }
  return res;
}

function categoryUnavailableMessage(category) {
  const display = getCategoryDisplayName(category);
  return `🚧 ${display} is listed, but purchasing is not enabled yet.\n\nYou can still buy airtime, data, or electricity right now.`;
}

async function replyCategoryUnavailable(to, category) {
  return await sendWhatsAppText({
    to,
    text: categoryUnavailableMessage(category),
  });
}

function extractMsisdnFromText(text = '') {
  // Extract a plausible MSISDN substring without accidentally concatenating unrelated numbers.
  // Allows separators/formatting between digits (spaces, punctuation, unicode marks).
  // Matches: 0XXXXXXXXX OR 27XXXXXXXXX OR +27XXXXXXXXX, even if digits are separated by non-digits.
  const s = String(text || '');
  const re = /(?:\+?27|0)(?:[^\d]*\d){9}/g;
  const matches = s.match(re);
  if (!matches || matches.length === 0) return null;

  const raw = matches[matches.length - 1];
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('27') && digits.length === 11) digits = `0${digits.slice(2)}`;
  if (digits.length === 10 && digits.startsWith('0')) return digits;
  return null;
}

function detectVendorLabel(msisdn = '') {
  const num = normaliseMsisdn(msisdn);
  const p3 = num.slice(0, 3);
  // Note: 084 is ambiguous in SA and conflicts with Blu QA allowlist; do not guess it as Vodacom.
  const vodacom = ['072', '076', '079', '082'];
  const mtn = ['073', '078', '083', '081'];
  const cellc = ['061', '062', '063', '084'];
  const telkom = ['081', '085'];

  if (telkom.includes(p3)) return 'Telkom';
  if (vodacom.includes(p3)) return 'Vodacom';
  if (mtn.includes(p3)) return 'MTN';
  if (cellc.includes(p3)) return 'Cell C';
  return 'Detected';
}

function detectNetworkCodeFromMsisdn(msisdn = '') {
  const label = detectVendorLabel(msisdn);
  if (label === 'Vodacom') return 'VODACOM';
  if (label === 'MTN') return 'MTN';
  if (label === 'Telkom') return 'TELKOM';
  if (label === 'Cell C') return 'CELLC';
  return null;
}

async function startAirtimePreviewAndConfirm({ from, account, amountCents, msisdn, intent = 'BUY_AIRTIME', rawText = '' }) {
  const previewUrl = apiUrl('/api/vas/airtime/preview');
  logInternalFetchCall({ url: previewUrl, path: '/api/vas/airtime/preview' });

  const previewRes = await fetch(previewUrl, {
    method: 'POST',
    headers: withInternalHeaders(),
    body: JSON.stringify({
      accountId: account.id,
      msisdn,
      amountCents,
    }),
  });

  await logInternalFetchResponse({ url: previewUrl, res: previewRes });

  const previewData = previewRes.headers.get('content-type')?.includes('application/json')
    ? await previewRes.json()
    : { ok: false, error: 'NON_JSON', message: 'Non-JSON response from preview' };

  if (!previewData.ok) {
    return await sendWhatsAppText({
      to: from,
      text: `❌ ${previewData.message || 'Could not process airtime purchase.'}\n\nPlease try again later.`,
    });
  }

  const vendorName = previewData.preview?.vendorName || detectVendorLabel(msisdn);

  logSlotFill({
    intent,
    text: rawText,
    slots: { amountCents, msisdn, productHint: 'AIRTIME' },
    routeDecision: 'AIRTIME_CONFIRM',
    missing: [],
    from,
    accountId: account.id,
  });

  await updateConversationState(from, 'AIRTIME_CONFIRM', {
    amountCents,
    msisdn,
    vendorLabel: vendorName,
    previewId: previewData.previewId,
  });

  return await sendWhatsAppText({
    to: from,
    text:
      `📱 *Confirm Airtime Purchase*\n\n` +
      `Amount: R${(amountCents / 100).toFixed(0)}\n` +
      `Number: ${msisdn} (${vendorName})\n\n` +
      `Reply *YES* to confirm or *NO* to cancel.`,
  });
}

/** Rand display from integer cents: R53, or R53.50 when there are cents. */
function randsShort(cents) {
  return `R${((cents || 0) / 100).toFixed(2).replace(/\.00$/, '')}`;
}

/**
 * True when an in-state message is clearly conversational free text (a
 * question, a sentence) rather than the slot the state is waiting for.
 * States must ESCAPE to the normal router on these — answering "Can I use
 * my bank card?" with "Invalid Voucher PIN" reads as a broken bot
 * (observed live, 2026-08-20). Slot-like inputs (PINs, amounts, numbers)
 * carry at most one short word; real sentences carry two or more.
 */
function isConversationalEscape(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  const words = s.match(/[a-zA-Z]{2,}/g) || [];
  return words.length >= 2 || /\?$/.test(s);
}

/**
 * Voucher gift ("Send R50 to 084...") — preview then confirm, mirroring
 * startAirtimePreviewAndConfirm: self-HTTP to /api/vas/voucher/preview, park
 * the previewId in VOUCHER_GIFT_CONFIRM state, and ask for YES/NO. The PIN
 * step (VOUCHER_GIFT_PIN) executes against the same previewId.
 */
async function startVoucherGiftPreviewAndConfirm({ from, account, amountCents, recipientMsisdn, intent = 'VOUCHER_GIFT', rawText = '' }) {
  const previewUrl = apiUrl('/api/vas/voucher/preview');
  logInternalFetchCall({ url: previewUrl, path: '/api/vas/voucher/preview' });

  const previewRes = await fetch(previewUrl, {
    method: 'POST',
    headers: withInternalHeaders(),
    body: JSON.stringify({
      accountId: account.id,
      amountCents,
      recipientMsisdn,
    }),
  });

  await logInternalFetchResponse({ url: previewUrl, res: previewRes });

  const previewData = previewRes.headers.get('content-type')?.includes('application/json')
    ? await previewRes.json()
    : { ok: false, error: 'NON_JSON', message: 'Non-JSON response from preview' };

  if (!previewData.ok) {
    // Short balance is a CHECKOUT moment, not an error — quote the
    // shortfall, hand over the PayFast link, resume when the money lands
    // (QA 2026-08-21: this path previously dead-ended with a generic error).
    if (previewData.error === 'INSUFFICIENT_FUNDS') {
      const totalCents = Number.isInteger(previewData.totalCents)
        ? previewData.totalCents
        : amountCents;
      const availableCents = Number.isInteger(previewData.availableBalance)
        ? previewData.availableBalance
        : 0;
      const shortfallCents = Math.max(totalCents - availableCents, MIN_DEPOSIT_CENTS);
      await sendWhatsAppText({
        to: from,
        text:
          `💰 You need ${randsShort(totalCents)} for this voucher but your balance is ${randsShort(availableCents)}.\n\n` +
          `Pay the ${randsShort(shortfallCents)} difference with the button below — the moment it lands, I'll finish your voucher. 🎟️\n\n` +
          `(Prefer cash? Buy a Blu Voucher at any till and send me the code.)`,
      });
      const linkResult = await handleCardDepositLink({
        from,
        account,
        amountCents: shortfallCents,
        rawText,
      });
      await updateConversationState(from, 'RESUME_VOUCHER_PURCHASE', {
        amountCents,
        recipientMsisdn,
      });
      return linkResult;
    }

    await updateConversationState(from, null);
    return await sendWhatsAppText({
      to: from,
      text: `❌ ${previewData.message || 'Could not process the voucher gift.'}\n\nPlease try again later.`,
    });
  }

  const feeCents = previewData.feeCents;
  const totalCents = previewData.totalCents;
  const normalisedRecipient = previewData.recipientMsisdn || normaliseMsisdn(recipientMsisdn);

  logSlotFill({
    intent,
    text: rawText,
    slots: { amountCents, msisdn: normalisedRecipient, productHint: 'VOUCHER' },
    routeDecision: 'VOUCHER_GIFT_CONFIRM',
    missing: [],
    from,
    accountId: account.id,
  });

  await updateConversationState(from, 'VOUCHER_GIFT_CONFIRM', {
    amountCents,
    feeCents,
    totalCents,
    recipientMsisdn: normalisedRecipient,
    previewId: previewData.previewId,
  });

  // The FULL recipient number, deliberately unmasked: this is the sender's
  // one chance to catch a wrong destination before a bearer voucher goes
  // out — a number can reach here from a model slot, so a mask would hide
  // exactly the digits that need checking. Masking stays for logs.
  // A SELF-purchase ("buy an OTT voucher") skips the destination talk: the
  // PIN lands right here.
  const isSelfPurchase =
    normaliseMsisdn(normalisedRecipient) === normaliseMsisdn(account.msisdn || '');
  const confirmMsg = isSelfPurchase
    ? `🎟️ *Confirm OTT Voucher*\n\n` +
      `Voucher: ${randsShort(amountCents)}\n` +
      (feeCents > 0 ? `Fee: ${randsShort(feeCents)}\nTotal: ${randsShort(totalCents)}\n` : `No fee — paid from your balance.\n`) +
      `\n` +
      `Your voucher PIN will be delivered right here — spend it online at any store that accepts OTT vouchers.\n\n` +
      `Reply *YES* to confirm or *NO* to cancel.`
    : `🎁 *Confirm WaPay Voucher*\n\n` +
      `Voucher: ${randsShort(amountCents)}\n` +
      `Fee: ${randsShort(feeCents)}\n` +
      `Total: ${randsShort(totalCents)}\n` +
      `To: ${normalisedRecipient}\n\n` +
      `Please check the number carefully. They'll get a WaPay voucher they can spend online at any store that accepts OTT vouchers.\n\n` +
      `Reply *YES* to confirm or *NO* to cancel.`;

  await addToConversationHistory(from, 'assistant', confirmMsg);
  return await sendWhatsAppText({ to: from, text: confirmMsg });
}

function logInternalFetchCall({ url, path, method = 'POST' }) {
  logStructured('internal_fetch_call', { url, path, method });
}

async function logInternalFetchResponse({ url, res }) {
  const contentType = res.headers.get('content-type') || '';
  const status = res.status;
  const path = url.replace(/https?:\/\/[^/]+/, '');
  const entry = { url, path, status, contentType };

  if (!contentType.includes('application/json')) {
    const bodyText = await res.text();
    entry.bodyPrefix = bodyText.slice(0, 200);
    logStructured('internal_fetch_response_non_json', entry);
    return { contentType, bodyText, status };
  }

  logStructured('internal_fetch_response', entry);
  return { contentType, status };
}

function withInternalHeaders(extra = {}) {
  return { ...internalJsonHeaders(), ...extra };
}

function isHomeTrigger(text = '') {
  const t = text.trim().toLowerCase();
  return /^(hi|hello|hey|start|menu|home|help)$/i.test(t);
}

function formatMoneyZar(amountRandsString = '0.00') {
  const num = Number(amountRandsString);
  if (Number.isFinite(num)) return `R${num.toFixed(2)}`;
  return `R${amountRandsString}`;
}

function formatDateTimeZa(date = new Date()) {
  try {
    return new Date(date).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date().toLocaleString('en-ZA');
  }
}

async function sendReceipt({ to, productLabel, targetLabel, targetValue, network, amountCents, reference, newBalanceCents, dateTime, extraLines = [] }) {
  const receipt =
    `✅ ${productLabel} purchase successful!\n\n` +
    `${targetLabel}: ${targetValue}\n` +
    `🌐 Network: ${network}\n` +
    `💰 Amount: R${(amountCents / 100).toFixed(2)}\n` +
    (Array.isArray(extraLines) && extraLines.length ? `${extraLines.join('\n')}\n` : '') +
    `🧾 Reference: ${reference}\n` +
    `📅 ${formatDateTimeZa(dateTime)}\n\n` +
    `💳 New balance: R${(newBalanceCents / 100).toFixed(2)}`;

  await addToConversationHistory(to, 'assistant', receipt);
  return await sendWhatsAppText({ to, text: receipt });
}

/**
 * WhatsApp Cloud API `to` must be international format (27...), while the VAS
 * flows carry local 0XXXXXXXXX. Account waIds are already 27-prefixed.
 */
function waIdFromMsisdn(msisdn = '') {
  const m = normaliseMsisdn(msisdn);
  if (m.length === 10 && m.startsWith('0')) return `27${m.slice(1)}`;
  return m;
}

/**
 * Notify the recipient of a gifted purchase (purchase target !== buyer).
 *
 * Invariants:
 * - The buyer has already been debited and the vend has settled; this
 *   notification is best-effort and must NEVER throw, fail, or retry the
 *   purchase. All failures are swallowed and logged as gift_notify_failed.
 * - A recipient who has never messaged WaPay is outside the 24h session
 *   window, so the approved template is tried FIRST; free text is only a
 *   fallback for recipients with an open session.
 */
async function notifyGiftRecipient({ account, recipientMsisdn, product, amountCents }) {
  try {
    const buyerMsisdn = normaliseMsisdn(account?.msisdn || '');
    const targetMsisdn = normaliseMsisdn(recipientMsisdn || '');
    // Self top-up is not a gift; missing target means nothing to notify.
    if (!targetMsisdn || targetMsisdn === buyerMsisdn) return;

    // This function fires exactly when a gift SUCCEEDED — the moment this
    // recipient becomes a beneficiary ("send to Philly again"). Best-effort,
    // like everything else in here.
    await rememberBeneficiary({ accountId: account?.id, msisdn: targetMsisdn });

    const note = buildRecipientNotification({
      senderName: account?.displayName,
      senderMsisdn: account?.msisdn,
      product,
      amountCents,
    });
    const to = waIdFromMsisdn(targetMsisdn);

    // sendWhatsAppTemplate never throws; failure is signalled via ok:false.
    const templateRes = await sendWhatsAppTemplate({
      to,
      templateName: note.templateName,
      language: note.languageCode,
      components: [
        { type: 'body', parameters: note.bodyParams.map((text) => ({ type: 'text', text })) },
      ],
    });

    if (!templateRes?.ok) {
      const textRes = await sendWhatsAppText({ to, text: note.fallbackText });
      if (!textRes?.ok) {
        logStructured('gift_notify_failed', {
          accountId: account?.id,
          product,
          amountCents,
          recipientMasked: maskMsisdn(targetMsisdn),
          templateError: templateRes?.error || 'TEMPLATE_SEND_FAILED',
          textError: textRes?.error || 'TEXT_SEND_FAILED',
        });
        return;
      }
    }

    logStructured('gift_sent', {
      accountId: account?.id,
      product,
      amountCents,
      recipientMasked: maskMsisdn(targetMsisdn),
    });
  } catch (error) {
    logStructured('gift_notify_failed', {
      accountId: account?.id,
      product,
      amountCents,
      error: error?.message,
    });
  }
}

async function sendPostTransactionCta(to) {
  const cta =
    `What would you like to do next?\n\n` +
    `• Buy more airtime\n` +
    `• Buy data\n` +
    `• Send money\n` +
    `• Go to home`;
  await addToConversationHistory(to, 'assistant', cta);
  return await sendWhatsAppText({ to, text: cta });
}

/**
 * "🎟️ Vouchers: R120 (3)" — the face value of vouchers this account bought
 * FOR ITSELF that our records still hold as live (ISSUED or DELIVERED —
 * founder ask 2026-08-24: the customer must see voucher value alongside
 * cash on the home screen).
 *
 * HONESTY: OTT does not yet tell us when an issued voucher is redeemed at
 * an accepting platform (that visibility is on the Keamo ask list), so
 * every surface says "vouchers bought" — never a promise of unspent value.
 * Gifts to OTHERS are excluded (that money was given away); the full
 * purchase list stays under "my vouchers". Best-effort: any error returns
 * null and the surface renders without the line — a balance screen must
 * never fail on the voucher query.
 */
async function voucherBalanceSummary(account) {
  try {
    const own = normaliseMsisdn(account?.msisdn || '');
    if (!own) return null;
    const rows = await prisma.pendingGift.findMany({
      where: { senderAccountId: account.id, status: { not: 'CANCELLED' } },
      select: { amountCents: true, recipientMsisdn: true },
    });
    const mine = rows.filter((r) => normaliseMsisdn(r.recipientMsisdn) === own);
    if (!mine.length) return null;
    return { totalCents: mine.reduce((s, r) => s + r.amountCents, 0), count: mine.length };
  } catch (error) {
    logStructured('voucher_balance_error', { accountId: account?.id, error: error?.message });
    return null;
  }
}

async function renderHome({ from, account }) {
  const { balance, displayName } = await getUserBalance(from);
  const vouchers = await voucherBalanceSummary(account);

  // Quick actions (best-effort). Prefer last successful VAS if available.
  let quickActions = [
    'Buy airtime',
    'Buy data',
    'Check balance',
  ];

  try {
    const last = await prisma.providerRequest.findFirst({
      where: {
        accountId: account.id,
        status: 'SUCCESS',
        route: { in: ['airtime-execute', 'data-execute', 'electricity-execute'] },
      },
      orderBy: { requestTs: 'desc' },
    });

    const meta = last?.metadata || {};
    if (last?.route === 'airtime-execute' && meta?.amountCents && meta?.msisdn) {
      const amt = (meta.amountCents / 100).toFixed(0);
      quickActions = [
        `Buy R${amt} airtime again`,
        `Buy airtime for ${meta.msisdn}`,
        'Check balance',
      ];
    }
  } catch (e) {
    // ignore
  }

  // One message, one screen: the "bank home". Three separate bubbles read
  // as clutter (user feedback 2026-08-21) and triple the send cost.
  const home =
    `👋 *Hi ${displayName}!*\n` +
    `💰 Balance: *${formatMoneyZar(balance)}*\n` +
    (vouchers
      ? `🎟️ Vouchers bought: *${randsShort(vouchers.totalCents)}* (${vouchers.count}) — reply "my vouchers"\n`
      : '') +
    `━━━━━━━━━━━━━━━\n\n` +
    `🛒 *Buy* — airtime, data, electricity\n` +
    `💸 *Send* — "send R10 airtime to 083..."\n` +
    `🙏 *Get Paid* — "please pay me R50" → share your link\n` +
    `💳 *Deposit* — "deposit R100" or a Blu voucher\n` +
    `🏧 *Withdraw* — coming soon\n` +
    `📄 *Transactions* · ⚙️ *Settings*\n\n` +
    `⚡ Quick: ${quickActions[0]} · ${quickActions[1]} · ${quickActions[2]}\n\n` +
    `Just tell me what you need — in any language.`;

  logStructured('home_render', { from, accountId: account.id });

  const localizedHome = await localizeOutbound(home, await userLang(account));
  await addToConversationHistory(from, 'assistant', localizedHome);
  await sendWhatsAppText({ to: from, text: localizedHome });

  return { ok: true };
}

function resolveAirtimeSlots({ text, entities = {}, stateData = {} }) {
  let amountCents = stateData.amountCents;
  if (!amountCents && typeof entities.amount === 'number') {
    amountCents = entities.amount * 100;
  }
  if (!amountCents) {
    const amtMatch = text.match(/r?\s?(\d+)/i);
    if (amtMatch) {
      const parsed = parseInt(amtMatch[1], 10) * 100;
      if (parsed >= 500 && parsed <= 100000) amountCents = parsed;
    }
  }

  let msisdn = stateData.msisdn || entities.msisdn;
  if (!msisdn) {
    const parsed = extractMsisdnFromText(text);
    if (parsed && isValidSaMsisdn(parsed)) {
      msisdn = normaliseMsisdn(parsed);
    }
  }

  return { amountCents, msisdn };
}

function resolveDataSlots({ text, entities = {}, stateData = {} }) {
  let msisdn = stateData.msisdn || entities.msisdn;
  if (!msisdn) {
    const parsed = extractMsisdnFromText(text);
    if (parsed && isValidSaMsisdn(parsed)) {
      msisdn = normaliseMsisdn(parsed);
    }
  }
  return { msisdn };
}

function extractAmountCents(text = '') {
  const match = text.match(/r?\s?(\d{1,5})/i);
  if (!match) return null;
  const cents = parseInt(match[1], 10) * 100;
  if (!Number.isFinite(cents)) return null;
  return cents;
}

function extractMeterNumber(text = '') {
  const m = text.match(/\b(\d{8,20})\b/);
  return m ? m[1] : null;
}

function extractGbMb(text = '') {
  const m = text.toLowerCase().match(/(\d+(?:\.\d+)?)\s*(gb|mb)\b/);
  if (!m) return null;
  const qty = Number(m[1]);
  if (!Number.isFinite(qty)) return null;
  const unit = m[2];
  const mb = unit === 'gb' ? Math.round(qty * 1024) : Math.round(qty);
  return mb;
}

function extractPeriodType(text = '') {
  const t = text.toLowerCase();
  if (t.includes('daily') || t.includes('day')) return 'DAILY';
  if (t.includes('weekly') || t.includes('week')) return 'WEEKLY';
  if (t.includes('monthly') || t.includes('month')) return 'MONTHLY';
  if (t.includes('night')) return 'NIGHT';
  return null;
}

function extractNetworkCode(text = '') {
  const t = text.toLowerCase();
  if (t.includes('vodacom')) return 'VODACOM';
  if (t.includes('mtn')) return 'MTN';
  if (t.includes('cell c') || t.includes('cellc')) return 'CELLC';
  if (t.includes('telkom')) return 'TELKOM';
  return null;
}

function resolveElectricitySlots({ text, entities = {}, stateData = {} }) {
  const amountCents = stateData.amountCents || (typeof entities.amount === 'number' ? entities.amount * 100 : null) || extractAmountCents(text);
  const meterNumber = stateData.meterNumber || entities.meterNumber || extractMeterNumber(text);
  // provider/operator is optional at this stage; can be selected later from catalogue.
  const operatorCode = stateData.operatorCode || entities.operatorCode || null;
  return { amountCents, meterNumber, operatorCode };
}

function resolvePayTvSlots({ text, entities = {}, stateData = {} }) {
  const smartcardNumber = stateData.smartcardNumber || entities.smartcardNumber || extractMeterNumber(text);
  const amountCents = stateData.amountCents || (typeof entities.amount === 'number' ? entities.amount * 100 : null) || extractAmountCents(text);
  const operatorCode = stateData.operatorCode || entities.operatorCode || (text.toLowerCase().includes('dstv') ? 'DSTV' : null);
  const packageCode = stateData.packageCode || entities.packageCode || null;
  return { smartcardNumber, amountCents, operatorCode, packageCode };
}

function resolveVoucherSlots({ text, entities = {}, stateData = {} }) {
  const amountCents = stateData.amountCents || (typeof entities.amount === 'number' ? entities.amount * 100 : null) || extractAmountCents(text);
  const operatorCode = stateData.operatorCode || entities.operatorCode || null; // netflix/showmax/etc or retail brand
  const deliveryEmail = stateData.deliveryEmail || entities.deliveryEmail || (text.includes('@') ? text.trim() : null);
  return { amountCents, operatorCode, deliveryEmail };
}

function resolveBettingSlots({ text, entities = {}, stateData = {} }) {
  const amountCents = stateData.amountCents || (typeof entities.amount === 'number' ? entities.amount * 100 : null) || extractAmountCents(text);
  const accountNumber = stateData.accountNumber || entities.accountNumber || null;
  const operatorCode = stateData.operatorCode || entities.operatorCode || null;
  return { amountCents, accountNumber, operatorCode };
}

function resolveRemittanceSlots({ text, entities = {}, stateData = {} }) {
  const amountCents = stateData.amountCents || (typeof entities.amount === 'number' ? entities.amount * 100 : null) || extractAmountCents(text);
  const country = stateData.country || entities.country || (text.toLowerCase().includes('zimbabwe') ? 'ZIMBABWE' : null);
  const recipientRef = stateData.recipientRef || entities.recipientRef || null;
  return { amountCents, country, recipientRef };
}

function resolveDataPurchaseSlots({ text, entities = {}, stateData = {} }) {
  const msisdn = resolveDataSlots({ text, entities, stateData }).msisdn;
  const dataMb = stateData.dataMb || entities.dataMb || extractGbMb(text);
  const periodType = stateData.periodType || entities.periodType || extractPeriodType(text);
  const networkCode = stateData.networkCode || entities.networkCode || extractNetworkCode(text);
  return { msisdn, dataMb, periodType, networkCode };
}

/** The user's preferred reply language ('en' when unknown). */
async function userLang(account) {
  try {
    const p = await getProfile({ accountId: account.id });
    return p?.language || 'en';
  } catch {
    return 'en';
  }
}

/**
 * Process incoming WhatsApp message
 */
export async function processMessage({ from, text, messageId, profile, sharedContact }) {
  // Log incoming message
  logStructured('whatsapp_inbound', {
    from,
    text,
    messageId,
    profileName: profile?.name,
    sharedContact: sharedContact ? { name: sharedContact.name || null } : undefined,
  });

  console.log('🔄 Processing message:', { from, text });

  // Get or create user
  const { account, isNewUser } = await getOrCreateUser(from, profile);

  // De-duplicate inbound message IDs to prevent repeated replies if Meta retries delivery
  if (messageId && (await wasMessageProcessed(from, messageId))) {
    logStructured('whatsapp_inbound_deduped', { from, messageId, accountId: account.id });
    return { ok: true, deduped: true };
  }
  if (messageId) {
    await markMessageProcessed(from, messageId);
  }

  // Get onboarding state
  const onboardingState = await getOnboardingState(account.id);

  console.log(`📊 Account state: ${onboardingState} (new: ${isNewUser})`);

  // "Receipt PRXXXXXX" — the wa.me deep link from the pay page. Answered
  // for EVERY sender BEFORE the onboarding gate: a card payer's first-ever
  // message is this ask, and the receipt must never be swallowed by the
  // welcome flow. A brand-new number then falls through into onboarding —
  // the payer-becomes-a-user hook (founder ask 2026-08-22). Everyone else
  // (established users, and mid-onboarding states whose OTP/PIN prompts
  // must not eat the code) gets the receipt and stops.
  {
    const receiptMatch = String(text || '').match(RECEIPT_CODE_PATTERN);
    if (receiptMatch) {
      await handlePaymentReceiptAsk({ from, code: receiptMatch[1].toUpperCase() });
      if (onboardingState !== 'S0_INITIAL') {
        return { ok: true, receipt: true };
      }
    }
  }

  // Explicit language choice ("speak Xhosa" / "praat Afrikaans") — set it
  // permanently and confirm IN that language, whatever state the user is in
  // (founder feedback 2026-08-25: this ask got the English help menu).
  {
    // inFlow: don't let a bare language word (a surname like "Zulu") captured
    // as a flow answer be read as a switch and swallow the message.
    const { state: activeState } = await getConversationState(from);
    const langAsk = matchLanguageSwitch(text, { inFlow: Boolean(activeState) });
    if (langAsk) {
      await setLanguage({ accountId: account.id, language: langAsk }).catch(() => {});
      await sendWhatsAppText({
        to: from,
        text: LANGUAGE_CONFIRMATIONS[langAsk] || LANGUAGE_CONFIRMATIONS.en,
      });
      return { ok: true, languageSet: langAsk };
    }
  }

  // Handle onboarding flow
  if (onboardingState !== 'S5_COMPLETED') {
    return await handleOnboardingFlow({
      account,
      from,
      text,
      profile,
      onboardingState,
    });
  }

  // A shared contact card is a recipient, not a text — route it before any
  // text-based handling ("send money to this person in my contacts").
  if (sharedContact) {
    return await handleSharedContact({ from, account, sharedContact });
  }

  // User is fully onboarded - handle normal operations
  return await handlePostOnboarding({
    account,
    from,
    text,
  });
}

/**
 * A shared WhatsApp contact card. Whatever the conversation is doing, the
 * card means "this person": mid-flow it fills the number the flow is
 * waiting for; fresh, it starts a send-money ask. Every share is also
 * remembered as a beneficiary, so next time the NAME alone works
 * ("send R50 to Philly").
 */
async function handleSharedContact({ from, account, sharedContact }) {
  const msisdn = normaliseMsisdn(String(sharedContact?.rawNumber || ''));
  const name = sharedContact?.name || null;

  if (!msisdn || !isValidSaMsisdn(msisdn)) {
    return await sendWhatsAppText({
      to: from,
      text: `🤔 I couldn't read a South African cellphone number from that contact. Please reply with the number itself (e.g. 0781234567).`,
    });
  }

  await rememberBeneficiary({ accountId: account.id, msisdn, name });

  const { state, data } = await getConversationState(from);

  // Mid-flow: the contact IS the number the flow is asking for.
  if (state === 'VOUCHER_GIFT_RECIPIENT' || state === 'AIRTIME_MSISDN') {
    return await handleConversationState({ from, text: msisdn, state, data, account });
  }

  // Any OTHER active flow (electricity, deposit amount, a pending confirm…)
  // must not be silently hijacked into send-money (QA 2026-08-21). The
  // contact is saved; the user decides what happens next.
  if (state) {
    const name2 = name ? ` (${name})` : '';
    return await sendWhatsAppText({
      to: from,
      text: `👤 Contact saved${name2}. You're busy with another step — finish it or reply "cancel" first, then say "send R50 to ${name || msisdn}" whenever you're ready.`,
    });
  }

  // Fresh share: treat it as "send money to this person" and ask the amount.
  await updateConversationState(from, 'VOUCHER_GIFT_AMOUNT', { recipientMsisdn: msisdn });
  const label = name ? `${name} (${msisdn})` : msisdn;
  const msg =
    `💸 *Send money to ${label}*\n\n` +
    `How much would you like to send? For example "R50".\n\n` +
    `They'll get a WaPay voucher they can spend online at any store that accepts OTT vouchers. Reply "cancel" to stop.`;
  await addToConversationHistory(from, 'assistant', msg);
  return await sendWhatsAppText({ to: from, text: msg });
}

/**
 * Handle onboarding flow (S0 → S5)
 */
async function handleOnboardingFlow({ account, from, text, profile, onboardingState }) {
  const displayName = profile?.name || account.displayName || 'Friend';

  switch (onboardingState) {
    case 'S0_INITIAL':
      // First message - send welcome
      return await handleS0Initial({
        accountId: account.id,
        waId: from,
        displayName,
      });

    case 'S1_WELCOME_SENT':
      // User responded to welcome - send OTP
      return await handleS1WelcomeSent({
        accountId: account.id,
        waId: from,
        msisdn: account.msisdn,
        displayName,
        userMessage: text,
      });

    case 'S2_OTP_SENT':
      // User entered OTP - verify it
      // Check for "resend" request
      if (/resend|new code|send again/i.test(text)) {
        return await handleResendOTP({
          accountId: account.id,
          waId: from,
          displayName,
        });
      }
      
      return await handleS2OtpSent({
        accountId: account.id,
        waId: from,
        displayName,
        userMessage: text,
      });

    case 'S3_OTP_VERIFIED':
      // User entered PIN - set it
      return await handleS3OtpVerified({
        accountId: account.id,
        waId: from,
        displayName,
        userMessage: text,
      });

    case 'S4_PIN_SET':
      // User accepted consent - complete onboarding
      return await handleS4PinSet({
        accountId: account.id,
        waId: from,
        displayName,
        userMessage: text,
      });

    default:
      console.error(`❌ Unknown onboarding state: ${onboardingState}`);
      return { ok: false, error: 'Unknown state' };
  }
}

/**
 * Handle post-onboarding operations (normal banking)
 */
async function handlePostOnboarding({ account, from, text }) {
  console.log('💬 Post-onboarding message:', text);

  // ==========================================================================
  // VOUCHER GIFT CLAIM DELIVERY — before any routing. If someone sent this
  // number a WaPay voucher, hand it over now, then continue as normal.
  // claimPendingGifts marks each row DELIVERED atomically (ISSUED -> DELIVERED
  // guard), so a crash or a concurrent webhook can never double-deliver, and a
  // failure here must never break message routing.
  // The claim message carries the FULL voucher PIN by design: send it via
  // WhatsApp only — never log it and never store it in conversation history.
  // ==========================================================================
  try {
    if (await hasPendingGifts({ recipientMsisdn: account.msisdn })) {
      const gifts = await claimPendingGifts({ recipientMsisdn: account.msisdn });
      for (const gift of gifts) {
        let senderName = null;
        try {
          const sender = await prisma.account.findUnique({ where: { id: gift.senderAccountId } });
          senderName = sender?.displayName || null;
        } catch (senderLookupError) {
          // Name is cosmetic; the gift still gets delivered.
        }

        const claimSend = await sendWhatsAppText({
          to: from,
          text: buildVoucherClaimMessage({
            senderName,
            amountCents: gift.amountCents,
            pin: gift.voucherPin,
            serial: gift.voucherSerial,
          }),
        });
        if (claimSend?.ok === false) {
          // The PIN definitively did not reach the recipient — put the gift
          // back so the next message retries (bearer PIN must never strand).
          await revertGiftDelivery({ giftId: gift.id }).catch(() => {});
          logStructured('voucher_gift_claim_send_failed_reverted', {
            from,
            giftId: gift.id,
            error: claimSend?.error,
          });
          continue;
        }

        logStructured('voucher_gift_claim_delivered', {
          from,
          accountId: account.id,
          giftId: gift.id,
          amountCents: gift.amountCents,
          rail: gift.rail,
          recipientMasked: maskMsisdn(account.msisdn),
        });
      }
    }
  } catch (claimError) {
    logStructured('voucher_gift_claim_failed', {
      from,
      accountId: account.id,
      error: claimError?.message,
    });
  }

  // Check if user is in a conversation state (e.g., entering voucher PIN)
  const { state, data } = await getConversationState(from);

  if (state) {
    // Universal intent-switch escape (founder feedback 2026-08-25): a
    // clearly-stated NEW intent always beats a waiting state — flows must
    // never trap. Same-family messages ("R50" while airtime asks for an
    // amount) stay in the flow; PIN digits never look like intents.
    const switched = detectStrongIntentSwitch(text, state);
    if (switched) {
      logStructured('state_escape_intent_switch', { from, state, to: switched });
      await updateConversationState(from, null);
      // fall through to fresh routing below
    } else {
      console.log('💬 User in conversation state:', state);
      return await handleConversationState({ from, text, state, data, account });
    }
  }

  // Home triggers (never interrupt active flows; we already returned above if state exists)
  if (isHomeTrigger(text)) {
    await updateConversationState(from, null);
    return await renderHome({ from, account });
  }

  // Unified slot parsing: MUST happen before routing decisions and before any state transitions.
  const slots = parseSlots(text, { waId: from, accountId: account.id });

  // Deterministic short-circuit BEFORE context-aware category handling:
  // If we already have complete commerce slots, do not allow activeCategory to hijack routing.
  if (slots?.productHint === 'AIRTIME' && slots.amountCents && slots.msisdn) {
    logSlotFill({
      intent: 'PRE_ROUTING',
      text,
      slots,
      routeDecision: 'AIRTIME_PREVIEW_CONFIRM',
      missing: [],
      from,
      accountId: account.id,
    });
    return await startAirtimePreviewAndConfirm({
      from,
      account,
      amountCents: slots.amountCents,
      msisdn: slots.msisdn,
      intent: 'PRE_ROUTING',
      rawText: text,
    });
  }

  // Deterministic short-circuit: an explicit card/EFT deposit request
  // ("deposit R100") must never be hijacked by an active browse category —
  // its bare amount would otherwise read as a category follow-up (e.g.
  // R100 airtime). No PIN gate: the money is coming IN, not out.
  const cardDepositCents = !matchDepositStatusRequest(text) && matchCardDepositRequest(text);
  if (cardDepositCents) {
    // Memory-aware (founder, 2026-08-20): offer BOTH load methods unless we
    // know how this customer pays. A successful card deposit or voucher
    // redemption records the preference; after that, straight to their rail.
    const depositProfile = await getProfile({ accountId: account.id });
    if (!depositProfile.preferredDepositMethod) {
      await updateConversationState(from, 'AWAITING_DEPOSIT_METHOD', { amountCents: cardDepositCents });
      return await sendWhatsAppText({
        to: from,
        text:
          `💰 Adding ${randsShort(cardDepositCents)} to WaPay — how would you like to pay?\n\n` +
          `1️⃣ *Cash* — Blu Voucher at any till (send me the code)\n` +
          `2️⃣ *Card / bank* — secure PayFast link\n\nReply *1* or *2*.`,
      });
    }
    logSlotFill({
      intent: 'DEPOSIT_CARD',
      text,
      slots: { ...slots, amountCents: cardDepositCents },
      routeDecision: 'DEPOSIT_CARD_LINK',
      missing: [],
      from,
      accountId: account.id,
    });
    return await handleCardDepositLink({ from, account, amountCents: cardDepositCents, rawText: text });
  }

  // "Buy 100 minutes" — minutes are not rand (100 MTN minutes is not R100).
  // Clarify instead of silently equating (founder screenshot 2026-08-25).
  {
    const mins = /\b(?:buy|get|want|need|koop|thenga)\b[^\n]{0,30}?\b(\d{1,4})\s*min(?:ute)?s?\b/i.exec(text);
    if (mins && !/\b(data|bundle)\b/i.test(text)) {
      const msg =
        `📱 Airtime is sold in *rand*, not minutes — call minutes depend on your network's rates.\n\n` +
        `How many rand of airtime would you like? For example *R50 airtime*.`;
      await addToConversationHistory(from, 'assistant', msg);
      return await sendWhatsAppText({ to: from, text: await localizeOutbound(msg, await userLang(account)) });
    }
  }

  // Deterministic short-circuit: voucher HISTORY ("my vouchers") and
  // PIN-gated PIN resend ("voucher pin <serial tail>") — the founder's
  // voucher-storage ask (2026-08-20): every bought voucher is queryable.
  if (/(?:\b(?:my|show|list)\b[^\n]{0,20}\bvouchers?\b)|voucher history/i.test(text) && !/\d{6,}/.test(text)) {
    return await handleVoucherHistory({ from, account });
  }
  {
    const resendMatch = text.trim().match(/^voucher\s+pin\s+(\d{4,20})$/i);
    if (resendMatch) {
      return await startVoucherPinResend({ from, account, serialTail: resendMatch[1] });
    }
  }

  // Deterministic short-circuit: "Pay request PRXXXXXX" (the deep link from
  // a payment-request page) starts the free balance-pay confirm flow.
  {
    const payReqMatch = text.match(PAY_REQUEST_CODE_PATTERN);
    if (payReqMatch) {
      logSlotFill({
        intent: 'PAY_REQUEST',
        text,
        slots,
        routeDecision: 'PAY_REQUEST_CONFIRM',
        missing: [],
        from,
        accountId: account.id,
      });
      return await handlePayRequestStart({ from, account, code: payReqMatch[1].toUpperCase(), rawText: text });
    }
  }

  // Deterministic short-circuit: "cancel request PRXXXXXX".
  {
    const cancelMatch = text.match(/\bcancel\w*\s+(?:my\s+)?request\s+(PR[A-Z]{6})\b/i);
    if (cancelMatch) {
      const cancelled = await cancelPaymentRequest({
        code: cancelMatch[1].toUpperCase(),
        accountId: account.id,
      });
      return await sendWhatsAppText({
        to: from,
        text: cancelled
          ? `👍 Payment request ${cancelMatch[1].toUpperCase()} cancelled — the link no longer works.`
          : `🤔 I couldn't cancel that request — it may already be paid, cancelled, or not yours.`,
      });
    }
  }

  // Deterministic short-circuit: "change my amount to R1000" — swap the
  // newest pending request in one step (cancel + recreate).
  if (matchChangeRequestAmount(text, slots)) {
    logSlotFill({
      intent: 'REQUEST_MONEY_CHANGE',
      text,
      slots,
      routeDecision: 'REQUEST_MONEY_SWAP',
      missing: [],
      from,
      accountId: account.id,
    });
    return await handleChangeRequestAmount({ from, account, amountCents: slots.amountCents, rawText: text });
  }

  // Deterministic short-circuit: "please pay me" — create a payment request.
  if (matchRequestMoneyAsk(text, slots)) {
    logSlotFill({
      intent: 'REQUEST_MONEY',
      text,
      slots,
      routeDecision: slots.amountCents ? 'REQUEST_MONEY_CREATE' : 'REQUEST_MONEY_AMOUNT',
      missing: slots.amountCents ? [] : ['amountCents'],
      from,
      accountId: account.id,
    });
    return await handleCreatePaymentRequest({ from, account, amountCents: slots.amountCents, rawText: text });
  }

  // Deterministic short-circuit: "buy an OTT voucher" (no recipient) is a
  // SELF-purchase — balance-paid, PIN delivered in this chat. Routed before
  // the AI so the phrase can never fall into the old entertainment-voucher
  // listing (observed live 2026-08-20). Redemption-ish phrasings ("redeem /
  // load / I have an OTT voucher") stay out — that's the future deposit path.
  if (matchOttVoucherSelfRequest(text, slots)) {
    logSlotFill({
      intent: 'OTT_VOUCHER_SELF',
      text,
      slots,
      routeDecision: slots.amountCents ? 'OTT_VOUCHER_SELF_PREVIEW' : 'OTT_VOUCHER_SELF_AMOUNT',
      missing: slots.amountCents ? [] : ['amountCents'],
      from,
      accountId: account.id,
    });
    if (slots.amountCents) {
      return await startVoucherGiftPreviewAndConfirm({
        from,
        account,
        amountCents: slots.amountCents,
        recipientMsisdn: account.msisdn,
        intent: 'OTT_VOUCHER_SELF',
        rawText: text,
      });
    }
    await updateConversationState(from, 'VOUCHER_GIFT_AMOUNT', { recipientMsisdn: account.msisdn });
    const askMsg = `🎟️ *OTT Voucher*\n\nHow much would you like your voucher for? (R10–R1000)\n\nFor example "R50" — or reply "cancel" to stop.`;
    await addToConversationHistory(from, 'assistant', askMsg);
    return await sendWhatsAppText({ to: from, text: askMsg });
  }

  // Deterministic short-circuit: deposit-status questions ("did my payment
  // go through", "where is my money") are answered from the intent table +
  // ledger, BEFORE the AI can see them — the AI must never invent
  // transaction status.
  if (matchDepositStatusRequest(text)) {
    logSlotFill({
      intent: 'DEPOSIT_STATUS',
      text,
      slots,
      routeDecision: 'DEPOSIT_STATUS_LOOKUP',
      missing: [],
      from,
      accountId: account.id,
    });
    return await handleDepositStatus({ from, account });
  }

  // =====================================================================
  // CONTEXT-AWARE INTENT DETECTION
  // Check if user was recently browsing a category - interpret follow-ups
  // in that context instead of defaulting to airtime
  // =====================================================================
  const categoryContext = await getActiveCategory(from);
  const normalized = text.toLowerCase().trim();
  
  if (categoryContext.isValid && categoryContext.category) {
    const category = categoryContext.category;
    // 9+ digits is a phone or meter number, never a rand amount.
    const amountMatch = text.match(/r?\s?(\d{1,6})(?!\d)/i);
    
    // Check if this looks like a follow-up to the category they were browsing
    const isFollowUp = amountMatch || 
                       /^(yes|ok|buy|get|top\s*up|1|2|3|first|second|that\s*one)$/i.test(normalized) ||
                       /^r?\d+/i.test(normalized);

    // If the user explicitly mentions a different product than the active category, do NOT hijack.
    // This is the core regression that caused airtime messages to be routed to DATA bundles.
    const categoryMismatch = slots?.productHint && slots.productHint !== category;
    
    if (isFollowUp && !categoryMismatch) {
      console.log(`🎯 Context-aware: User was browsing ${category}, interpreting "${text}" in that context`);
      
      logStructured('context_aware_intent', {
        from,
        text,
        category,
        amountMatch: amountMatch?.[1],
        categoryTimestamp: categoryContext.timestamp,
      });
      
      // Clear the category context since we're acting on it
      await clearActiveCategory(from);
      
      // Route to appropriate category handler
      const amount = amountMatch ? parseInt(amountMatch[1]) : null;
      
      switch (category) {
        case 'GAMING':
          if (!isCategoryLive('GAMING')) {
            return await replyCategoryUnavailable(from, 'GAMING');
          }
          return await handleListGamingProducts({ from, account });
          
        case 'LIFESTYLE':
          if (!isCategoryLive('LIFESTYLE')) {
            return await replyCategoryUnavailable(from, 'LIFESTYLE');
          }
          return await handleListLifestyleProducts({ from, account });
          
        case 'ELECTRICITY':
          if (!isCategoryLive('ELECTRICITY')) {
            return await replyCategoryUnavailable(from, 'ELECTRICITY');
          }
          // Electricity purchase flow - start it
          if (amount) {
            logSlotFill({
              intent: 'CONTEXT_AWARE',
              text,
              slots,
              routeDecision: 'ELECTRICITY_METER',
              missing: ['meterNumber'],
              from,
              accountId: account.id,
            });
            await updateConversationState(from, 'ELECTRICITY_METER', { amountCents: amount * 100 });
            return await sendWhatsAppText({
              to: from,
              text: `💡 *Buy R${amount} Electricity*\n\nPlease enter your meter number:`,
            });
          }
          return await handleListElectricityProducts({ from, account });
          
        case 'AIRTIME':
          // Airtime flow - start it
          if (amount) {
            logSlotFill({
              intent: 'CONTEXT_AWARE',
              text,
              slots,
              routeDecision: 'AIRTIME_MSISDN',
              missing: ['msisdn'],
              from,
              accountId: account.id,
            });
            await updateConversationState(from, 'AIRTIME_MSISDN', { amountCents: amount * 100 });
            return await sendWhatsAppText({
              to: from,
              text: await localizeOutbound(`📱 *Buy R${amount} Airtime*\n\nWhich phone number should I send the airtime to?\n\nReply with the number (e.g., 0781234567) or "me" for your own number.`, await userLang(account)),
            });
          }
          return await handleListAirtimeBundles({ from, account, networkCode: null });
          
        case 'DATA':
          // Data flow
          return await handleListDataBundles({ from, account, entities: {} });
          
        default:
          // Unknown category - fall through to normal detection
          break;
      }
    }

    if (categoryMismatch) {
      // Clear stale context so normal routing can proceed.
      await clearActiveCategory(from);
    }
  }

  // Detect ONLY explicit intents, route everything else to AI
  const detection = detectExplicitIntent(text);
  // Deterministic commerce routing overrides (prevents SMART_PRODUCT_QUERY bypass).
  // If slots are complete for a product, force the correct intent.
  if (slots?.productHint === 'AIRTIME' && slots.amountCents && slots.msisdn) {
    detection.intent = 'BUY_AIRTIME';
    detection.entities = { ...(detection.entities || {}), amount: Math.round(slots.amountCents / 100), msisdn: slots.msisdn };
  }
  if (slots?.productHint === 'DATA' && slots.dataMb) {
    detection.intent = 'BUY_DATA';
    detection.entities = {
      ...(detection.entities || {}),
      msisdn: slots.msisdn,
      dataMb: slots.dataMb,
      periodType: slots.periodType,
      networkCode: slots.networkCode,
    };
  }

  // Bare cash send ("Send R30 to 084...", "send money") — V1 has no
  // person-to-person cash rail. Instead the sender buys a WaPay VOUCHER (a
  // GOODS voucher, OTT-issued) that the recipient can spend online or cash
  // out via OTT's own rails. Explicit intents keep priority (e.g. "load
  // money via bank transfer" is still a deposit); only the would-be generic
  // AI / remittance dead-end enters the voucher-gift flow. The copy lives in
  // resolveGift (VOUCHER_GIFT + ask kinds) so flow and tests share it.
  if (
    slots?.productHint === 'SEND_MONEY' &&
    (detection.intent === 'AI_CHAT' || detection.intent === 'SMART_PRODUCT_QUERY')
  ) {
    const gift = resolveGift({ slots, senderMsisdn: account.msisdn });

    if (gift.kind === 'VOUCHER_GIFT') {
      logSlotFill({
        intent: detection.intent,
        text,
        slots,
        routeDecision: 'VOUCHER_GIFT_PREVIEW_CONFIRM',
        missing: [],
        from,
        accountId: account.id,
      });
      return await startVoucherGiftPreviewAndConfirm({
        from,
        account,
        amountCents: gift.amountCents,
        recipientMsisdn: gift.recipientMsisdn,
        intent: detection.intent,
        rawText: text,
      });
    }

    if (gift.kind === 'NEEDS_AMOUNT' || gift.kind === 'NEEDS_RECIPIENT' || gift.kind === 'INVALID_RECIPIENT') {
      const nextState = gift.kind === 'NEEDS_AMOUNT' ? 'VOUCHER_GIFT_AMOUNT' : 'VOUCHER_GIFT_RECIPIENT';
      logSlotFill({
        intent: detection.intent,
        text,
        slots,
        routeDecision: nextState,
        missing: gift.kind === 'NEEDS_AMOUNT' ? ['amountCents'] : ['msisdn'],
        from,
        accountId: account.id,
      });
      await updateConversationState(from, nextState, {
        amountCents: gift.amountCents || null,
        // parseSlots only surfaces validated msisdns, so a NEEDS_AMOUNT ask
        // can already carry the recipient forward.
        recipientMsisdn: gift.kind === 'NEEDS_AMOUNT' && slots.msisdn ? slots.msisdn : null,
      });
      await addToConversationHistory(from, 'assistant', gift.message);
      return await sendWhatsAppText({ to: from, text: gift.message });
    }
  }

  const intent = detection.intent;
  
  // Log NLP intent detection
  logStructured('nlp_intent', {
    from,
    text,
    intent,
    confidence: detection.confidence,
    entities: detection.entities || {},
    triggerAction: detection.triggerAction || false,
  });
  
  console.log('🎯 Intent check:', { intent, text, detection });

  try {
    switch (intent) {
      case 'CHECK_BALANCE':
        // Explicit: "balance"
        const { balance, displayName } = await getUserBalance(from);
        return await sendWhatsAppText({
          to: from,
          text: `💰 *Your WaPay Balance*\n\nHi ${displayName}!\n\n💵 Current Balance: R ${balance}\n\nNeed anything else? Just ask me!`,
        });

      case 'HELP':
        // Explicit: "help" or "menu"
        return await sendWhatsAppText({
          to: from,
          text: `👋 Hi! I'm your WaPay assistant.\n\nJust talk to me naturally! For example:\n• "How much money do I have?"\n• "I want to buy R50 airtime"\n• "How do I redeem a voucher?"\n• "Hoe werk WaPay?" (Afrikaans)\n\nI speak all 11 SA languages! 🇿🇦`,
        });

      case 'REDEEM_VOUCHER':
        // Explicit: "redeem voucher"
        logSlotFill({
          intent: 'REDEEM_VOUCHER',
          text,
          slots,
          routeDecision: 'AWAITING_VOUCHER_PIN',
          missing: [],
          from,
          accountId: account.id,
        });
        await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
        return await sendWhatsAppText({
          to: from,
          text: buildDepositPrompt(),
        });
      case 'VOUCHER_PIN':
        await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
        return await handleVoucherRedemption({ from, pin: detection.voucherPin || text, account });

      case 'BUY_AIRTIME':
        // User wants to buy airtime - start airtime flow
        logStructured('vas_airtime_flow_start', {
          from,
          accountId: account.id,
          entities: detection.entities,
        });
        
        const airtimeSlots = resolveAirtimeSlots({ text, entities: detection.entities });
        const slotsComplete = airtimeSlots.amountCents && airtimeSlots.msisdn && isValidSaMsisdn(airtimeSlots.msisdn);

        logStructured('slot_fill_airtime', {
          from,
          accountId: account.id,
          amountCents: airtimeSlots.amountCents,
          msisdn: airtimeSlots.msisdn,
          missingAmount: !airtimeSlots.amountCents,
          missingMsisdn: !airtimeSlots.msisdn,
          slotsComplete,
        });

        if (slotsComplete) {
          logSlotFill({
            intent: 'BUY_AIRTIME',
            text,
            slots: { ...slots, amountCents: airtimeSlots.amountCents, msisdn: airtimeSlots.msisdn, productHint: 'AIRTIME' },
            routeDecision: 'AIRTIME_PREVIEW_CONFIRM',
            missing: [],
            from,
            accountId: account.id,
          });
          const normalisedMsisdn = normaliseMsisdn(airtimeSlots.msisdn);
          return await startAirtimePreviewAndConfirm({
            from,
            account,
            amountCents: airtimeSlots.amountCents,
            msisdn: normalisedMsisdn,
            intent: 'BUY_AIRTIME',
            rawText: text,
          });
        }

        // If we have amount but no MSISDN, jump to msisdn collection
        if (airtimeSlots.amountCents) {
          logSlotFill({
            intent: 'BUY_AIRTIME',
            text,
            slots: { ...slots, amountCents: airtimeSlots.amountCents, productHint: 'AIRTIME' },
            routeDecision: 'AIRTIME_MSISDN',
            missing: ['msisdn'],
            from,
            accountId: account.id,
          });
          await updateConversationState(from, 'AIRTIME_MSISDN', { amountCents: airtimeSlots.amountCents });
          return await sendWhatsAppText({
            to: from,
            text: await localizeOutbound(`📱 *Buy R${airtimeSlots.amountCents / 100} Airtime*\n\nWhich phone number should I send the airtime to?\n\nReply with the number (e.g., 0781234567) or "me" for your own number.`, await userLang(account)),
          });
        }
        
        // Otherwise collect amount first
        logSlotFill({
          intent: 'BUY_AIRTIME',
          text,
          slots: { ...slots, productHint: 'AIRTIME' },
          routeDecision: 'AIRTIME_AMOUNT',
          missing: ['amountCents'],
          from,
          accountId: account.id,
        });
        await updateConversationState(from, 'AIRTIME_AMOUNT', detection.entities || {});
        return await sendWhatsAppText({
          to: from,
          text: `📱 *Buy Airtime*\n\nHow much airtime would you like to buy?\n\nReply with an amount (e.g., R10, R50, R100)`,
        });

      case 'BUY_DATA':
        logStructured('vas_data_flow_start', {
          from,
          accountId: account.id,
          entities: detection.entities,
        });

        if (!isCategoryLive('DATA')) {
          return await replyCategoryUnavailable(from, 'DATA');
        }

        const dataSlots = resolveDataPurchaseSlots({ text, entities: detection.entities });
        logStructured('slot_fill_data', {
          from,
          accountId: account.id,
          ...dataSlots,
          missingMsisdn: !dataSlots.msisdn,
          missingDataMb: !dataSlots.dataMb,
          missingPeriodType: !dataSlots.periodType,
          missingNetworkCode: !dataSlots.networkCode,
        });

        // If user clearly asked to BUY data (has size), drive purchase; otherwise list bundles
        if (dataSlots.dataMb) {
          // If missing destination number, ask for it
          if (!dataSlots.msisdn) {
            logSlotFill({
              intent: 'BUY_DATA',
              text,
              slots,
              routeDecision: 'DATA_MSISDN',
              missing: ['msisdn'],
              from,
              accountId: account.id,
            });
            await updateConversationState(from, 'DATA_MSISDN', { ...dataSlots });
            return await sendWhatsAppText({
              to: from,
              text: `📶 *Buy Data*\n\nWhich phone number should I send the data to?\n\nReply with the number (e.g., 0781234567) or "me" for your own number.`,
            });
          }

          // Auto-infer network from MSISDN if missing
          if (!dataSlots.networkCode && dataSlots.msisdn) {
            dataSlots.networkCode = detectNetworkCodeFromMsisdn(dataSlots.msisdn);
          }

          // If still missing network, ask for it (single question)
          if (!dataSlots.networkCode) {
            logSlotFill({
              intent: 'BUY_DATA',
              text,
              slots,
              routeDecision: 'DATA_NETWORK',
              missing: ['networkCode'],
              from,
              accountId: account.id,
            });
            await updateConversationState(from, 'DATA_NETWORK', { ...dataSlots });
            return await sendWhatsAppText({
              to: from,
              text: `📶 *Buy Data*\n\nWhich network is this for?\n\nReply: Vodacom, MTN, Cell C, or Telkom.`,
            });
          }

          // Resolve productId from catalogue and confirm
          return await handleDataPurchaseFromSlots({ from, account, slots: dataSlots });
        }

        // Default: list bundles
        const mergedEntities = {
          ...(detection.entities || {}),
          ...(dataSlots.networkCode ? { networkCode: dataSlots.networkCode } : {}),
          ...(dataSlots.periodType ? { periodType: dataSlots.periodType } : {}),
        };
        return await handleListDataBundles({ from, account, entities: mergedEntities });

      // ====================================================================
      // SMART PRODUCT QUERY - Uses database to match categories
      // ====================================================================
      case 'SMART_PRODUCT_QUERY':
        return await handleSmartProductQuery({ from, account, text, slots, entities: detection.entities || {} });

      // ====================================================================
      // LIST INTENTS - Show real catalogue data, not generic responses
      // ====================================================================
      case 'LIST_DATA_BUNDLES':
        // Ensure period/network slots parsed from natural language are not dropped.
        return await handleListDataBundles({
          from,
          account,
          entities: {
            ...(detection.entities || {}),
            ...(slots?.networkCode ? { networkCode: slots.networkCode } : {}),
            ...(slots?.periodType ? { periodType: slots.periodType } : {}),
          },
        });
        
      case 'LIST_VAS_PRODUCTS':
        return await handleListVasProducts({ from, account });

      case 'AI_CHAT':
      default:
        // Route to AI for natural language understanding
        // AI can detect intents like "load money" → REDEEM_VOUCHER
        return await handleAIChat({ from, text, account });
    }
  } catch (error) {
    console.error('❌ Error processing message:', error);
    logStructured('message_processing_error', {
      from,
      text,
      intent,
      error: error.message,
    });
    return { ok: false, error: error.message };
  }
}

/**
 * Detect ONLY very clear, explicit intents
 */
function detectExplicitIntent(text = '') {
  const normalized = text.toLowerCase().trim();
  const squashed = normalized.replace(/\s+/g, ' ');
  const digitsOnly = text.replace(/[^\d]/g, '');

  // =====================================================================
  // CHECK BALANCE - Accept natural language variations
  // =====================================================================
  const balancePatterns = [
    /^(balance|check balance|my balance|show balance)$/i,
    /what('s| is) (my|the|your) (account )?balance/i,
    /how much (money|do i have|is in my (account|wallet))/i,
    /show (me )?(my )?balance/i,
    /check (my )?balance/i,
    /what'?s (my|the) balance/i,
    /balance check/i,
  ];

  for (const pattern of balancePatterns) {
    if (pattern.test(squashed)) {
      return { intent: 'CHECK_BALANCE', confidence: 0.95, triggerAction: true };
    }
  }

  // Help - explicit request
  if (/^(help|help me|menu|options)$/i.test(squashed)) {
    return { intent: 'HELP', confidence: 1.0 };
  }

  // Deposit / voucher keywords (catch template buttons like "Deposit Money")
  const wantsDeposit =
    /(redeem|use|get)\s+(my\s+)?(blu\s+)?voucher/.test(squashed) ||
    /(voucher\s*(code|pin|number))/.test(squashed) ||
    /(deposit|depsit|deposite|diposit|top\s*up|topup|add|load|put)\s+(money|funds|cash|to my wallet|to wallet|into wallet)/.test(squashed) ||
    squashed.includes('deposit money') ||
    squashed.includes('depsit money') ||
    squashed.includes('blu voucher');

  if (wantsDeposit) {
    return { intent: 'REDEEM_VOUCHER', confidence: 1.0 };
  }

  if (/^\d{16}$/.test(digitsOnly)) {
    return { intent: 'VOUCHER_PIN', confidence: 1.0, voucherPin: digitsOnly };
  }

  // =====================================================================
  // LIST VAS PRODUCTS - "What can I buy?", "Top 10 products", etc.
  // Must check BEFORE specific bundle/airtime patterns and SMART_PRODUCT_QUERY
  // =====================================================================
  const vasProductPatterns = [
    // "what can I buy" variations (with optional words before/after)
    /what\s+(can|do)\s+(i|you)\s+buy/i,
    /show\s+(me\s+)?what\s+(i\s+can|can\s+i)\s+buy/i,
    /what\s+can\s+i\s+(buy|get|purchase)/i,
    
    // "what products/services" variations
    /what\s+(vas\s+)?products?\s+(can|do|are)/i,
    /what\s+services?\s+(do\s+you|are|is|can\s+i)/i,
    
    // "show me products/services/catalogue"
    /show\s+(me\s+)?(your\s+)?(all\s+)?(the\s+)?(products?|services?|catalogue|catalog|options?)/i,
    
    // "list products" variations
    /list\s+(all\s+)?(your\s+|of )?(the\s+)?(products?|services?|options?)/i,
    
    // Direct questions
    /what\s+do\s+you\s+(sell|offer|have)/i,
    /what('s|s|\s+is)\s+available/i,
    /what\s+do\s+you\s+have/i,
    
    // "top products"
    /top\s*\d*\s*(vas\s+)?products?/i,
    
    // Other common variations
    /products?\s+(i\s+can|that\s+i\s+can|available|you\s+(have|sell|offer))/i,
    /all\s+(of\s+)?(the\s+)?(products?|services?|options?)/i,
    /your\s+(full\s+)?(product|service)\s*(list|catalogue|catalog|menu)/i,
    
    // "can I see" variations
    /can\s+(i|you)\s+(see|show|list)\s+(all\s+)?(the\s+)?(products?|services?|options?)/i,
  ];

  for (const pattern of vasProductPatterns) {
    if (pattern.test(squashed)) {
      return { intent: 'LIST_VAS_PRODUCTS', confidence: 0.95, triggerAction: true };
    }
  }

  // =====================================================================
  // SMART CATEGORY DETECTION
  // Instead of hardcoding every product, we detect product-related queries
  // and route them to the smart category matcher
  // =====================================================================
  
  // Check if this looks like a product query (buy/get/show/list + anything)
  const productQueryIndicators = [
    /\b(can\s+i|do\s+you|where\s+can\s+i|how\s+do\s+i)\s+(buy|get|purchase|pay|top\s*up)/i,
    /\b(buy|get|purchase|pay|top\s*up)\s+/i,
    /\b(show|list|what|which)\s+(me\s+)?(your\s+)?(the\s+)?/i,
  ];
  
  const looksLikeProductQuery = productQueryIndicators.some(p => p.test(squashed));
  
  if (looksLikeProductQuery) {
    // Route to smart category matcher (will query database)
    return { 
      intent: 'SMART_PRODUCT_QUERY', 
      confidence: 0.8,
      rawText: text,
      triggerAction: true,
    };
  }

  // =====================================================================
  // DATA BUNDLES - specific because of network/period extraction
  // =====================================================================
  const listBundlePatterns = [
    /\b(vodacom|mtn|cell\s?c|telkom)('s|s)?\s*(data\s+)?bundles?\b/i,
    /bundles?\b/i,
  ];

  for (const pattern of listBundlePatterns) {
    if (pattern.test(squashed)) {
      // Extract network
      let networkCode = null;
      if (/vodacom/i.test(squashed)) networkCode = 'VODACOM';
      else if (/mtn/i.test(squashed)) networkCode = 'MTN';
      else if (/cell\s?c/i.test(squashed)) networkCode = 'CELLC';
      else if (/telkom/i.test(squashed)) networkCode = 'TELKOM';
      
      // Extract period
      let periodType = null;
      if (/daily|day/i.test(squashed)) periodType = 'DAILY';
      else if (/weekly|week/i.test(squashed)) periodType = 'WEEKLY';
      else if (/monthly|month/i.test(squashed)) periodType = 'MONTHLY';
      
      return { 
        intent: 'LIST_DATA_BUNDLES', 
        confidence: 0.95, 
        entities: { networkCode, periodType },
        triggerAction: true,
      };
    }
  }

  // =====================================================================
  // Airtime intent detection (BUY, not list)
  // =====================================================================
  const airtimePatterns = [
    /buy\s*(?:r?\s*)?(\d+)\s*(?:rand\s*)?airtime/i,
    /(?:r?\s*)?(\d+)\s*(?:rand\s*)?airtime/i,
    /airtime\s*(?:for\s*)?(?:r?\s*)?(\d+)/i,
    /^(?:buy\s+)?airtime$/i,
    /i\s*(?:want|need)\s*(?:to\s+buy\s+)?(?:r?\s*)?(\d+)?\s*airtime/i,
    /can\s*(?:i|you)\s*(?:buy|get)\s*(?:r?\s*)?(\d+)?\s*airtime/i,
  ];

  for (const pattern of airtimePatterns) {
    const match = squashed.match(pattern);
    if (match) {
      const amount = match[1] ? parseInt(match[1], 10) : null;
      const extractedMsisdn = extractMsisdnFromText(text);
      return { 
        intent: 'BUY_AIRTIME', 
        confidence: 0.9, 
        entities: {
          ...(amount ? { amount } : {}),
          ...(extractedMsisdn ? { msisdn: extractedMsisdn } : {}),
        },
        triggerAction: true,
      };
    }
  }

  // Everything else goes to AI (including natural language)
  return { intent: 'AI_CHAT', confidence: 1.0 };
}

// ===========================================================================
// CARD / INSTANT EFT DEPOSITS (PayFast on-ramp)
// ===========================================================================

/**
 * "deposit R100" / "deposit 100" / "deposit money R100" — the phrasing the
 * deposit prompt teaches. Amount is the single capture group; an amount is
 * REQUIRED (bare "deposit money" still routes to the two-option prompt).
 * Kept on one line so tests can extract and exercise the shipped pattern.
 */
const DEPOSIT_CARD_PATTERN = /\b(?:deposit|depsit|deposite|diposit)\b(?:\s+(?:money|funds|cash))?\s*[:,-]?\s*r?\s*(\d+(?:[.,]\d{1,2})?)(?:\s*(?:rand|rande|zar))?\b/i;

/**
 * "Pay request PRXXXXXX" — the wa.me deep link from a payment-request page.
 * The capture class is the CODE ALPHABET (no I/L/O — lib/payment-requests),
 * which alone kills most English-word lookalikes ("pay request PROBLEMS").
 */
const PAY_REQUEST_CODE_PATTERN = /\bpay\s+request\s+(PR[A-HJKMNP-Z]{6})\b/i;

/**
 * A clearly-stated NEW intent while a flow is waiting for input. Family-
 * aware: an answer that belongs to the CURRENT flow ("R50" at the airtime
 * amount ask, a code in the request flow) never escapes; a different
 * product/intent always does. Deterministic regex only — never the AI.
 */
function detectStrongIntentSwitch(text, state) {
  const t = String(text || '');
  if (!t || /^\s*\d{4,6}\s*$/.test(t)) return null; // PIN-shaped: never an intent
  const family =
    state.startsWith('AIRTIME') ? 'AIRTIME'
    : state.startsWith('DATA') ? 'DATA'
    : state.startsWith('ELECTRICITY') ? 'ELECTRICITY'
    : state.startsWith('PAYREQ') || state.startsWith('REQUEST_MONEY') ? 'REQUEST_MONEY'
    : state.includes('DEPOSIT') ? 'DEPOSIT'
    : state.includes('VOUCHER') || state.includes('GIFT') ? 'VOUCHER'
    : 'OTHER';
  const candidates = [
    ['DEPOSIT', DEPOSIT_CARD_PATTERN.test(t)],
    ['REQUEST_MONEY', PAY_REQUEST_CODE_PATTERN.test(t) || matchRequestMoneyAsk(t, null)],
    ['RECEIPT', RECEIPT_CODE_PATTERN.test(t)],
    ['VOUCHER', matchOttVoucherSelfRequest(t, null)],
    ['AIRTIME', /\bairtime\b/i.test(t) && /\b(buy|send|want|need|get|koop|thenga)\b/i.test(t)],
    ['DATA', /\b(data|bundle)\b/i.test(t) && /\b(buy|send|want|need|get|koop|thenga)\b/i.test(t)],
    ['ELECTRICITY', /\b(electricity|elektrisiteit|umbane|mohlagase)\b/i.test(t) && /\b(buy|want|need|get|koop|thenga|R?\s?\d)/i.test(t)],
    ['BALANCE', /\b(balance|balans|imali|chelete)\b/i.test(t) && /\b(my|check|what|wat|yami|malini)\b/i.test(t)],
    ['HISTORY', /\b(my|show|list)\b[^\n]{0,20}\bvouchers?\b/i.test(t) && !/\d{6,}/.test(t)],
  ];
  for (const [fam, hit] of candidates) {
    if (!hit) continue;
    if (fam === family) continue;
    return fam;
  }
  return null;
}

/**
 * "Receipt PRXXXXXX" — the wa.me deep link a card payer taps on the pay
 * page, which sends EXACTLY this text as the whole message — so the
 * intercept is anchored to the full message AND restricted to the code
 * alphabet. Un-anchored /i matching hijacked ordinary sentences ("I have
 * receipt problems" captured PROBLEMS, "is my receipt prepared" captured
 * PREPARED — QA 2026-08-22).
 */
const RECEIPT_CODE_PATTERN = /^\s*receipt\s+(PR[A-HJKMNP-Z]{6})\s*[.!]?\s*$/i;

/**
 * "Change my amount to R1000" — swap the newest PENDING request for a new
 * one at the new amount (links are single-use, so edit = cancel + recreate,
 * done in ONE step; founder flow, 2026-08-22).
 */
function matchChangeRequestAmount(text = '', slots = null) {
  const s = String(text || '');
  if (slots?.productHint && slots.productHint !== 'SEND_MONEY') return false;
  if (!slots?.amountCents) return false;
  return /\b(change|update|edit|make)\b[\s\S]{0,30}\b(amount|request|it)\b/i.test(s);
}

async function handleChangeRequestAmount({ from, account, amountCents, rawText = '' }) {
  const latest = await getLatestPendingRequest({ accountId: account.id });
  if (latest) {
    await cancelPaymentRequest({ code: latest.id, accountId: account.id });
    await sendWhatsAppText({
      to: from,
      text: `🔁 Cancelled your ${randsShort(latest.amountCents)} request (${latest.id}) — that link no longer works. Here's the new one:`,
    });
  }
  return await handleCreatePaymentRequest({ from, account, amountCents, rawText });
}

/**
 * "Please pay me" — the user wants to GET PAID (create a payment request).
 * Deliberately excludes "pay request <code>" (that's PAYING one) and
 * paying-someone phrasings ("pay my sister").
 */
function matchRequestMoneyAsk(text = '', slots = null) {
  const s = String(text || '');
  if (PAY_REQUEST_CODE_PATTERN.test(s)) return false;
  if (/\bcancel\w*\b/i.test(s)) return false;
  // Informational QUESTIONS about the feature must be ANSWERED, not turned
  // into a create flow ("Where does the money go when they pay me?" — live
  // sighting 2026-08-21). Interrogatives only create when they carry a
  // create-verb or an amount ("can you create a payme link of R100").
  if (/^\s*(where|why|what|when|who|how)\b/i.test(s) && !/\b(create|make|generate|give|need|want|link)\b/i.test(s)) {
    return false;
  }
  // A named product wins: "request R100 airtime" / "pay me R50 airtime"
  // is a purchase/gift ask, never a payment request (found in QA 2026-08-21).
  if (slots?.productHint && slots.productHint !== 'SEND_MONEY') return false;
  return (
    /\b(please\s+)?pay\s?-?\s?me\b/i.test(s) ||
    /\bget\s+paid\b/i.test(s) ||
    /\bpayment\s+request\b/i.test(s) ||
    /\brequest\s+(money|payment|r\s?\d)/i.test(s)
  );
}

/**
 * Create a payment request and hand back a forwardable message + link.
 * The link page offers BOTH legs: pay from a WaPay balance (free, deep
 * links back into chat) or card/EFT via PayFast (payer covers the fee).
 */
async function handleCreatePaymentRequest({ from, account, amountCents, rawText = '' }) {
  if (!Number.isInteger(amountCents) || amountCents < MIN_REQUEST_CENTS || amountCents > MAX_REQUEST_CENTS) {
    await updateConversationState(from, 'REQUEST_MONEY_AMOUNT');
    const askMsg = await localizeOutbound(
      `🙏 *Get paid with WaPay*\n\nHow much would you like to request? (R5–R3000)\n\nFor example "R150" — or reply "cancel" to stop.`,
      await userLang(account)
    );
    await addToConversationHistory(from, 'assistant', askMsg);
    return await sendWhatsAppText({ to: from, text: askMsg });
  }

  let request;
  try {
    request = await createPaymentRequest({ accountId: account.id, amountCents });
  } catch (error) {
    logStructured('payrequest_create_error', { from, accountId: account.id, amountCents, error: error?.message });
    return await sendWhatsAppText({
      to: from,
      text: `❌ Sorry, I couldn't create your payment request. Please try again in a moment.`,
    });
  }

  await updateConversationState(from, null);
  const url = paymentRequestUrl(request.id);
  const who = account.displayName || maskMsisdn(account.msisdn) || 'A WaPay user';

  logStructured('payrequest_created', { from, accountId: account.id, code: request.id, amountCents });

  const cardFeeCents = depositFeeCents(amountCents);
  const introBody =
    `Forward the next message to whoever owes you — I'll tell you the moment it's paid.\n\n` +
    `You'll receive the full ${randsShort(amountCents)} if they pay from a WaPay balance, ` +
    `or ${randsShort(amountCents - cardFeeCents)} if they pay by card (${randsShort(cardFeeCents)} card fee — they pay no fees).`;
  await addToConversationHistory(from, 'assistant', introBody);

  // The requester's own copy shows a BUTTON, not a raw URL (founder ask
  // 2026-08-24). Interactive falls back to plain text — a request must
  // never fail on presentation.
  const interactive = await sendWhatsAppCtaUrl({
    to: from,
    headerText: 'Payment request created',
    bodyText: `🙏 *${randsShort(amountCents)} requested*\n\n${introBody}`,
    footerText: `Code ${request.id}`,
    buttonText: 'View my payment page',
    url,
  });
  if (!interactive?.ok) {
    await sendWhatsAppText({ to: from, text: `🙏 *Payment request created!*\n\n${introBody}` });
  }

  // WaPay-to-WaPay: "please pay me R50 from Philly / 083..." delivers the
  // request STRAIGHT into the payer's chat as an authorize flow (founder
  // ask 2026-08-25) — no web page needed between two WaPay users.
  const target = await resolveDirectedRequestTarget({ account, rawText });
  if (target?.waId) {
    const delivered = await deliverDirectedRequest({
      payerWaId: target.waId,
      request,
      requesterLabel: who,
    });
    // Neutral response either way (no membership-enumeration signal): the
    // requester always gets the shareable link too.
    const note = delivered
      ? `📨 I've let ${target.label} know on WaPay — they can pay you from their balance. ` +
        `I'll tell you the moment it's paid.\n\nHere's the link too, to share however you like:\n${url}`
      : `🙏 *Payment request created!*\n\n${introBody}`;
    await addToConversationHistory(from, 'assistant', note);
    await sendWhatsAppText({ to: from, text: note });
    return { ok: true };
  }

  // The FORWARDABLE message must keep the visible link: WhatsApp strips
  // interactive buttons when a message is forwarded, and the forwarded
  // message is the payer's ONLY road to the page. The short domain
  // (pleasepayme.co.za/PRXXXXXX) keeps it clean and tappable as plain text.
  const forwardable =
    `🙏 ${who} is requesting *${randsShort(amountCents)}* on WaPay.\n\n` +
    `Tap to pay — from a WaPay balance (free) or by card:\n${url}`;
  await addToConversationHistory(from, 'assistant', forwardable);
  return await sendWhatsAppText({ to: from, text: forwardable });
}

/**
 * "... from 083 555 1234" / "... from Philly" at the tail of a get-paid ask.
 * A name resolves through the requester's saved beneficiaries; exactly one
 * match counts. Returns { waId, label } when the target is an ONBOARDED
 * WaPay account, else null (the link flow covers everyone else).
 */
async function resolveDirectedRequestTarget({ account, rawText }) {
  const m = String(rawText || '').match(
    /\bfrom\s+(?:my\s+)?(\+?27\d{9}|0\d{9}|0[\d\s-]{8,12}\d|[A-Za-z][A-Za-z'’-]{1,20})\s*$/i
  );
  if (!m) return null;
  const raw = m[1].trim();

  // RELATIONSHIP GATE (abuse review 2026-08-25): a directed in-chat request
  // can ONLY reach someone the requester has ALREADY saved as a beneficiary
  // (sent to, or shared as a contact). Arbitrary numbers are never targeted
  // — that was a phishing + customer-enumeration vector. Everyone else falls
  // through to the shareable link, which requires the payer's own action.
  let msisdn = null;
  if (/\d{4}/.test(raw)) {
    const digits = normaliseMsisdn(raw);
    if (!isValidSaMsisdn(digits)) return null;
    if (!(await isSavedBeneficiary({ accountId: account.id, msisdn: digits }))) return null;
    msisdn = digits;
  } else {
    if (/^(me|my|phone|work|home|bank|card|wallet|app|whatsapp)$/i.test(raw)) return null;
    const matches = await findBeneficiariesByName({ accountId: account.id, query: raw }).catch(() => []);
    if (matches.length !== 1) return null;
    msisdn = normaliseMsisdn(matches[0].msisdn);
  }
  if (!msisdn) return null;

  const waId = `27${msisdn.slice(1)}`;
  try {
    const payer = await prisma.account.findFirst({ where: { msisdn: { in: [msisdn, waId] } } });
    if (!payer) return null;
    const state = await getOnboardingState(payer.id);
    if (state !== 'S5_COMPLETED') return null;
    // Label = how the REQUESTER saved them (their own beneficiary name) or a
    // masked number — never rendered from the payer's own profile.
    return { waId: payer.waId || waId, label: maskMsisdn(msisdn) };
  } catch {
    return null;
  }
}

/**
 * Strip anything that could let a spoofable display name impersonate a
 * system message: WhatsApp markdown, control chars, newlines; hard length
 * cap. The requester's WhatsApp profile name is UNTRUSTED (abuse review
 * 2026-08-25 — "Eskom"/"SARS" display names).
 */
function safeRequesterLabel(name) {
  const cleaned = String(name || '')
    .replace(/[*_~`>\n\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
  return cleaned || 'A WaPay user';
}

/**
 * Notify a saved-beneficiary payer that a request is waiting — INFORMATIONAL
 * ONLY. It never writes the payer's conversation state (abuse review
 * 2026-08-25: a cross-user state plant was a TOCTOU + stale-"yes"-pays-a-
 * stranger risk). The payer opts in by typing "pay request <code>", which
 * routes through the existing deterministic PAY_REQUEST intercept → confirm
 * → PIN. So the paying decision is always the payer's own explicit action.
 */
async function deliverDirectedRequest({ payerWaId, request, requesterLabel }) {
  try {
    const label = safeRequesterLabel(requesterLabel);
    const text =
      `🙏 *${label}* is asking you to pay *${randsShort(request.amountCents)}* on WaPay.\n\n` +
      `If you'd like to pay, reply:\n*pay request ${request.id}*\n\n` +
      `Paid from your WaPay balance — no fees. Ignore this message if it wasn't expected.`;
    await addToConversationHistory(payerWaId, 'assistant', text);
    const sent = await sendWhatsAppText({ to: payerWaId, text });
    return Boolean(sent?.ok);
  } catch {
    return false;
  }
}

/**
 * Start the in-chat leg of paying a request: look the code up, show the
 * confirm, then PIN — the send is a free spend->spend buildSend, posted
 * with the request code as idemKey so exactly ONE payer can ever pay it.
 */
async function handlePayRequestStart({ from, account, code, rawText = '' }) {
  const request = await getPaymentRequest({ code });
  if (!request) {
    return await sendWhatsAppText({
      to: from,
      text: `🤔 I can't find that payment request. Please check the link and try again.`,
    });
  }
  if (request.accountId === account.id) {
    return await sendWhatsAppText({
      to: from,
      text: `🙂 That's your own payment request — forward the link to the person who owes you.`,
    });
  }
  if (request.status !== 'PENDING') {
    const why = request.status === 'PAID' ? 'has already been paid' : 'is no longer active';
    return await sendWhatsAppText({ to: from, text: `⏳ That payment request ${why}.` });
  }

  let requesterLabel = 'a WaPay user';
  try {
    const requester = await prisma.account.findUnique({ where: { id: request.accountId } });
    requesterLabel = requester?.displayName || maskMsisdn(requester?.msisdn) || requesterLabel;
  } catch {
    // Cosmetic only.
  }

  await updateConversationState(from, 'PAYREQ_CONFIRM', { code: request.id, amountCents: request.amountCents, requesterLabel });
  const confirmMsg =
    `💸 *Pay ${randsShort(request.amountCents)} to ${requesterLabel}?*\n\n` +
    `Paid from your WaPay balance — no fees.\n\n` +
    `Reply *YES* to confirm or *NO* to cancel.`;
  await addToConversationHistory(from, 'assistant', confirmMsg);
  return await sendWhatsAppText({ to: from, text: confirmMsg });
}

/**
 * "Receipt PRXXXXXX" — a card payer asking for their payment receipt
 * (the wa.me deep link on the pay page; auto-registration hook, founder
 * ask 2026-08-22). Answers ANY sender with the same information the public
 * pay page already shows (the code IS the capability); the PayFast
 * reference is added only for the number that actually paid. Touches no
 * conversation state, so a mid-flow ask never traps or derails a flow.
 */
async function handlePaymentReceiptAsk({ from, code }) {
  const request = await getPaymentRequest({ code });
  if (!request) {
    return await sendWhatsAppText({
      to: from,
      text: `🤔 I can't find that payment reference. Please check the link on the payment page and try again.`,
    });
  }

  let requesterLabel = 'a WaPay user';
  try {
    const requester = await prisma.account.findUnique({ where: { id: request.accountId } });
    requesterLabel = maskedRequesterLabel(requester);
  } catch {
    // Cosmetic only — the receipt stands without it.
  }

  if (request.status === 'PENDING') {
    return await sendWhatsAppText({
      to: from,
      text: `⏳ That payment to ${requesterLabel} hasn't been confirmed yet. The moment PayFast confirms it, your receipt arrives right here.`,
    });
  }
  if (request.status !== 'PAID') {
    // CANCELLED/EXPIRED — but a card payment can land AFTER the requester
    // cancels (the credit posts; only the PENDING->PAID mark loses). Never
    // tell a charged payer "no payment was taken": check the intent.
    let intentSucceeded = false;
    try {
      const intent = await prisma.providerRequest.findUnique({ where: { idemKey: `wapay-payreq-${code}` } });
      intentSucceeded = intent?.status === 'SUCCESS' || Boolean(intent?.providerRef);
    } catch {
      // Fall through to the generic message.
    }
    if (intentSucceeded) {
      return await sendWhatsAppText({
        to: from,
        text: `🧾 That request was closed by the requester, but a card payment WAS received on it. If that payment was yours, the money reached ${requesterLabel} — please contact them (or reply "help") if anything looks wrong.`,
      });
    }
    return await sendWhatsAppText({
      to: from,
      text: `⏳ That payment request is no longer active — no payment was taken on it.`,
    });
  }

  const lines = [`🧾 *Payment receipt*`, `${randsShort(request.amountCents)} to ${requesterLabel} ✅`];
  if (request.paidAt) {
    lines.push(`Paid: ${new Date(request.paidAt).toISOString().slice(0, 10)}`);
  }
  // The PayFast reference is the payer's alone — everyone else gets the code.
  let refLine = `Ref: ${code}`;
  try {
    const intent = await prisma.providerRequest.findUnique({ where: { idemKey: `wapay-payreq-${code}` } });
    const payerMsisdn = intent?.metadata?.payerMsisdn;
    if (
      typeof payerMsisdn === 'string' &&
      payerMsisdn &&
      normaliseMsisdn(from) === payerMsisdn &&
      typeof request.payerRef === 'string' &&
      request.payerRef.startsWith('PAYFAST:')
    ) {
      refLine = `Ref: PF ${request.payerRef.slice('PAYFAST:'.length)} · ${code}`;
    }
  } catch {
    // Fall back to the code-only reference.
  }
  lines.push(refLine);

  return await sendWhatsAppText({ to: from, text: lines.join('\n') });
}

/**
 * "Buy an OTT voucher" (for MYSELF — no recipient number in the message).
 * Excludes redemption-ish phrasings ("redeem / load / I have an OTT
 * voucher"): those belong to the future OTT-deposit path, not a purchase.
 */
function matchOttVoucherSelfRequest(text = '', slots = null) {
  const s = String(text || '');
  if (slots?.msisdn) return false;
  // "send an OTT voucher to <someone>" is a gift, even without a number yet.
  if (/\bsend\b[\s\S]{0,40}\bto\b/i.test(s)) return false;
  if (!/\bott\s*vouchers?\b/i.test(s)) return false;
  if (/\b(redeem\w*|load\w*|deposit\w*|have|got|received?|claim\w*|my|show|list|history|bought)\b/i.test(s)) return false;
  return true;
}

/**
 * Rand-string -> integer cents with string math only (no float multiplication
 * on the money path). '100' -> 10000, '100.5' -> 10050, '100,50' -> 10050.
 *
 * @param {string} raw - digits with optional 1-2 decimals ('.' or ',')
 * @returns {number|null} integer cents, or null when non-positive/unsafe
 */
function depositAmountToCents(raw) {
  const [intPart, decPart = ''] = String(raw).replace(',', '.').split('.');
  const cents = Number(intPart) * 100 + Number((decPart + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  return cents;
}

/**
 * Detect an explicit card/EFT deposit request in free text.
 *
 * @param {string} text - raw WhatsApp message
 * @returns {number|null} requested amount in integer cents, or null
 */
function matchCardDepositRequest(text = '') {
  // "deposit 1234-5678-9012-3456" is a VOUCHER being redeemed, not a card
  // amount — a 16-digit PIN must never mint a R1,234 checkout.
  if (/\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}/.test(String(text || ''))) return null;
  const m = String(text || '').match(DEPOSIT_CARD_PATTERN);
  if (!m) return null;
  return depositAmountToCents(m[1]);
}

/**
 * The deposit prompt: BOTH ways money comes into the wallet. Option 1 (Blu
 * voucher) is the original path and stays first; option 2 is the PayFast
 * card/EFT link. Shown from every "deposit money"-style trigger.
 */
function buildDepositPrompt() {
  return (
    `💰 *Add Money to WaPay*\n\n` +
    `1️⃣ *Cash* — take your cash to the till at any major retailer and ask for a *Blu Voucher* for the amount you want to deposit. The cashier gives you a voucher code. Send that code to me here, and the money is automatically loaded into your WaPay wallet.\n` +
    `Example: 1234-5678-9012-3456\n\n` +
    `2️⃣ *Card / bank* — I'll send you a secure PayFast link. Pay with your card, Apple Pay, Google Pay, Samsung Pay, Capitec Pay, Instant EFT, SnapScan or Zapper. Reply with the amount, e.g. "deposit R100"`
  );
}

/**
 * Create a PayFast deposit link for the requested amount and send it.
 *
 * Deliberately NOT gated behind the wallet PIN: this flow only moves money
 * INTO the wallet — the customer authenticates with their card at PayFast,
 * and the wallet is only credited after the ITN webhook fully verifies the
 * payment (signature incl. empty fields, source IP, amount, status, server
 * confirmation). Withdrawals stay gated; deposits must be frictionless.
 *
 * m_payment_id is the deposit-intent row id — the ONLY key the ITN webhook
 * looks the payment up by — and the checkout amount comes from the same
 * intent, so verifyItn's amount check accepts the real ITN.
 *
 * @param {object} args
 * @param {string} args.from - payer's WhatsApp id
 * @param {object} args.account - the payer's account row
 * @param {number} args.amountCents - requested deposit, integer cents
 * @param {string} [args.rawText] - the message that triggered this, for logs
 */
async function handleCardDepositLink({ from, account, amountCents, rawText = '' }) {
  if (!Number.isInteger(amountCents) || amountCents < MIN_DEPOSIT_CENTS || amountCents > MAX_DEPOSIT_CENTS) {
    logSlotFill({
      intent: 'DEPOSIT_CARD',
      text: rawText,
      slots: { amountCents },
      routeDecision: 'DEPOSIT_CARD_AMOUNT_OUT_OF_RANGE',
      missing: ['amountCents'],
      from,
      accountId: account.id,
    });
    return await sendWhatsAppText({
      to: from,
      text: `💳 Card / Instant EFT deposits are between ${randsShort(MIN_DEPOSIT_CENTS)} and ${randsShort(MAX_DEPOSIT_CENTS)}.\n\nReply with an amount in that range, e.g. "deposit R100".`,
    });
  }

  let paymentId;
  let checkoutUrl;
  let feeCents;
  let grossCents;
  try {
    const intent = await createDepositIntent({ accountId: account.id, waId: from, amountCents });
    paymentId = intent.paymentId;
    feeCents = intent.feeCents;
    grossCents = intent.grossCents;

    const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
    checkoutUrl = buildCheckoutUrl({
      merchantId: process.env.PAYFAST_MERCHANT_ID,
      merchantKey: process.env.PAYFAST_MERCHANT_KEY,
      passphrase: process.env.PAYFAST_PASSPHRASE || undefined,
      sandbox: process.env.PAYFAST_SANDBOX === 'true',
      // The customer pays GROSS (credit + payment fee); the wallet is
      // credited amountCents. Quoted before they tap — fees never hide.
      amountCents: grossCents,
      mPaymentId: paymentId,
      itemName: 'WaPay top-up',
      // wa.me deep link reopens the WaPay chat — returning to the bare API
      // landing page strands the user outside WhatsApp (user-reported).
      returnUrl: 'https://wa.me/27760497624',
      cancelUrl: 'https://wa.me/27760497624',
      notifyUrl: `${base}/api/payfast/itn`,
    });
  } catch (error) {
    logStructured('deposit_link_error', {
      from,
      accountId: account.id,
      amountCents,
      paymentId: paymentId || null,
      error: error?.message,
    });
    return await sendWhatsAppText({
      to: from,
      text: `❌ Sorry, I couldn't create your payment link. Please try again in a moment.`,
    });
  }

  // The link IS the flow now — leave any pending conversation state behind.
  await updateConversationState(from, null);

  logStructured('deposit_link_sent', {
    from,
    accountId: account.id,
    paymentId,
    amountCents,
    rail: 'PAYFAST',
  });

  // Preamble + tappable button (interactive cta_url) instead of a raw URL.
  // The copy explains the round trip: PayFast for the payment, back to this
  // chat after. Falls back to a plain-text link if the interactive send is
  // rejected — a payment must never be blocked by presentation.
  const bodyText =
    `${randsShort(amountCents)} deposit + ${randsShort(feeCents)} payment fee = ` +
    `*${randsShort(grossCents)}*\n\n` +
    `I'll take you to *PayFast*, our secure payment partner, to pay by card ` +
    `or Instant EFT. When you've paid, tap *"Back to WaPay"* and you'll be ` +
    `brought straight back to this chat. I'll confirm here the moment your ` +
    `${randsShort(amountCents)} lands. 💰`;
  await addToConversationHistory(from, 'assistant', bodyText);

  const interactive = await sendWhatsAppCtaUrl({
    to: from,
    headerText: 'Add money to WaPay',
    bodyText,
    footerText: 'Secured by PayFast',
    buttonText: `Pay ${randsShort(grossCents)} now`,
    url: checkoutUrl,
  });
  if (interactive?.ok) return interactive;

  logStructured('deposit_cta_fallback', {
    from,
    accountId: account.id,
    paymentId,
    error: interactive?.error || null,
  });
  return await sendWhatsAppText({
    to: from,
    text:
      `💳 ${randsShort(amountCents)} deposit + ${randsShort(feeCents)} payment fee = ${randsShort(grossCents)}.\n\n` +
      `Tap to pay securely with PayFast: ${checkoutUrl}\n\n` +
      `Your balance updates here the moment payment clears.`,
  });
}

/**
 * Answer "did my payment go through" from the intent table + wallet — the
 * factual, deterministic reply the founder asked for after the AI improvised
 * "your balance will update shortly" (a promise no code path could honour).
 *
 * SUCCESS -> amount + current balance. PENDING -> "PayFast is still
 * confirming" (the ITN confirmation message IS the promised follow-up).
 * FAILED -> say so plainly and invite a retry. No intent -> explain how to
 * deposit. Every answer carries the live balance so the user never sees a
 * stale number without context.
 */
async function handleDepositStatus({ from, account }) {
  let intent;
  try {
    intent = await getLatestDepositIntent({ accountId: account.id });
  } catch (error) {
    logStructured('deposit_status_lookup_error', {
      from,
      accountId: account.id,
      error: error?.message,
    });
    return await sendWhatsAppText({
      to: from,
      text: `⚠️ I can't check your payment status right now — please try again in a moment.`,
    });
  }

  const { balance } = await getUserBalance(from);

  if (!intent) {
    return await sendWhatsAppText({
      to: from,
      text:
        `You haven't made a card deposit yet.\n\n` +
        `💰 Balance: R${balance}\n\n` +
        `To add money, reply e.g. "deposit R100".`,
    });
  }

  const amountCents = intent.metadata?.amountCents;
  const amount = Number.isInteger(amountCents) ? randsShort(amountCents) : 'your deposit';

  let text;
  if (intent.status === 'SUCCESS') {
    text =
      `✅ Your ${amount} deposit was received.\n\n` +
      `💰 Balance: R${balance}`;
  } else if (intent.status === 'FAILED') {
    text =
      `❌ Your ${amount} card payment didn't complete — nothing was credited.\n\n` +
      `💰 Balance: R${balance}\n\n` +
      `Want to try again? Reply "deposit ${Number.isInteger(amountCents) ? randsShort(amountCents) : 'R100'}".`;
  } else {
    // PENDING (or any non-terminal state): the ITN confirmation message is
    // the promised follow-up — it fires the moment PayFast notifies us. A
    // payment declined ON PayFast's page never sends an ITN, so the retry
    // line matters (observed live: FNB decline, 2026-08-19).
    text =
      `⏳ PayFast is still confirming your ${amount} — I'll message you here the moment it clears.\n\n` +
      `If the payment didn't go through on PayFast's page (or your bank declined it), nothing left your account — just reply "deposit ${Number.isInteger(amountCents) ? randsShort(amountCents) : 'R100'}" to try again.\n\n` +
      `💰 Balance: R${balance}`;
  }

  await addToConversationHistory(from, 'assistant', text);
  return await sendWhatsAppText({ to: from, text });
}

/**
 * Voucher history — every voucher this account bought (self or sent), from
 * pending_gifts: date, value, serial, delivery status. PINs never appear
 * here; retrieval is wallet-PIN-gated via startVoucherPinResend.
 */
async function handleVoucherHistory({ from, account }) {
  let gifts = [];
  try {
    gifts = await prisma.pendingGift.findMany({
      where: { senderAccountId: account.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
  } catch (error) {
    logStructured('voucher_history_error', { from, accountId: account.id, error: error?.message });
  }

  if (!gifts.length) {
    return await sendWhatsAppText({
      to: from,
      text: `🎟️ You haven't bought any vouchers yet.\n\nTry "buy an OTT voucher R50" — paid from your balance, PIN delivered right here.`,
    });
  }

  const own = normaliseMsisdn(account.msisdn || '');
  const lines = gifts.map((g) => {
    const when = g.createdAt.toISOString().slice(0, 10);
    const who = normaliseMsisdn(g.recipientMsisdn) === own ? 'for you' : `to ${maskMsisdn(g.recipientMsisdn)}`;
    const status =
      g.status === 'DELIVERED' ? '✅ PIN delivered' : g.status === 'CANCELLED' ? '❌ cancelled' : '⏳ awaiting claim';
    return `• ${when} — ${randsShort(g.amountCents)} ${who}\n   SN ${g.voucherSerial || '—'} · ${status}`;
  });

  const msg =
    `🎟️ *Your vouchers* (latest ${gifts.length})\n\n` +
    lines.join('\n') +
    `\n\nTo get a voucher PIN again, reply:\n*voucher pin <last 6 digits of its SN>*`;
  await addToConversationHistory(from, 'assistant', msg);
  return await sendWhatsAppText({ to: from, text: msg });
}

/**
 * PIN resend, step 1: find the voucher by serial tail, then demand the
 * WALLET PIN before the bearer voucher PIN is re-shown (it IS money).
 */
async function startVoucherPinResend({ from, account, serialTail }) {
  let gift = null;
  try {
    const candidates = await prisma.pendingGift.findMany({
      where: { senderAccountId: account.id, voucherSerial: { endsWith: serialTail } },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    gift = candidates[0] || null;
  } catch (error) {
    logStructured('voucher_resend_lookup_error', { from, accountId: account.id, error: error?.message });
  }

  if (!gift) {
    return await sendWhatsAppText({
      to: from,
      text: `🤔 I couldn't find a voucher of yours ending in "${serialTail}". Reply "my vouchers" to see the list.`,
    });
  }

  await updateConversationState(from, 'VOUCHER_PIN_RESEND_AUTH', { giftId: gift.id });
  return await sendWhatsAppText({
    to: from,
    text: `🔐 To re-send the PIN for your ${randsShort(gift.amountCents)} voucher (SN ${gift.voucherSerial}), please enter your WaPay PIN.`,
  });
}

/**
 * Handle conversation state (multi-turn conversations)
 */
async function handleConversationState({ from, text, state, data, account }) {
  console.log('💬 Handling conversation state:', { state, text, data });

  switch (state) {
    case 'REQUEST_MONEY_AMOUNT': {
      const trimmed = text.trim().toLowerCase();
      if (/^(cancel|stop|no|home|menu|back|exit)$/i.test(trimmed)) {
        await updateConversationState(from, null);
        return await renderHome({ from, account });
      }
      const filled = parseSlots(text, { waId: from, accountId: account.id });
      if (!filled.amountCents) {
        if (isConversationalEscape(text)) {
          await updateConversationState(from, null);
          return await handlePostOnboarding({ account, from, text });
        }
        return await sendWhatsAppText({
          to: from,
          text: `Please reply with the amount you'd like to request, e.g. "R150" — or "cancel" to stop.`,
        });
      }
      return await handleCreatePaymentRequest({ from, account, amountCents: filled.amountCents, rawText: text });
    }

    case 'PAYREQ_CONFIRM': {
      const normalized = text.trim().toLowerCase();
      if (/^(yes|yep|yeah|y|sure|ok|okay|confirm|yebo|ewe|ja|ee|eya)$/i.test(normalized)) {
        await updateConversationState(from, 'PAYREQ_PIN', data);
        const pinMsg = `🔐 *Enter Your PIN*\n\nTo pay ${randsShort(data.amountCents)} to ${data.requesterLabel}, please enter your WaPay PIN.`;
        await addToConversationHistory(from, 'assistant', pinMsg);
        return await sendWhatsAppText({ to: from, text: pinMsg });
      }
      if (/^(no|nope|n|cancel|stop)$/i.test(normalized)) {
        await updateConversationState(from, null);
        return await sendWhatsAppText({ to: from, text: `👍 Cancelled — nothing was paid.` });
      }
      if (isConversationalEscape(text)) {
        await updateConversationState(from, null);
        return await handlePostOnboarding({ account, from, text });
      }
      return await sendWhatsAppText({ to: from, text: `Please reply *YES* to pay or *NO* to cancel.` });
    }

    case 'PAYREQ_PIN': {
      const normalized = text.trim().toLowerCase();
      if (/^(cancel|stop|no|exit|back)$/i.test(normalized)) {
        await updateConversationState(from, null);
        return await sendWhatsAppText({ to: from, text: `👍 Cancelled — nothing was paid.` });
      }

      // Only something PIN-shaped reaches verifyPIN — a question or
      // sentence must never burn attempts toward the wallet-PIN lockout
      // (QA 2026-08-21: five chatty replies soft-locked the PIN).
      if (!/^\d{4,6}$/.test(text.trim())) {
        if (isConversationalEscape(text)) {
          await updateConversationState(from, null);
          return await handlePostOnboarding({ account, from, text });
        }
        return await sendWhatsAppText({
          to: from,
          text: `Please enter your 4-digit WaPay PIN — or reply "cancel" to stop.`,
        });
      }

      const pinResult = await verifyPIN({ accountId: account.id, pin: text.trim() });
      if (!pinResult.ok) {
        if (pinResult.error === 'HARD_LOCKOUT' || pinResult.error === 'SOFT_LOCKOUT') {
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `🔒 Too many incorrect PIN attempts. Please try again later.`,
          });
        }
        return await sendWhatsAppText({
          to: from,
          text: `❌ Incorrect PIN. Please try again, or reply "cancel" to stop.`,
        });
      }

      await updateConversationState(from, null);
      const request = await getPaymentRequest({ code: data.code });
      if (!request || request.status !== 'PENDING') {
        return await sendWhatsAppText({
          to: from,
          text: `⏳ That payment request is no longer open — nothing was paid.`,
        });
      }

      // The request code IS the idempotency key: exactly one payer's debit
      // can ever post; a racing payer replays the winner's entry harmlessly.
      let posted;
      try {
        await ensureWallet({ accountId: account.id });
        await ensureWallet({ accountId: request.accountId });
        posted = await postEntry(
          buildSend({
            fromAccountId: account.id,
            toAccountId: request.accountId,
            amountCents: request.amountCents,
            idemKey: `wapay-payreq-${request.id}`,
          })
        );
      } catch (error) {
        if (error?.code === 'INSUFFICIENT_FUNDS') {
          const { balance } = await getUserBalance(from);
          const balanceCents = Math.round(parseFloat(balance) * 100) || 0;
          const shortfallCents = Math.max(request.amountCents - balanceCents, MIN_DEPOSIT_CENTS);
          return await sendWhatsAppText({
            to: from,
            text:
              `💰 You need ${randsShort(request.amountCents)} but your balance is R${balance}.\n\n` +
              `Top up and try again:\n` +
              `1️⃣ *Cash* — buy a Blu Voucher at any till and send me the code\n` +
              `2️⃣ *Card / bank* — reply "deposit ${randsShort(shortfallCents)}" for a secure PayFast link`,
          });
        }
        logStructured('payrequest_pay_error', { from, accountId: account.id, code: data.code, error: error?.message });
        return await sendWhatsAppText({
          to: from,
          text: `❌ Sorry, the payment couldn't be completed. Nothing was charged — please try again.`,
        });
      }

      if (posted.replayed) {
        // Another rail/payer won with the SAME idemKey — this payer's debit
        // never posted. Repair the status if a crash left it PENDING.
        markRequestPaid({ code: request.id, payerRef: 'REPAIR:replayed' }).catch(() => {});
        return await sendWhatsAppText({
          to: from,
          text: `⏳ That request was already paid — nothing was charged to you.`,
        });
      }

      const wonTransition = await markRequestPaid({ code: request.id, payerRef: `WAPAY:${account.id}` });
      if (!wonTransition) {
        // Should be impossible with the unified idemKey (a fresh post means
        // we won the money race) — if it ever happens, make it loud.
        logStructured('payrequest_mark_paid_lost_after_post', {
          from,
          accountId: account.id,
          code: request.id,
        });
      }

      logStructured('payrequest_paid_balance', {
        from,
        accountId: account.id,
        code: request.id,
        amountCents: request.amountCents,
      });

      const { balance } = await getUserBalance(from);
      const receipt =
        `✅ *Paid!*\n\n` +
        `💸 ${randsShort(request.amountCents)} to ${data.requesterLabel}\n` +
        `📅 ${formatDateTimeZa(new Date())}\n\n` +
        `💳 New balance: R${balance}`;
      await addToConversationHistory(from, 'assistant', receipt);
      await sendWhatsAppText({ to: from, text: receipt });

      // Tell the requester their money arrived (best effort, never blocks).
      try {
        const requester = await prisma.account.findUnique({ where: { id: request.accountId } });
        if (requester?.waId) {
          const payerLabel = account.displayName || maskMsisdn(account.msisdn) || 'Someone';
          const rw = await prisma.wallet.findFirst({
            where: { accountId: request.accountId, balanceType: 'SPEND' },
          });
          await sendWhatsAppText({
            to: requester.waId,
            text:
              `💸 *Your payment request was PAID!*\n\n` +
              `${payerLabel} paid your ${randsShort(request.amountCents)} request.` +
              (rw ? `\n\n💳 New balance: R${(rw.availableCents / 100).toFixed(2)}` : ''),
          });
        }
      } catch (notifyError) {
        logStructured('payrequest_notify_error', { code: request.id, error: notifyError?.message });
      }

      return await sendPostTransactionCta(from);
    }

    case 'DEPOSIT_CARD_AMOUNT': {
      const trimmed = text.trim().toLowerCase();
      if (/^(cancel|stop|no|home|menu|back|exit)$/i.test(trimmed)) {
        await updateConversationState(from, null);
        return await renderHome({ from, account });
      }
      // Accept "20", "R20", "20 rand", "20.50" or a full "deposit R20".
      const bare = trimmed.match(/^r?\s*(\d+(?:[.,]\d{1,2})?)(?:\s*(?:rand|rande|zar))?$/i);
      const bareAmountCents = bare
        ? depositAmountToCents(bare[1])
        : matchCardDepositRequest(text);
      if (bareAmountCents == null) {
        // A sentence/question is not an amount — escape to the full router.
        if (isConversationalEscape(text)) {
          await updateConversationState(from, null);
          return await handlePostOnboarding({ account, from, text });
        }
        return await sendWhatsAppText({
          to: from,
          text: `Please reply with just the amount you'd like to deposit, e.g. "R100" — or "cancel" to stop.`,
        });
      }
      await updateConversationState(from, null);
      return await handleCardDepositLink({ from, account, amountCents: bareAmountCents, rawText: text });
    }

    case 'AWAITING_VOUCHER_PIN':
      // User entered voucher PIN - single-step flow
      {
        const normalized = text.trim().toLowerCase();

        // "home"/"menu" must always be an exit — being trapped in a state
        // that answers everything with "Invalid Voucher PIN" reads as a
        // broken bot (observed in user testing 2026-08-21).
        if (/^(cancel|stop|no|not now|later|reset|restart|home|menu|back|exit)$/i.test(normalized)) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `👍 No problem. When you're ready to add money again, just type "redeem voucher" — or "deposit R100" to pay by card.`,
          });
        }

        // Option 2 of the deposit prompt: "deposit R100" -> PayFast card/EFT
        // link. Checked BEFORE PIN handling so choosing card never trips the
        // invalid-PIN reply. Creating the link needs no wallet PIN.
        {
          const cardDepositCents = matchCardDepositRequest(text);
          if (cardDepositCents) {
            logSlotFill({
              intent: 'DEPOSIT_CARD',
              text,
              slots: { amountCents: cardDepositCents },
              routeDecision: 'DEPOSIT_CARD_LINK',
              missing: [],
              from,
              accountId: account.id,
            });
            return await handleCardDepositLink({ from, account, amountCents: cardDepositCents, rawText: text });
          }
        }

        if (normalized === '1') {
          await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
          return await sendWhatsAppText({
            to: from,
            text: `Great! Please enter your 16-digit Blu Voucher PIN (numbers only).\nExample: 1234567890123456\n\nReply "cancel" to stop.`,
          });
        }

        if (normalized === '2') {
          // Card path collects a bare amount next — parking the user in the
          // voucher-PIN state here made "20" answer "Invalid Voucher PIN"
          // (observed in user testing 2026-08-21).
          await updateConversationState(from, 'DEPOSIT_CARD_AMOUNT');
          return await sendWhatsAppText({
            to: from,
            text: `💳 *Card / Instant EFT*\n\nHow much would you like to deposit? Just reply with the amount.\n\nExample: R100`,
          });
        }

        if (/^(yes|yep|yeah|y|sure|ok|okay|alright|please|confirm|yebo|ewe|ja|ee|eya)$/i.test(normalized)) {
          await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
          return await sendWhatsAppText({
            to: from,
            text: `Great! Please enter your 16-digit Blu Voucher PIN (numbers only).\nExample: 1234567890123456\n\nReply "cancel" to stop.`,
          });
        }

        // A real question/sentence is NOT a PIN attempt — escape the state
        // and let the full router (incl. the orchestrator) answer it.
        // "I want to use my bank account" must get the card option, not
        // "Invalid Voucher PIN" on loop (observed live, 2026-08-20).
        if (isConversationalEscape(text)) {
          await updateConversationState(from, null);
          return await handlePostOnboarding({ account, from, text });
        }

        // Otherwise treat message as PIN entry
        // Validate and normalize PIN
        const normalizedPin = text.replace(/[\s-]/g, '');

        if (!/^\d{16}$/.test(normalizedPin)) {
          await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
          return await sendWhatsAppText({
            to: from,
            text: `❌ *Invalid Voucher PIN*\n\nPlease enter a valid 16-digit Blu Voucher PIN (numbers only).\nExample: 1234567890123456\n\nYou can reply with the PIN now, or type "cancel" to stop.`,
          });
        }
        
        // PIN is valid - redeem immediately (single-step flow)
        return await handleVoucherRedemption({ from, pin: normalizedPin, account });
      }

    case 'AIRTIME_AMOUNT':
      // User is entering airtime amount
      {
        const normalized = text.trim().toLowerCase();
        
        // Cancel keywords - be more permissive
        if (/^(cancel|stop|no|not now|later|reset|restart|start over|quit|exit|back)$/i.test(normalized)) {
          await updateConversationState(from, null);
          await sendWhatsAppText({ to: from, text: `👍 Airtime purchase cancelled.` });
          return await renderHome({ from, account });
        }
        
        // Parse amount
        const amountMatch = text.match(/(\d+)/);
        if (!amountMatch) {
          return await sendWhatsAppText({
            to: from,
            text: `Please enter a valid amount (e.g., R10, R50, R100)\n\nReply "cancel" to stop.`,
          });
        }
        
        const amountCents = parseInt(amountMatch[1], 10) * 100;
        
        // Validate amount
        if (amountCents < 500 || amountCents > 100000) {
          return await sendWhatsAppText({
            to: from,
            text: `Amount must be between R5 and R1000.\n\nPlease enter a valid amount.`,
          });
        }
        
        // A recipient carried in from the orchestrator ("airtime for 083…"
        // with no amount) skips the number ask — straight to preview.
        if (data?.msisdn) {
          return await startAirtimePreviewAndConfirm({
            from,
            account,
            amountCents,
            msisdn: data.msisdn,
            intent: 'STATE_AIRTIME_AMOUNT',
            rawText: text,
          });
        }

        // Move to phone number collection
        await updateConversationState(from, 'AIRTIME_MSISDN', { amountCents });
        return await sendWhatsAppText({
          to: from,
          text: await localizeOutbound(`📱 *R${amountCents / 100} Airtime*\n\nWhich phone number should I send the airtime to?\n\nReply with the number (e.g., 0781234567) or "me" for your own number.`, await userLang(account)),
        });
      }

    case 'AIRTIME_MSISDN':
      // User is entering phone number for airtime
      {
        const normalized = text.trim().toLowerCase();
        
        // Cancel keywords - be more permissive
        if (/^(cancel|stop|no|not now|later|reset|restart|start over|quit|exit|back)$/i.test(normalized)) {
          await updateConversationState(from, null);
          await sendWhatsAppText({ to: from, text: `👍 Airtime purchase cancelled.` });
          return await renderHome({ from, account });
        }

        // Slot-fill inside state: if user provides MSISDN (and maybe amount) in one message, skip.
        const filledSlots = parseSlots(text, { waId: from, accountId: account.id });
        // The chosen amount survives: when the reply IS the phone number,
        // its digits must never be re-parsed as a rand amount (QA
        // 2026-08-21: '0781234567' overrode a R20 choice as R7,815,234.56).
        const amountCents =
          filledSlots.msisdn && String(filledSlots.amountCents || '').replace(/\D/g, '') ===
            String(filledSlots.msisdn || '').replace(/\D/g, '').slice(0, String(filledSlots.amountCents || '').length)
            ? data?.amountCents
            : filledSlots.amountCents || data?.amountCents;
        if (amountCents && filledSlots.msisdn) {
          logSlotFill({
            intent: 'STATE_AIRTIME_MSISDN',
            text,
            slots: { ...filledSlots, amountCents, productHint: 'AIRTIME' },
            routeDecision: 'AIRTIME_PREVIEW_CONFIRM',
            missing: [],
            from,
            accountId: account.id,
          });
          return await startAirtimePreviewAndConfirm({
            from,
            account,
            amountCents,
            msisdn: filledSlots.msisdn,
            intent: 'STATE_AIRTIME_MSISDN',
            rawText: text,
          });
        }
        
        // "me" buys for your own number — the prompt offers exactly that.
        if (/^me\.?$/i.test(text.trim()) && account.msisdn) {
          const ownAmount = data?.amountCents;
          if (ownAmount) {
            return await startAirtimePreviewAndConfirm({
              from,
              account,
              amountCents: ownAmount,
              msisdn: account.msisdn,
              intent: 'STATE_AIRTIME_MSISDN_SELF',
              rawText: text,
            });
          }
        }

        // If message doesn't look like a phone number at all, assume user wants to cancel
        const digitsOnly = text.replace(/[^\d]/g, '');
        if (digitsOnly.length < 8) {
          // Not enough digits to be a phone number - user probably wants to do something else
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `I've cancelled the airtime purchase. What else can I help you with?`,
          });
        }
        
        const isMe = /^(me|my\s*number|my\s*phone|myself)$/i.test(normalized);
        const rawMsisdnInput = isMe ? account.msisdn : (filledSlots.msisdn || text.trim());
        const normalisedMsisdn = normaliseMsisdn(rawMsisdnInput || '');
        
        // Validate phone number format (allow Blu QA numbers)
        if (!isValidSaMsisdn(normalisedMsisdn)) {
          logStructured('msisdn_validation_failed', {
            type: 'msisdn_validation_failed',
            from,
            waUserId: from,
            accountId: account.id,
            rawInput: rawMsisdnInput,
            normalisedMsisdn,
            reason: 'format_validation_failed',
          });
          
          return await sendWhatsAppText({
            to: from,
            text: `❌ Invalid phone number format.\n\nPlease enter a valid SA mobile number (e.g., 0781234567)\n\nOr reply "cancel" to stop.`,
          });
        }
        
        const amountCents2 = data?.amountCents || 1000;
        
        const vendorLabel = detectVendorLabel(normalisedMsisdn);
        
        // Log VAS preview call
        logStructured('vas_airtime_preview_initiated', {
          from,
          accountId: account.id,
          msisdn: normalisedMsisdn,
          amountCents: amountCents2,
          vendorLabel,
        });
        
        // Move to confirmation state
        logSlotFill({
          intent: 'STATE_AIRTIME_MSISDN',
          text,
          slots: { ...filledSlots, amountCents: amountCents2, msisdn: normalisedMsisdn, productHint: 'AIRTIME' },
          routeDecision: 'AIRTIME_CONFIRM',
          missing: [],
          from,
          accountId: account.id,
        });
        await updateConversationState(from, 'AIRTIME_CONFIRM', { amountCents: amountCents2, msisdn: normalisedMsisdn, vendorLabel });
        
        return await sendWhatsAppText({
          to: from,
          text: `📱 *Confirm Airtime Purchase*\n\n` +
                `Amount: R${amountCents2 / 100}\n` +
                `Number: ${normalisedMsisdn} (${vendorLabel})\n\n` +
                `Reply *YES* to confirm or *NO* to cancel.`,
        });
      }

    case 'AIRTIME_CONFIRM':
      // User is confirming airtime purchase
      {
        const normalized = text.trim().toLowerCase();
        
        // Cancel keywords - be more permissive
        if (/^(no|cancel|stop|not now|later|reset|restart|start over)$/i.test(normalized)) {
          await updateConversationState(from, null);
          await sendWhatsAppText({ to: from, text: `👍 Airtime purchase cancelled.` });
          return await renderHome({ from, account });
        }
        
        // If user says something that's not yes/no, clear state and let them try again
        if (!/^(yes|yep|yeah|y|sure|ok|okay|alright|confirm|yebo|ewe|ja|ee|eya)$/i.test(normalized)) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `I've cancelled that request. Feel free to ask me anything else!`,
          });
        }
        
        if (/^(yes|yep|yeah|y|sure|ok|okay|alright|confirm|yebo|ewe|ja|ee|eya)$/i.test(normalized)) {
          const { amountCents, msisdn, vendorLabel: stateVendorLabel, previewId: existingPreviewId } = data || {};
          const vendorLabel = stateVendorLabel || detectVendorLabel(msisdn || '');
          
          if (!amountCents || !msisdn) {
            await updateConversationState(from, null);
            return await sendWhatsAppText({
              to: from,
              text: `❌ Something went wrong. Please start again by saying "buy airtime".`,
            });
          }
          
          // Log execute initiated
          logStructured('vas_airtime_execute_initiated', {
            from,
            accountId: account.id,
            msisdn,
            amountCents,
          });
          
          // If we already have a previewId from the confirmation step, do NOT preview again.
          const previewId = existingPreviewId;
          if (!previewId) {
            // Backwards compatibility: if preview wasn't created yet, create it now.
          await updateConversationState(from, null);
            return await startAirtimePreviewAndConfirm({ from, account, amountCents, msisdn });
          }

          await updateConversationState(from, 'AIRTIME_PIN', { 
            previewId,
                amountCents,
            msisdn,
            vendorName: vendorLabel,
            vendorLabel,
            });
            
          logStructured('vas_airtime_pin_requested', {
                from,
                accountId: account.id,
            previewId,
            msisdn,
            amountCents,
              });
              
              return await sendWhatsAppText({
                to: from,
            text: `🔐 *Enter Your PIN*\n\nTo complete your R${(amountCents / 100).toFixed(0)} airtime purchase to ${msisdn} (${vendorLabel}), please enter your WaPay PIN.`,
          });
        }
        
        // Unrecognized response
        return await sendWhatsAppText({
          to: from,
          text: `Please reply *YES* to confirm or *NO* to cancel.`,
        });
      }

    // =================================================================
    // DATA PURCHASE FLOW (slot-filled)
    // =================================================================
    case 'DATA_MSISDN':
      {
        const normalized = text.trim().toLowerCase();
        if (/^(cancel|stop|no|reset|restart|back)$/i.test(normalized)) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({ to: from, text: `👍 Data purchase cancelled.` });
        }

        const rawMsisdnInput = /^(me|my\s*number|my\s*phone|myself)$/i.test(normalized)
          ? account.msisdn
          : text.trim();
        const normalisedMsisdn = normaliseMsisdn(rawMsisdnInput || '');
        if (!isValidSaMsisdn(normalisedMsisdn)) {
            return await sendWhatsAppText({
              to: from,
            text: `❌ Invalid phone number format.\n\nPlease enter a valid SA mobile number (e.g., 0781234567)\n\nOr reply "cancel" to stop.`,
          });
        }

        const merged = { ...(data || {}), msisdn: normalisedMsisdn };
        const slots = resolveDataPurchaseSlots({ text: '', entities: merged, stateData: merged });
        if (!slots.networkCode) {
          await updateConversationState(from, 'DATA_NETWORK', merged);
          return await sendWhatsAppText({ to: from, text: `📶 *Buy Data*\n\nWhich network is this for?\n\nReply: Vodacom, MTN, Cell C, or Telkom.` });
        }
        if (!slots.periodType) {
          await updateConversationState(from, 'DATA_PERIOD', merged);
          return await sendWhatsAppText({ to: from, text: `📶 *Buy Data*\n\nWhich bundle period?\n\nReply: daily, weekly, monthly, or night.` });
        }
        await updateConversationState(from, null);
        return await handleDataPurchaseFromSlots({ from, account, slots });
      }

    case 'DATA_NETWORK':
      {
        const normalized = text.trim().toLowerCase();
        if (/^(cancel|stop|no|reset|restart|back)$/i.test(normalized)) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({ to: from, text: `👍 Data purchase cancelled.` });
        }
        const networkCode = extractNetworkCode(text);
        if (!networkCode) {
          return await sendWhatsAppText({ to: from, text: `❌ Please reply with a network: Vodacom, MTN, Cell C, or Telkom.` });
        }
        const merged = { ...(data || {}), networkCode };
        const slots = resolveDataPurchaseSlots({ text: '', entities: merged, stateData: merged });
        if (!slots.periodType) {
          await updateConversationState(from, 'DATA_PERIOD', merged);
          return await sendWhatsAppText({ to: from, text: `📶 *Buy Data*\n\nWhich bundle period?\n\nReply: daily, weekly, monthly, or night.` });
        }
        await updateConversationState(from, null);
        return await handleDataPurchaseFromSlots({ from, account, slots });
      }

    case 'DATA_PERIOD':
      {
        const normalized = text.trim().toLowerCase();
        if (/^(cancel|stop|no|reset|restart|back)$/i.test(normalized)) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({ to: from, text: `👍 Data purchase cancelled.` });
        }
        const periodType = extractPeriodType(text);
        if (!periodType) {
          return await sendWhatsAppText({ to: from, text: `❌ Please reply with: daily, weekly, monthly, or night.` });
        }
        const merged = { ...(data || {}), periodType };
        const slots = resolveDataPurchaseSlots({ text: '', entities: merged, stateData: merged });
        await updateConversationState(from, null);
        return await handleDataPurchaseFromSlots({ from, account, slots });
      }

    case 'DATA_CONFIRM':
      {
        const normalized = text.trim().toLowerCase();
        if (/^(no|cancel|stop|not now|later|reset|restart|start over)$/i.test(normalized)) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({ to: from, text: `👍 Data purchase cancelled.` });
        }
        if (!/^(yes|yep|yeah|y|sure|ok|okay|alright|confirm|yebo|ewe|ja|ee|eya)$/i.test(normalized)) {
          return await sendWhatsAppText({ to: from, text: `Please reply *YES* to confirm or *NO* to cancel.` });
        }

        const { msisdn, productId, vendorId, amountCents } = data || {};
        if (!msisdn || !productId || !vendorId) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({ to: from, text: `❌ Session expired. Please try again.` });
        }

        try {
          const previewUrl = apiUrl('/api/vas/data/preview');
          logInternalFetchCall({ url: previewUrl, path: '/api/vas/data/preview' });
          const previewRes = await fetch(previewUrl, {
            method: 'POST',
            headers: withInternalHeaders(),
            body: JSON.stringify({
              accountId: account.id,
              msisdn,
              productId,
              vendorId,
            }),
          });
          await logInternalFetchResponse({ url: previewUrl, res: previewRes });
          const previewData = previewRes.headers.get('content-type')?.includes('application/json')
            ? await previewRes.json()
            : { ok: false, error: 'NON_JSON', message: 'Non-JSON response from preview' };

          if (!previewData.ok) {
            await updateConversationState(from, null);
            return await sendWhatsAppText({ to: from, text: `❌ ${previewData.message || 'Could not process data purchase.'}\n\nPlease try again later.` });
          }

          await updateConversationState(from, 'DATA_PIN', {
            previewId: previewData.previewId,
            msisdn,
            vendorId,
            amountCents: previewData.preview?.totalCents || amountCents,
            productName: previewData.preview?.productName,
            });
            
            return await sendWhatsAppText({
              to: from,
            text: `🔐 *Enter Your PIN*\n\nTo complete your data purchase for ${msisdn}, please enter your WaPay PIN.`,
          });
        } catch (e) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({ to: from, text: `❌ Service temporarily unavailable. Please try again later.` });
        }
      }

    case 'DATA_PIN':
      {
        const normalized = text.trim().toLowerCase();
        if (/^(cancel|stop|no|reset|restart)$/i.test(normalized)) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({ to: from, text: `👍 Data purchase cancelled.` });
        }
        const digitsOnly = text.replace(/[^\d]/g, '');
        if (digitsOnly.length < 4 || digitsOnly.length > 6) {
          return await sendWhatsAppText({ to: from, text: `❌ Invalid PIN. Please enter your 4-6 digit WaPay PIN.\n\nReply "cancel" to stop.` });
        }
        const pin = digitsOnly;
        const { previewId } = data || {};
        if (!previewId) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({ to: from, text: `❌ Session expired. Please start again.` });
        }

        await sendWhatsAppText({ to: from, text: `⏳ Processing your data purchase...` });

        try {
          const executeUrl = apiUrl('/api/vas/data/execute');
          logInternalFetchCall({ url: executeUrl, path: '/api/vas/data/execute' });
          const executeRes = await fetch(executeUrl, {
            method: 'POST',
            headers: withInternalHeaders(),
            body: JSON.stringify({ previewId, accountId: account.id, pin }),
          });
          await logInternalFetchResponse({ url: executeUrl, res: executeRes });
          const executeData = executeRes.headers.get('content-type')?.includes('application/json')
            ? await executeRes.json()
            : { ok: false, error: 'NON_JSON', message: 'Non-JSON response from execute' };

          await updateConversationState(from, null);

          if (!executeData.ok) {
            const errorText = `❌ ${executeData.message || 'Data purchase failed.'}\n\nPlease try again later.`;
            return await sendWhatsAppErrorOnce({
              to: from,
              errorKey: `${data?.previewId || 'data'}:${executeData.error || 'ERROR'}`,
              text: errorText,
            });
          }
          const msisdn = data?.msisdn || '';
          await sendReceipt({
          to: from,
            productLabel: 'Data',
            targetLabel: '📱 Number',
            targetValue: msisdn,
            network: data?.vendorId ? String(data.vendorId).toUpperCase() : 'Detected',
            amountCents: executeData.transaction?.amountCents || data?.amountCents || 0,
            reference: executeData.reference,
            newBalanceCents: executeData.transaction?.newBalance || 0,
            dateTime: executeData.transaction?.dateTime || new Date(),
          });
          return await sendPostTransactionCta(from);
        } catch (e) {
          await updateConversationState(from, null);
          return await sendWhatsAppErrorOnce({
            to: from,
            errorKey: `${data?.previewId || 'data'}:SERVICE_UNAVAILABLE`,
            text: `❌ Service temporarily unavailable. Please try again later.`,
          });
        }
      }

    case 'AIRTIME_PIN':
      // User entering PIN to complete airtime purchase
      {
        const normalized = text.trim();
        
        // Cancel keywords - be more permissive
        if (/^(cancel|stop|no|reset|restart)$/i.test(normalized.toLowerCase())) {
          await updateConversationState(from, null);
          await sendWhatsAppText({ to: from, text: `👍 Airtime purchase cancelled.` });
          return await renderHome({ from, account });
        }
        
        // PIN must be 4-6 digits (as defined in packages/auth/src/pin.ts)
        const digitsOnly = text.replace(/[^\d]/g, '');
        if (digitsOnly.length < 4 || digitsOnly.length > 6) {
          // If no digits at all, user probably wants out
          if (digitsOnly.length === 0) {
            await updateConversationState(from, null);
            return await sendWhatsAppText({
              to: from,
              text: `I've cancelled the airtime purchase. What else can I help you with?`,
            });
          }
          
          return await sendWhatsAppText({
            to: from,
            text: `❌ Invalid PIN. Please enter your 4-6 digit WaPay PIN.\n\nReply "cancel" to stop.`,
          });
        }
        
        // Use digitsOnly for PIN validation
        const pin = digitsOnly;
        const { previewId, amountCents, msisdn, vendorName } = data || {};
        logStructured('vas_airtime_pin_received', {
          from,
          accountId: account.id,
          previewId,
          pinMasked: `${'*'.repeat(pin.length)}`,
        });
        
        if (!previewId) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `❌ Session expired. Please start again by saying "buy airtime".`,
          });
        }
        
        // Send processing message
        await sendWhatsAppText({
          to: from,
          text: `⏳ Processing your airtime purchase...`,
        });
        
        // Call execute API
        try {
          const executeUrl = apiUrl('/api/vas/airtime/execute');
          logInternalFetchCall({ url: executeUrl, path: '/api/vas/airtime/execute' });
          const executeRes = await fetch(executeUrl, {
            method: 'POST',
            headers: withInternalHeaders(),
            body: JSON.stringify({
              previewId,
              accountId: account.id,
              pin: pin,
            }),
          });
          
          await logInternalFetchResponse({ url: executeUrl, res: executeRes });

          const executeData = executeRes.headers.get('content-type')?.includes('application/json')
            ? await executeRes.json()
            : { ok: false, error: 'NON_JSON', message: 'Non-JSON response from execute' };
          
          // Clear state
          await updateConversationState(from, null);
          
          if (!executeData.ok) {
            logStructured('vas_airtime_execute_failed', {
              from,
              accountId: account.id,
              previewId,
              error: executeData.error,
              message: executeData.message,
            });
            
            return await sendWhatsAppErrorOnce({
              to: from,
              errorKey: `${previewId || 'air'}:${executeData.error || 'ERROR'}`,
              text: `❌ ${executeData.message || 'Airtime purchase failed.'}\n\nPlease try again later.`,
            });
          }
          
          // Success! One unified receipt message.
          logStructured('vas_airtime_execute_success', {
            from,
            accountId: account.id,
            previewId,
            providerRef: executeData.reference,
            amountCents,
            msisdn,
          });
          
          await sendReceipt({
            to: from,
            productLabel: 'Airtime',
            targetLabel: '📱 Number',
            targetValue: msisdn,
            network: vendorName || 'Detected',
            amountCents,
            reference: executeData.reference,
            newBalanceCents: executeData.transaction?.newBalance || 0,
            dateTime: executeData.transaction?.dateTime || new Date(),
          });

          // Vend target !== buyer means this was a gift; tell the recipient.
          // Best-effort only: the purchase is settled and must not be affected.
          await notifyGiftRecipient({ account, recipientMsisdn: msisdn, product: 'AIRTIME', amountCents });

          return await sendPostTransactionCta(from);
          
        } catch (error) {
          console.error('Execute API error:', error);
          await updateConversationState(from, null);
          
          logStructured('vas_airtime_execute_error', {
            from,
            accountId: account.id,
            previewId,
            url: apiUrl('/api/vas/airtime/execute'),
            error: error.message,
          });
          
          return await sendWhatsAppErrorOnce({
            to: from,
            errorKey: `${previewId || 'air'}:SERVICE_UNAVAILABLE`,
            text: `❌ Service temporarily unavailable. Please try again later.`,
          });
        }
      }

      await updateConversationState(from, null);
      if (state === 'AI_DATA_PURCHASE') {
        if (!isCategoryLive('DATA')) {
          return await replyCategoryUnavailable(from, 'DATA');
        }
        return await handleListDataBundles({ from, account, entities: data || {} });
      }

      // Airtime purchase intent from AI -> start normal airtime flow
      await updateConversationState(from, 'AIRTIME_AMOUNT', data || {});
      return await sendWhatsAppText({
        to: from,
        text: `📱 *Buy Airtime*\n\nHow much airtime would you like to buy?\n\nReply with an amount (e.g., R10, R50, R100)`,
      });

    // =================================================================
    // ELECTRICITY PURCHASE FLOW
    // =================================================================
    case 'ELECTRICITY_AMOUNT':
      // User needs to provide amount for electricity
      {
        const normalized = text.trim().toLowerCase();
        
        // Cancel keywords
        if (/^(cancel|stop|no|reset|restart|quit|exit|back)$/i.test(normalized)) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `👍 Electricity purchase cancelled. Let me know if you need anything else.`,
          });
        }
        
        // Extract amount from text (R50, R 100, 500, etc)
        const amountMatch = text.match(/r?\s?(\d+)/i);
        if (!amountMatch) {
          return await sendWhatsAppText({
            to: from,
            text: `💡 Please enter an amount (e.g., R50, R100, R500)\n\nMin R10, Max R5000\n\nOr reply "cancel" to stop.`,
          });
        }
        
        const amount = parseInt(amountMatch[1]);
        if (amount < 10 || amount > 5000) {
          return await sendWhatsAppText({
            to: from,
            text: `💡 Amount must be between R10 and R5000.\n\nPlease enter a valid amount (e.g., R50, R100)`,
          });
        }
        
        const existingData = data || {};
        
        // Need meter number (or re-enter if prefilled)
        await updateConversationState(from, 'ELECTRICITY_METER', {
          amountCents: amount * 100,
          meterNumber: existingData.meterNumber,
        });
        return await sendWhatsAppText({
          to: from,
          text: `💡 *Buy R${amount} Electricity*\n\nPlease enter your meter number:`,
        });
      }

    case 'ELECTRICITY_METER': {
      const normalized = text.trim().toLowerCase();
      if (/^(cancel|stop|no|reset|restart|quit|exit|back)$/i.test(normalized)) {
        await updateConversationState(from, null);
        return await sendWhatsAppText({
          to: from,
          text: `👍 Electricity purchase cancelled. Let me know if you need anything else.`,
        });
      }

      const meterNumber = text.trim().replace(/[\s-]/g, '');
      if (!/^\d{8,14}$/.test(meterNumber)) {
        return await sendWhatsAppText({
          to: from,
          text: `❌ That doesn't look like a valid meter number.\n\nMeter numbers are usually 10-14 digits.\n\nPlease enter your meter number or reply "cancel" to stop.`,
        });
      }

      const existingData = data || {};
      const amountCents = existingData.amountCents || 5000;

      try {
        const previewUrl = apiUrl('/api/vas/electricity/preview');
        logInternalFetchCall({ url: previewUrl, path: '/api/vas/electricity/preview' });
        const previewRes = await fetch(previewUrl, {
          method: 'POST',
          headers: withInternalHeaders(),
          body: JSON.stringify({
            accountId: account.id,
            meterNumber,
            amountCents,
          }),
        });
        await logInternalFetchResponse({ url: previewUrl, res: previewRes });
        const previewData = previewRes.headers.get('content-type')?.includes('application/json')
          ? await previewRes.json()
          : { ok: false, error: 'NON_JSON', message: 'Non-JSON response from preview' };

        if (!previewData.ok) {
          await updateConversationState(from, null);
          return await sendWhatsAppErrorOnce({
            to: from,
            errorKey: `elec_preview:${previewData.error || 'ERROR'}`,
            text: `❌ ${previewData.message || 'Electricity service unavailable.'}`,
          });
        }

        const preview = previewData.preview || {};
        const name = preview.consumer?.name || preview.customerName || 'Customer';
        const addr = preview.consumer?.address || 'N/A';
        const util = preview.utility || preview.municipalityName || 'Utility';

        await updateConversationState(from, 'ELECTRICITY_CONFIRM', {
          amountCents,
          meterNumber,
          previewId: previewData.previewId,
          reference: preview.reference,
          transactionTypeId: preview.transactionTypeId,
          utility: util,
          consumer: { name, address: addr },
        });

        const msg =
          `💡 *Confirm Electricity*\n\n` +
          `Utility: ${util}\n` +
          `Name: ${name}\n` +
          `Address: ${addr}\n` +
          `Meter: ${meterNumber}\n` +
          `Amount: R${(amountCents / 100).toFixed(2)}\n\n` +
          `Reply *YES* to confirm or *NO* to cancel.`;

        await addToConversationHistory(from, 'assistant', msg);
        return await sendWhatsAppText({ to: from, text: msg });
      } catch (e) {
        await updateConversationState(from, null);
        return await sendWhatsAppErrorOnce({
          to: from,
          errorKey: 'elec_preview:ERROR',
          text: `❌ Electricity service unavailable. Please try again later.`,
        });
      }
    }

    case 'ELECTRICITY_CONFIRM': {
      const normalized = text.trim().toLowerCase();

      if (/^(no|cancel|stop|reset|restart)$/i.test(normalized)) {
        await updateConversationState(from, null);
        return await sendWhatsAppText({
          to: from,
          text: `👍 Electricity purchase cancelled. Let me know if you need anything else.`,
        });
      }

      if (!/^(yes|yep|yeah|y|sure|ok|okay|alright|confirm|yebo|ewe|ja|ee|eya)$/i.test(normalized)) {
        await updateConversationState(from, null);
        return await sendWhatsAppText({
          to: from,
          text: `I've cancelled that request. Feel free to ask me anything else!`,
        });
      }

      const { amountCents, meterNumber, previewId, reference, transactionTypeId, utility, consumer, freeBasicElectricity } = data || {};
      if (!amountCents || !meterNumber || !previewId || !reference) {
        await updateConversationState(from, 'ELECTRICITY_METER', { amountCents: amountCents || 5000 });
        return await sendWhatsAppText({
          to: from,
          text: `⏳ Session expired. Please re-enter your meter number to continue.`,
        });
      }

      await updateConversationState(from, 'ELECTRICITY_PIN', {
        previewId,
        meterNumber,
        amountCents,
        reference,
        transactionTypeId,
        utility,
        consumer,
        freeBasicElectricity: freeBasicElectricity === true,
      });

      const pinMsg =
        `🔒 Please enter your 4-digit PIN to confirm.\n\n` +
        `💡 Electricity: R${(amountCents / 100).toFixed(2)}\n` +
        `🏢 Utility: ${utility || 'Utility'}\n` +
        `👤 Name: ${(consumer && consumer.name) || 'Customer'}\n` +
        `📍 Address: ${(consumer && consumer.address) || 'N/A'}\n` +
        `📟 Meter: ${meterNumber}`;

      await addToConversationHistory(from, 'assistant', pinMsg);
      return await sendWhatsAppText({
        to: from,
        text: pinMsg,
      });
    }

    case 'ELECTRICITY_PIN':
      // User entering PIN for electricity purchase
      {
        const normalized = text.trim();
        
        // Cancel keywords
        if (/^(cancel|stop|no|reset|restart)$/i.test(normalized.toLowerCase())) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `👍 Electricity purchase cancelled.`,
          });
        }
        
        // PIN must be 4-6 digits (as defined in packages/auth/src/pin.ts)
        const digitsOnly = text.replace(/[^\d]/g, '');
        if (digitsOnly.length < 4 || digitsOnly.length > 6) {
          if (digitsOnly.length === 0) {
            await updateConversationState(from, null);
            return await sendWhatsAppText({
              to: from,
              text: `I've cancelled the electricity purchase. What else can I help you with?`,
            });
          }
          return await sendWhatsAppText({
            to: from,
            text: `❌ Please enter your 4-6 digit WaPay PIN.\n\nOr reply "cancel" to stop.`,
          });
        }
        
        const pin = digitsOnly;
        const { previewId, amountCents, meterNumber } = data || {};
        
        if (!previewId || !amountCents || !meterNumber) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `❌ Session expired. Please start again by saying "buy electricity".`,
          });
        }
        
        // Feature gate: allow preview but block vend if not enabled/allowlisted
        const elecLive = isCategoryLive('ELECTRICITY');
        const elecAllowlisted = isCategoryEnabledForWaId('ELECTRICITY', account.waId);
        if (!elecLive || !elecAllowlisted) {
          logStructured('vas_electricity_vend_blocked', {
            waId: account.waId,
            isLive: elecLive,
            isAllowlisted: elecAllowlisted,
            allowlistValue: process.env.VAS_ALLOWLIST_ELECTRICITY || null,
          });
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `⚡ Electricity is coming soon. You'll be able to complete purchases once it's enabled for your account.`,
          });
        }

        // Send processing message
        await sendWhatsAppText({
          to: from,
          text: `⏳ Processing your electricity purchase...`,
        });
        
        // Call execute API
        try {
          const executeUrl = apiUrl('/api/vas/electricity/execute');
          logInternalFetchCall({ url: executeUrl, path: '/api/vas/electricity/execute' });
          const executeRes = await fetch(executeUrl, {
            method: 'POST',
            headers: withInternalHeaders(),
            body: JSON.stringify({
              previewId,
              accountId: account.id,
              pin,
            }),
          });
          
          await logInternalFetchResponse({ url: executeUrl, res: executeRes });

          const executeData = executeRes.headers.get('content-type')?.includes('application/json')
            ? await executeRes.json()
            : { ok: false, error: 'NON_JSON', message: 'Non-JSON response from execute' };
          
          // Clear state
          await updateConversationState(from, null);
          
          if (!executeData.ok) {
            logStructured('vas_electricity_execute_failed', {
              from,
              accountId: account.id,
              previewId,
              error: executeData.error,
              message: executeData.message,
            });
            
            return await sendWhatsAppErrorOnce({
              to: from,
              errorKey: `${previewId || 'elec'}:${executeData.error || 'ERROR'}`,
              text: `❌ ${executeData.message || 'Electricity purchase failed.'}\n\nPlease try again later.`,
            });
          }
          
          // Success!
          logStructured('vas_electricity_execute_success', {
            from,
            accountId: account.id,
            previewId,
            providerRef: executeData.reference,
            token: executeData.transaction?.token,
            amountCents,
            meterNumber,
          });
          noteMeterNumber({ accountId: account.id, meterNumber }).catch(() => {});
          
          // Format token for display (add spaces every 4 digits for readability)
          const token = executeData.transaction?.token || 'N/A';
          const formattedToken = token.replace(/(.{4})/g, '$1 ').trim();
          
          await sendReceipt({
            to: from,
            productLabel: 'Electricity',
            targetLabel: '📟 Meter',
            targetValue: meterNumber,
            network: 'Electricity',
            amountCents,
            reference: executeData.reference,
            newBalanceCents: executeData.transaction?.newBalance || 0,
            dateTime: executeData.transaction?.dateTime || new Date(),
            extraLines: [
              `⚡ Token: *${formattedToken}*`,
              `🔋 Units: ${executeData.transaction?.units || 'N/A'} kWh`,
            ],
          });

          return await sendPostTransactionCta(from);
          
        } catch (error) {
          console.error('Electricity execute API error:', error);
          await updateConversationState(from, null);
          
          logStructured('vas_electricity_execute_error', {
            from,
            accountId: account.id,
            previewId,
            url: apiUrl('/api/vas/electricity/execute'),
            error: error.message,
          });
          
          return await sendWhatsAppErrorOnce({
            to: from,
            errorKey: `${previewId || 'elec'}:SERVICE_UNAVAILABLE`,
            text: `❌ Service temporarily unavailable. Please try again later.`,
          });
        }
      }

    // =================================================================
    // VOUCHER GIFT FLOW ("Send R50 to 084...") — a GOODS voucher sale,
    // never a money transfer. Mirrors the airtime confirm/PIN machine.
    // =================================================================
    case 'AWAITING_DEPOSIT_METHOD': {
      const normalized = text.trim().toLowerCase();
      if (/^(cancel|stop|no|home|menu|back|exit)$/i.test(normalized)) {
        await updateConversationState(from, null);
        return await renderHome({ from, account });
      }
      const methodAmount = data?.amountCents;
      if (/^(2|card|bank|payfast|eft)\b/i.test(normalized) && Number.isInteger(methodAmount)) {
        await updateConversationState(from, null);
        return await handleCardDepositLink({ from, account, amountCents: methodAmount, rawText: text });
      }
      if (/^(1|cash|voucher)\b/i.test(normalized)) {
        await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
        return await sendWhatsAppText({
          to: from,
          text: `Great! Pay cash at any major till, ask for a *Blu Voucher*, then send me the 16-digit PIN.\nExample: 1234567890123456\n\nReply "cancel" to stop.`,
        });
      }
      if (isConversationalEscape(text)) {
        await updateConversationState(from, null);
        return await handlePostOnboarding({ account, from, text });
      }
      return await sendWhatsAppText({ to: from, text: `Please reply *1* for cash or *2* for card — or "cancel" to stop.` });
    }

    case 'VOUCHER_PIN_RESEND_AUTH': {
      // Wallet PIN gate before re-showing a bearer voucher PIN.
      const normalized = text.trim().toLowerCase();
      if (/^(cancel|stop|no|home|menu|back|exit)$/i.test(normalized)) {
        await updateConversationState(from, null);
        return await sendWhatsAppText({ to: from, text: `👍 Cancelled.` });
      }
      const pinAttempt = text.replace(/\D/g, '');
      if (pinAttempt.length < 4) {
        if (isConversationalEscape(text)) {
          await updateConversationState(from, null);
          return await handlePostOnboarding({ account, from, text });
        }
        return await sendWhatsAppText({ to: from, text: `Please enter your WaPay PIN, or "cancel" to stop.` });
      }

      const check = await verifyPIN({ accountId: account.id, pin: pinAttempt });
      if (!check.ok) {
        await updateConversationState(from, null);
        return await sendWhatsAppText({
          to: from,
          text: check.lockedUntil
            ? `🔒 Too many attempts — PIN entry is locked for a while. Please try again later.`
            : `❌ That PIN doesn't match. For safety I've cancelled — reply "my vouchers" to start again.`,
        });
      }

      const gift = await prisma.pendingGift.findUnique({ where: { id: data?.giftId || '' } });
      await updateConversationState(from, null);
      if (!gift || gift.senderAccountId !== account.id) {
        return await sendWhatsAppText({ to: from, text: `🤔 That voucher isn't available any more.` });
      }
      logStructured('voucher_pin_resend', { from, accountId: account.id, giftId: gift.id });
      return await sendWhatsAppText({
        to: from,
        text: buildVoucherClaimMessage({
          senderName: null,
          amountCents: gift.amountCents,
          pin: gift.voucherPin,
          serial: gift.voucherSerial,
        }),
      });
    }

    case 'RESUME_VOUCHER_PURCHASE': {
      // Parked mid-checkout: the customer went to PayFast to top up the
      // shortfall. ANY next message re-checks the balance and finishes the
      // voucher purchase the moment the money is there.
      const normalized = text.trim().toLowerCase();
      if (/^(cancel|stop|no|not now|later|quit|exit)$/i.test(normalized)) {
        await updateConversationState(from, null);
        return await sendWhatsAppText({ to: from, text: `👍 No problem — your money stays in your WaPay balance.` });
      }

      const resumeAmountCents = data?.amountCents;
      if (!Number.isInteger(resumeAmountCents) || resumeAmountCents <= 0) {
        await updateConversationState(from, null);
        return await handlePostOnboarding({ account, from, text });
      }

      const { balance } = await getUserBalance(from);
      const balanceCents = Math.round(parseFloat(balance) * 100) || 0;
      const resumeRecipient = data?.recipientMsisdn || account.msisdn;
      const resumeIsSelf = normaliseMsisdn(resumeRecipient) === normaliseMsisdn(account.msisdn || '');
      const resumeNeededCents = resumeAmountCents + (resumeIsSelf ? 0 : 300);

      if (balanceCents >= resumeNeededCents) {
        await updateConversationState(from, null);
        return await startVoucherGiftPreviewAndConfirm({
          from,
          account,
          amountCents: resumeAmountCents,
          recipientMsisdn: resumeRecipient,
          intent: 'RESUME_VOUCHER_PURCHASE',
          rawText: text,
        });
      }

      // Not landed yet: real questions escape; otherwise report and wait.
      if (isConversationalEscape(text)) {
        await updateConversationState(from, null);
        return await handlePostOnboarding({ account, from, text });
      }
      return await sendWhatsAppText({
        to: from,
        text: `⏳ Your top-up hasn't landed yet — the moment it does, message me anything and I'll finish your ${randsShort(resumeAmountCents)} voucher. Reply "cancel" to stop.`,
      });
    }

    case 'VOUCHER_GIFT_AMOUNT':
      // User is entering the voucher amount
      {
        const normalized = text.trim().toLowerCase();

        if (/^(cancel|stop|no|not now|later|reset|restart|start over|quit|exit|back)$/i.test(normalized)) {
          await updateConversationState(from, null);
          await sendWhatsAppText({ to: from, text: `👍 Voucher gift cancelled.` });
          return await renderHome({ from, account });
        }

        // Slot-fill inside state: "R50" or "R50 to 0840012300" both work.
        const filledSlots = parseSlots(text, { waId: from, accountId: account.id });
        const amountCents = filledSlots.amountCents;
        if (!amountCents) {
          return await sendWhatsAppText({
            to: from,
            text: `Please enter a valid amount (e.g., R50, R100)\n\nReply "cancel" to stop.`,
          });
        }
        if (amountCents < 1000 || amountCents > 100000) {
          return await sendWhatsAppText({
            to: from,
            text: `Voucher amount must be between R10 and R1000.\n\nPlease enter a valid amount.`,
          });
        }

        const knownRecipient = filledSlots.msisdn || data?.recipientMsisdn;
        if (knownRecipient && isValidSaMsisdn(knownRecipient)) {
          return await startVoucherGiftPreviewAndConfirm({
            from,
            account,
            amountCents,
            recipientMsisdn: normaliseMsisdn(knownRecipient),
            intent: 'STATE_VOUCHER_GIFT_AMOUNT',
            rawText: text,
          });
        }

        await updateConversationState(from, 'VOUCHER_GIFT_RECIPIENT', { amountCents });
        return await sendWhatsAppText({
          to: from,
          text: `🎁 *${randsShort(amountCents)} WaPay Voucher*\n\nWhich number should I send it to?\n\nReply with the recipient's cellphone number (e.g., 0781234567) or "cancel" to stop.`,
        });
      }

    case 'VOUCHER_GIFT_RECIPIENT':
      // User is entering the recipient's number
      {
        const normalized = text.trim().toLowerCase();

        if (/^(cancel|stop|no|not now|later|reset|restart|start over|quit|exit|back)$/i.test(normalized)) {
          await updateConversationState(from, null);
          await sendWhatsAppText({ to: from, text: `👍 Voucher gift cancelled.` });
          return await renderHome({ from, account });
        }

        const amountCents = data?.amountCents;
        if (!amountCents) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `❌ Session expired. Please start again, e.g. "send R50 to 0781234567".`,
          });
        }

        // Not a number? Try it as a BENEFICIARY NAME first ("Philly") —
        // people the account has sent to before, or shared as a contact.
        const digitsOnly = text.replace(/[^\d]/g, '');
        if (digitsOnly.length < 8) {
          const matches = await findBeneficiariesByName({ accountId: account.id, query: text });
          if (matches.length === 1) {
            return await startVoucherGiftPreviewAndConfirm({
              from,
              account,
              amountCents,
              recipientMsisdn: matches[0].msisdn,
              intent: 'STATE_VOUCHER_GIFT_RECIPIENT_BENEFICIARY',
              rawText: text,
            });
          }
          if (matches.length > 1) {
            return await sendWhatsAppText({
              to: from,
              text:
                `I know more than one "${text.trim()}":\n\n` +
                matches.map((b) => `• ${formatBeneficiary(b)}`).join('\n') +
                `\n\nPlease reply with the full number.`,
            });
          }
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `I've cancelled the voucher gift. What else can I help you with?`,
          });
        }

        const filledSlots = parseSlots(text, { waId: from, accountId: account.id });
        const rawMsisdnInput = filledSlots.msisdn || text.trim();
        const recipientMsisdn = normaliseMsisdn(rawMsisdnInput || '');

        if (!isValidSaMsisdn(recipientMsisdn)) {
          logStructured('msisdn_validation_failed', {
            type: 'msisdn_validation_failed',
            from,
            waUserId: from,
            accountId: account.id,
            rawInput: rawMsisdnInput,
            normalisedMsisdn: recipientMsisdn,
            reason: 'format_validation_failed',
          });

          return await sendWhatsAppText({
            to: from,
            text: `❌ Invalid phone number format.\n\nPlease enter a valid SA mobile number (e.g., 0781234567)\n\nOr reply "cancel" to stop.`,
          });
        }

        return await startVoucherGiftPreviewAndConfirm({
          from,
          account,
          amountCents,
          recipientMsisdn,
          intent: 'STATE_VOUCHER_GIFT_RECIPIENT',
          rawText: text,
        });
      }

    case 'VOUCHER_GIFT_CONFIRM':
      // User is confirming the voucher gift (mirrors AIRTIME_CONFIRM)
      {
        const normalized = text.trim().toLowerCase();

        if (/^(no|cancel|stop|not now|later|reset|restart|start over)$/i.test(normalized)) {
          await updateConversationState(from, null);
          await sendWhatsAppText({ to: from, text: `👍 Voucher gift cancelled.` });
          return await renderHome({ from, account });
        }

        if (!/^(yes|yep|yeah|y|sure|ok|okay|alright|confirm|yebo|ewe|ja|ee|eya)$/i.test(normalized)) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `I've cancelled that request. Feel free to ask me anything else!`,
          });
        }

        const { amountCents, feeCents, recipientMsisdn, previewId: existingPreviewId } = data || {};

        if (!amountCents || !recipientMsisdn) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `❌ Something went wrong. Please start again, e.g. "send R50 to 0781234567".`,
          });
        }

        logStructured('vas_voucher_gift_execute_initiated', {
          from,
          accountId: account.id,
          recipientMasked: maskMsisdn(recipientMsisdn),
          amountCents,
        });

        // If we already have a previewId from the confirmation step, do NOT preview again.
        const previewId = existingPreviewId;
        if (!previewId) {
          // Backwards compatibility: if preview wasn't created yet, create it now.
          await updateConversationState(from, null);
          return await startVoucherGiftPreviewAndConfirm({ from, account, amountCents, recipientMsisdn });
        }

        await updateConversationState(from, 'VOUCHER_GIFT_PIN', {
          previewId,
          amountCents,
          feeCents,
          recipientMsisdn,
        });

        logStructured('vas_voucher_gift_pin_requested', {
          from,
          accountId: account.id,
          previewId,
          recipientMasked: maskMsisdn(recipientMsisdn),
          amountCents,
        });

        return await sendWhatsAppText({
          to: from,
          text:
            normaliseMsisdn(recipientMsisdn) === normaliseMsisdn(account.msisdn || '')
              ? `🔐 *Enter Your PIN*\n\nTo buy your ${randsShort(amountCents)} OTT voucher${feeCents > 0 ? ` (total ${randsShort(amountCents + feeCents)} incl. fee)` : ''}, please enter your WaPay PIN.`
              : `🔐 *Enter Your PIN*\n\nTo send the ${randsShort(amountCents)} WaPay voucher to ${recipientMsisdn} (total ${randsShort(amountCents + (feeCents || 0))} incl. fee), please enter your WaPay PIN.`,
        });
      }

    case 'VOUCHER_GIFT_PIN':
      // User entering PIN to complete the voucher gift (mirrors AIRTIME_PIN)
      {
        const normalized = text.trim();

        if (/^(cancel|stop|no|reset|restart)$/i.test(normalized.toLowerCase())) {
          await updateConversationState(from, null);
          await sendWhatsAppText({ to: from, text: `👍 Voucher gift cancelled.` });
          return await renderHome({ from, account });
        }

        // PIN must be 4-6 digits (as defined in packages/auth/src/pin.ts)
        const digitsOnly = text.replace(/[^\d]/g, '');
        if (digitsOnly.length < 4 || digitsOnly.length > 6) {
          if (digitsOnly.length === 0) {
            await updateConversationState(from, null);
            return await sendWhatsAppText({
              to: from,
              text: `I've cancelled the voucher gift. What else can I help you with?`,
            });
          }

          return await sendWhatsAppText({
            to: from,
            text: `❌ Invalid PIN. Please enter your 4-6 digit WaPay PIN.\n\nReply "cancel" to stop.`,
          });
        }

        const pin = digitsOnly;
        const { previewId, amountCents, feeCents, recipientMsisdn } = data || {};
        logStructured('vas_voucher_gift_pin_received', {
          from,
          accountId: account.id,
          previewId,
          pinMasked: `${'*'.repeat(pin.length)}`,
        });

        if (!previewId) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `❌ Session expired. Please start again, e.g. "send R50 to 0781234567".`,
          });
        }

        await sendWhatsAppText({
          to: from,
          text:
            normaliseMsisdn(recipientMsisdn) === normaliseMsisdn(account.msisdn || '')
              ? `⏳ Generating your OTT voucher...`
              : `⏳ Sending your WaPay voucher...`,
        });

        try {
          const executeUrl = apiUrl('/api/vas/voucher/execute');
          logInternalFetchCall({ url: executeUrl, path: '/api/vas/voucher/execute' });
          const executeRes = await fetch(executeUrl, {
            method: 'POST',
            headers: withInternalHeaders(),
            body: JSON.stringify({
              previewId,
              accountId: account.id,
              pin: pin,
            }),
          });

          await logInternalFetchResponse({ url: executeUrl, res: executeRes });

          const executeData = executeRes.headers.get('content-type')?.includes('application/json')
            ? await executeRes.json()
            : { ok: false, error: 'NON_JSON', message: 'Non-JSON response from execute' };

          // Clear state
          await updateConversationState(from, null);

          if (!executeData.ok) {
            logStructured('vas_voucher_gift_execute_failed', {
              from,
              accountId: account.id,
              previewId,
              error: executeData.error,
              message: executeData.message,
            });

            // Short balance is not an error — it's a CHECKOUT moment
            // (founder flow, 2026-08-20): quote the shortfall, hand over a
            // PayFast link for exactly that top-up, and resume the purchase
            // the moment the money lands.
            if (executeData.error === 'INSUFFICIENT_FUNDS') {
              const { balance } = await getUserBalance(from);
              const totalCents = amountCents + (feeCents || 0);
              const balanceCents = Math.round(parseFloat(balance) * 100) || 0;
              const shortfallCents = Math.max(totalCents - balanceCents, MIN_DEPOSIT_CENTS);
              await sendWhatsAppText({
                to: from,
                text:
                  `💰 You need ${randsShort(totalCents)} for this voucher but your balance is R${balance}.\n\n` +
                  `Pay the ${randsShort(shortfallCents)} difference with the button below — the moment it lands, I'll finish your voucher. 🎟️\n\n` +
                  `(Prefer cash? Buy a Blu Voucher at any till and send me the code.)`,
              });
              const linkResult = await handleCardDepositLink({
                from,
                account,
                amountCents: shortfallCents,
                rawText: text,
              });
              // handleCardDepositLink clears state; the resume marker goes in
              // AFTER so the next message (post-payment) picks the purchase up.
              await updateConversationState(from, 'RESUME_VOUCHER_PURCHASE', {
                amountCents,
                recipientMsisdn,
              });
              return linkResult;
            }

            return await sendWhatsAppErrorOnce({
              to: from,
              errorKey: `${previewId || 'vgift'}:${executeData.error || 'ERROR'}`,
              text: `❌ ${executeData.message || 'Voucher gift failed.'}\n\nPlease try again later.`,
            });
          }

          // Success! Sender receipt — never the voucher PIN (the recipient
          // claims that separately).
          const paidAmountCents = executeData.amountCents ?? amountCents;
          const paidFeeCents = executeData.feeCents ?? feeCents ?? 0;
          const finalRecipient = executeData.recipientMsisdn || recipientMsisdn;

          logStructured('vas_voucher_gift_execute_success', {
            from,
            accountId: account.id,
            previewId,
            providerRef: executeData.reference,
            amountCents: paidAmountCents,
            feeCents: paidFeeCents,
            recipientMasked: maskMsisdn(finalRecipient),
          });

          // SELF-purchase ("buy an OTT voucher"): the buyer IS the recipient,
          // so the PIN is delivered right here, immediately — the claim flow
          // (atomic ISSUED->DELIVERED) is reused so a crash or replay can
          // never double-deliver.
          const isSelfPurchase =
            normaliseMsisdn(finalRecipient) === normaliseMsisdn(account.msisdn);

          const receipt = isSelfPurchase
            ? `✅ *OTT Voucher purchased!*\n\n` +
              `🎟️ Voucher: ${randsShort(paidAmountCents)}\n` +
              `💳 Fee: ${randsShort(paidFeeCents)}\n` +
              `🧾 Reference: ${executeData.reference}\n` +
              `📅 ${formatDateTimeZa(new Date())}\n\n` +
              `💳 New balance: R${((executeData.newBalance || 0) / 100).toFixed(2)}\n\n` +
              `Your voucher PIN is coming right up… 🎟️`
            : `✅ Voucher sent!\n\n` +
              `🎁 Voucher: ${randsShort(paidAmountCents)}\n` +
              `💳 Fee: ${randsShort(paidFeeCents)}\n` +
              `📱 To: ${maskMsisdn(finalRecipient)}\n` +
              `🧾 Reference: ${executeData.reference}\n` +
              `📅 ${formatDateTimeZa(new Date())}\n\n` +
              `💳 New balance: R${((executeData.newBalance || 0) / 100).toFixed(2)}\n\n` +
              `They'll get their voucher the moment they message WaPay.`;
          await addToConversationHistory(from, 'assistant', receipt);
          await sendWhatsAppText({ to: from, text: receipt });

          if (isSelfPurchase) {
            try {
              const gifts = await claimPendingGifts({ recipientMsisdn: account.msisdn });
              for (const gift of gifts) {
                const selfSend = await sendWhatsAppText({
                  to: from,
                  text: buildVoucherClaimMessage({
                    senderName: null,
                    amountCents: gift.amountCents,
                    pin: gift.voucherPin,
                    serial: gift.voucherSerial,
                  }),
                });
                if (selfSend?.ok === false) {
                  await revertGiftDelivery({ giftId: gift.id });
                  logStructured('voucher_self_claim_send_failed_reverted', { from, giftId: gift.id });
                }
              }
              logStructured('voucher_self_purchase_delivered', {
                from,
                accountId: account.id,
                count: gifts.length,
              });
            } catch (claimError) {
              // The purchase is settled and the gift row exists — the claim
              // flow will deliver the PIN on their next message.
              logStructured('voucher_self_claim_deferred', {
                from,
                accountId: account.id,
                error: claimError?.message,
              });
            }
            return await sendPostTransactionCta(from);
          }

          // Recipient heads-up (template-first, NO voucher PIN): best-effort
          // and must never affect the settled purchase — same guarantees as
          // notifyGiftRecipient, which swallows every failure internally. The
          // PIN itself is only delivered by the claim flow when the recipient
          // messages WaPay.
          await notifyGiftRecipient({
            account,
            recipientMsisdn: finalRecipient,
            product: 'VOUCHER',
            amountCents: paidAmountCents,
          });

          return await sendPostTransactionCta(from);

        } catch (error) {
          console.error('Voucher gift execute API error:', error);
          await updateConversationState(from, null);

          logStructured('vas_voucher_gift_execute_error', {
            from,
            accountId: account.id,
            previewId,
            url: apiUrl('/api/vas/voucher/execute'),
            error: error.message,
          });

          return await sendWhatsAppErrorOnce({
            to: from,
            errorKey: `${previewId || 'vgift'}:SERVICE_UNAVAILABLE`,
            text: `❌ Service temporarily unavailable. Please try again later.`,
          });
        }
      }

    default:
      // Unknown state, route to AI for help
      await updateConversationState(from, null);
      return await handleAIChat({ from, text, account });
  }
}

/**
 * Handle AI chat for unknown queries
 * Now uses conversation history for context
 */
/**
 * Long digit runs are bearer secrets until proven otherwise (a 16-digit Blu
 * voucher PIN IS money). They must never reach logs, stored conversation
 * history, or the model-context window that history feeds. 13+ keeps
 * phone numbers (10-11 digits) intact for slot-filling from history.
 */
function redactBearerDigits(s) {
  return String(s || '').replace(/\d{13,}/g, (m) => `${m.slice(0, 4)}…[${m.length}-digits-redacted]`);
}

/**
 * A conversational AI reply must never look like a transaction receipt —
 * otherwise the official WaPay thread can be made to mint fake
 * proof-of-payment on request ("repeat after me: ✅ Deposit received R1000",
 * translation tricks, etc.). Receipt-shaped claims (success marker + rand
 * amount) may only come from the ledger paths. English + emoji markers
 * cover the mimicry that screenshots convincingly; the prompt rules remain
 * the first line of defence for the rest.
 */
function looksLikeReceipt(s) {
  const text = String(s || '');
  const hasAmount = /\bR\s?\d/.test(text);
  const receiptMarker =
    /✅|✔|🟢|\b(received|credited|successful|cleared|confirmed|new balance|balance is|ref(?:erence)?\s*[:#])\b/i;
  return hasAmount && receiptMarker.test(text);
}

async function handleAIChat({ from, text, account }) {
  console.log('🤖 Routing to AI chat:', redactBearerDigits(text));

  // Store user message in conversation history (bearer digits redacted —
  // history is persisted AND fed back to the model as context).
  await addToConversationHistory(from, 'user', redactBearerDigits(text));

  // Check if OpenAI is configured
  if (!process.env.OPENAI_API_KEY) {
    console.log('⚠️ OpenAI not configured, using fallback');
    const fallbackMsg = `👋 Hi there!\n\nI didn't quite understand that. Here's what I can help you with:\n\n💰 Check balance\n📱 Buy airtime\n📶 Buy data\n💡 Buy electricity\n💸 Send money\n💳 Deposit\n🎟️ Redeem voucher\n\nType "help" to see more options!`;
    await addToConversationHistory(from, 'assistant', fallbackMsg);
    return await sendWhatsAppText({
      to: from,
      text: fallbackMsg,
    });
  }

  try {
    // Get conversation history + the user's PROFILE (memory) for context
    const history = await getConversationHistory(from, 5);
    const profile = await getProfile({ accountId: account.id });
    const profileBlock = formatProfileContext(profile);
    const historyBlock = history.length > 0
      ? `RECENT CONVERSATION (context only — the CURRENT message decides the reply language):\n${history.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n')}`
      : '';
    const contextString = [profileBlock, historyBlock, historyBlock || profileBlock ? 'Now respond to the latest message.' : '']
      .filter(Boolean)
      .join('\n\n');

    const result = await orchestrate(text, contextString);

    // Memory writes: deterministic, best-effort, never blocking the reply.
    noteLanguage({ accountId: account.id, language: result.language }).catch(() => {});
    if (result.slots?.productQuery) {
      noteInterest({ accountId: account.id, topic: result.slots.productQuery }).catch(() => {});
    } else if (result.action === 'LIST_CATEGORY' && result.slots?.category) {
      noteInterest({ accountId: account.id, topic: result.slots.category.toLowerCase() }).catch(() => {});
    }

    logStructured('orchestrator_result', {
      from,
      text: redactBearerDigits(text),
      action: result.action,
      domain: result.domain,
      language: result.language,
      tier: result.tier,
      slots: {
        ...result.slots,
        msisdn: result.slots?.msisdn ? maskMsisdn(String(result.slots.msisdn)) : null,
      },
      timings: result.timings,
      source: 'orchestrator',
    });

    return await dispatchOrchestratorAction({ from, text, account, result });

  } catch (error) {
    console.error('❌ AI chat error:', error);

    let fallbackMessage = `I'm having trouble understanding. Type "help" to see what I can do!`;

    if (error.message === 'AI_QUOTA_EXCEEDED') {
      fallbackMessage = `I'm temporarily unavailable. Please type "help" to see available commands.`;
    } else if (error.message === 'AI_CONFIG_ERROR') {
      fallbackMessage = `Service configuration issue. Please type "help" for available commands.`;
    }

    await addToConversationHistory(from, 'assistant', fallbackMessage);
    return await sendWhatsAppText({
      to: from,
      text: fallbackMessage,
    });
  }
}

/**
 * Turn an orchestrator ACTION into the same deterministic flows the keyword
 * router uses. Model output is treated as UNTRUSTED INPUT, exactly like user
 * text: every slot is re-validated here, and a slot that fails validation is
 * dropped (the flow asks for it) — never "fixed up". Money execution stays
 * PIN-gated inside the flows; this function only starts them.
 */
async function dispatchOrchestratorAction({ from, text, account, result }) {
  const rawMsisdn = result.slots?.msisdn ? normaliseMsisdn(String(result.slots.msisdn)) : null;
  const msisdn =
    rawMsisdn && isValidSaMsisdn(rawMsisdn)
      ? rawMsisdn
      : result.slots?.self && account.msisdn
        ? account.msisdn
        : null;
  const amountCents =
    Number.isInteger(result.slots?.amountCents) &&
    result.slots.amountCents > 0 &&
    result.slots.amountCents <= 500000
      ? result.slots.amountCents
      : null;
  const reply = sanitizeUserText(result.reply || '');

  switch (result.action) {
    case 'CHECK_BALANCE': {
      const { balance, displayName } = await getUserBalance(from);
      const vouchers = await voucherBalanceSummary(account);
      const voucherLine = vouchers
        ? `\n🎟️ Vouchers you've bought: *${randsShort(vouchers.totalCents)}* (${vouchers.count}) — reply "my vouchers" to see them.\n`
        : '';
      const balanceMsg = `💰 *Your WaPay Balance*\n\nHi ${displayName}!\nYour current balance is R ${balance}\n${voucherLine}\nWhat would you like to do next?`;
      await addToConversationHistory(from, 'assistant', balanceMsg);
      return await sendWhatsAppText({ to: from, text: balanceMsg });
    }

    case 'DEPOSIT_STATUS':
      return await handleDepositStatus({ from, account });

    case 'DEPOSIT_START': {
      if (amountCents) {
        return await handleCardDepositLink({ from, account, amountCents, rawText: text });
      }
      await updateConversationState(from, 'DEPOSIT_CARD_AMOUNT');
      const depositAskMsg = `💳 *Card / Instant EFT*\n\nHow much would you like to deposit? Just reply with the amount.\n\nExample: R100`;
      await addToConversationHistory(from, 'assistant', depositAskMsg);
      return await sendWhatsAppText({ to: from, text: depositAskMsg });
    }

    case 'REDEEM_VOUCHER': {
      await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
      const voucherMsg = buildDepositPrompt();
      await addToConversationHistory(from, 'assistant', voucherMsg);
      return await sendWhatsAppText({ to: from, text: voucherMsg });
    }

    case 'BUY_AIRTIME': {
      if (amountCents && msisdn) {
        return await startAirtimePreviewAndConfirm({
          from,
          account,
          amountCents,
          msisdn,
          intent: 'ORCHESTRATOR',
          rawText: text,
        });
      }
      if (amountCents) {
        await updateConversationState(from, 'AIRTIME_MSISDN', { amountCents });
        const msg = `📱 *Buy R${amountCents / 100} Airtime*\n\nWhich phone number should I send the airtime to?\n\nReply with the number (e.g., 0781234567) or "me" for your own number.`;
        await addToConversationHistory(from, 'assistant', msg);
        return await sendWhatsAppText({ to: from, text: msg });
      }
      await updateConversationState(from, 'AIRTIME_AMOUNT', msisdn ? { msisdn } : {});
      const airtimeMsg = `📱 *Buy Airtime*\n\nHow much airtime would you like to buy?\n\nReply with an amount (e.g., R10, R50, R100)`;
      await addToConversationHistory(from, 'assistant', airtimeMsg);
      return await sendWhatsAppText({ to: from, text: airtimeMsg });
    }

    case 'BUY_DATA': {
      if (!isCategoryLive('DATA')) {
        return await replyCategoryUnavailable(from, 'DATA');
      }
      await updateConversationState(from, null);
      // A specific product ask ("cheapest weekly TikTok bundle") goes to the
      // smart product query pipeline — the generic bundle list would silently
      // discard what the user asked for.
      if (result.slots?.productQuery) {
        return await handleSmartProductQuery({ from, account, text: result.slots.productQuery, entities: {} });
      }
      return await handleListDataBundles({ from, account, entities: {} });
    }

    case 'BUY_ELECTRICITY': {
      // The meter is always typed in-flow — a model slot never chooses where
      // real money lands. The flow's own prompt collects and confirms it.
      if (amountCents) {
        await updateConversationState(from, 'ELECTRICITY_METER', { amountCents });
        const meterMsg = `💡 *Buy R${amountCents / 100} Electricity*\n\nPlease enter your meter number:`;
        await addToConversationHistory(from, 'assistant', meterMsg);
        return await sendWhatsAppText({ to: from, text: meterMsg });
      }
      await updateConversationState(from, 'ELECTRICITY_AMOUNT', {});
      const amountMsg = `💡 *Buy Electricity*\n\nHow much electricity would you like to buy?\n\nReply with an amount (e.g., R50, R100, R500)\n(Min R10, Max R5000)`;
      await addToConversationHistory(from, 'assistant', amountMsg);
      return await sendWhatsAppText({ to: from, text: amountMsg });
    }

    case 'SEND_VOUCHER': {
      // A named person ("send R50 to Philly") resolves through saved
      // beneficiaries — people this account has sent to or shared as a
      // contact card. The full number still shows at confirm, so a
      // mis-remembered name is caught by the same human gate.
      let recipientMsisdn = msisdn;
      const recipientName = result.slots?.recipientName || null;
      if (!recipientMsisdn && recipientName) {
        const matches = await findBeneficiariesByName({ accountId: account.id, query: recipientName });
        if (matches.length === 1) {
          recipientMsisdn = matches[0].msisdn;
        } else if (matches.length > 1) {
          const listMsg =
            `I know more than one "${recipientName}":\n\n` +
            matches.map((b) => `• ${formatBeneficiary(b)}`).join('\n') +
            `\n\nPlease reply with the full number${amountCents ? '' : ' and amount, e.g. "send R50 to 0781234567"'}.`;
          if (amountCents) {
            await updateConversationState(from, 'VOUCHER_GIFT_RECIPIENT', { amountCents });
          }
          await addToConversationHistory(from, 'assistant', listMsg);
          return await sendWhatsAppText({ to: from, text: listMsg });
        }
        // No match: fall through — resolveGift asks for the number.
      }

      // Same resolution the keyword router uses — resolveGift owns the copy
      // and the flow it starts is preview -> YES -> PIN, identical to the
      // deterministic path.
      const gift = resolveGift({
        slots: { amountCents, msisdn: recipientMsisdn, productHint: 'SEND_MONEY' },
        senderMsisdn: account.msisdn,
      });
      if (gift.kind === 'VOUCHER_GIFT') {
        return await startVoucherGiftPreviewAndConfirm({
          from,
          account,
          amountCents: gift.amountCents,
          recipientMsisdn: gift.recipientMsisdn,
          intent: 'ORCHESTRATOR',
          rawText: text,
        });
      }
      if (gift.kind === 'NEEDS_AMOUNT' || gift.kind === 'NEEDS_RECIPIENT' || gift.kind === 'INVALID_RECIPIENT') {
        const nextState = gift.kind === 'NEEDS_AMOUNT' ? 'VOUCHER_GIFT_AMOUNT' : 'VOUCHER_GIFT_RECIPIENT';
        await updateConversationState(from, nextState, {
          amountCents: gift.amountCents || null,
          recipientMsisdn: gift.kind === 'NEEDS_AMOUNT' && recipientMsisdn ? recipientMsisdn : null,
        });
        await addToConversationHistory(from, 'assistant', gift.message);
        return await sendWhatsAppText({ to: from, text: gift.message });
      }
      // Any other kind: fall through to the agent's reply.
      break;
    }

    case 'REQUEST_MONEY':
      return await handleCreatePaymentRequest({ from, account, amountCents, rawText: text });

    case 'LIST_PRODUCTS':
      return await handleListAllProducts({ from, account });

    case 'LIST_CATEGORY': {
      const category = result.slots?.category;
      // Not-yet-live categories keep their coming-soon gate on the AI path
      // too — listing products nobody can buy is a dead-end.
      if (['LIFESTYLE', 'GAMING', 'BILLPAY'].includes(category) && !isCategoryLive(category)) {
        return await replyCategoryUnavailable(from, category);
      }
      if (category === 'ELECTRICITY') return await handleListElectricityProducts({ from, account });
      if (category === 'DATA') return await handleListDataBundles({ from, account, networkCode: null });
      if (category === 'AIRTIME') return await handleListAirtimeBundles({ from, account, networkCode: null });
      if (category === 'LIFESTYLE') return await handleListLifestyleProducts({ from, account });
      if (category === 'GAMING') return await handleListGamingProducts({ from, account });
      if (category === 'BILLPAY') return await handleListBillpayProducts({ from, account });
      return await handleListAllProducts({ from, account });
    }

    case 'HELP': {
      const helpMsg = `📋 *WaPay Help Menu*\n\nHere's what I can help you with:\n\n💰 *Balance* - "What's my balance?"\n📱 *Airtime* - "Buy R50 airtime"\n📶 *Data* - "Buy 1GB data"\n💡 *Electricity* - "Buy R100 electricity"\n💸 *Send money* - "Send R50 to 083..." — or just share a contact from your phone\n💳 *Deposit* - "Deposit R100"\n🎟️ *Voucher* - "Redeem voucher"\n\nJust ask me in your own words — any South African language works!`;
      const localizedHelp = await localizeOutbound(helpMsg, await userLang(account));
      await addToConversationHistory(from, 'assistant', localizedHelp);
      return await sendWhatsAppText({ to: from, text: localizedHelp });
    }

    case 'HOME':
      await updateConversationState(from, null);
      return await renderHome({ from, account });

    case 'NONE':
    default:
      break;
  }

  // Reply-only turns (and anything unmapped): the agent's own words, never
  // JSON — and never anything shaped like a transaction receipt.
  let finalText =
    reply ||
    'I can help you with balance checks, airtime, data, electricity, deposits and sending money. What would you like to do?';
  if (reply && looksLikeReceipt(reply)) {
    logStructured('orchestrator_reply_blocked', {
      from,
      reason: 'RECEIPT_SHAPED_REPLY',
      action: result.action,
    });
    finalText =
      `I can't confirm payments or balances in chat — but I can check your real transaction record. ` +
      `Ask me "did my payment go through?" or "balance" and I'll look it up.`;
  }
  await addToConversationHistory(from, 'assistant', finalText);
  return await sendWhatsAppText({ to: from, text: finalText });
}

// ==============================================================================
// SMART PRODUCT QUERY HANDLER - Database-driven category matching
// ==============================================================================

/**
 * Smart product query handler
 * 
 * Instead of hardcoding regex patterns for every product,
 * this function queries the database and matches user text
 * against actual categories, operators, and networks.
 * 
 * PRIORITY RULES:
 * 1. Strong category indicators (electricity + meter) always win
 * 2. Purchase intent (buy + amount + category) triggers purchase flow
 * 3. Only ask for clarification if truly ambiguous
 */
async function handleSmartProductQuery({ from, account, text, slots: incomingSlots, entities }) {
  const lowerText = text.toLowerCase();
  const entitiesBefore = entities || {};
  const slots = incomingSlots || parseSlots(text, { waId: from, accountId: account.id });
  
  logStructured('smart_product_query', {
    from,
    accountId: account.id,
    text,
  });

  logStructured('smart_query_slots', {
    from,
    accountId: account.id,
    entitiesBefore,
    slots: {
      amountCents: slots?.amountCents,
      msisdn: slots?.msisdn,
      meterNumber: slots?.meterNumber,
      productHint: slots?.productHint,
      retailer: slots?.retailer,
      dataMb: slots?.dataMb,
      periodType: slots?.periodType,
      networkCode: slots?.networkCode,
      confidence: slots?.confidence,
    },
    entitiesAfter: {
      ...entitiesBefore,
      ...(slots?.amountCents ? { amountCents: slots.amountCents } : {}),
      ...(slots?.msisdn ? { msisdn: slots.msisdn } : {}),
      ...(slots?.meterNumber ? { meterNumber: slots.meterNumber } : {}),
      ...(slots?.retailer ? { retailer: slots.retailer } : {}),
      ...(slots?.productHint ? { productHint: slots.productHint } : {}),
    },
  });

  try {
    // Deterministic short-circuit: if we have complete AIRTIME slots, never go to AIRTIME_MSISDN.
    if (slots?.productHint === 'AIRTIME' && slots.amountCents && slots.msisdn) {
      logSlotFill({
        intent: 'SMART_PRODUCT_QUERY',
        text,
        slots,
        routeDecision: 'AIRTIME_PREVIEW_CONFIRM',
        missing: [],
        from,
        accountId: account.id,
      });
      return await startAirtimePreviewAndConfirm({
        from,
        account,
        amountCents: slots.amountCents,
        msisdn: slots.msisdn,
        intent: 'SMART_PRODUCT_QUERY',
        rawText: text,
      });
    }

    // Deterministic electricity short-circuit
    if (slots?.productHint === 'ELECTRICITY' && slots.amountCents && slots.meterNumber) {
      logSlotFill({
        intent: 'SMART_PRODUCT_QUERY',
        text,
        slots,
        routeDecision: 'ELECTRICITY_METER',
        missing: ['preview'],
        from,
        accountId: account.id,
      });
      await updateConversationState(from, 'ELECTRICITY_METER', {
        amountCents: slots.amountCents,
      });
      const meterMsg = `💡 *Buy R${(slots.amountCents / 100).toFixed(0)} Electricity*\n\nPlease enter your meter number to continue.`;
      await addToConversationHistory(from, 'assistant', meterMsg);
      return await sendWhatsAppText({ to: from, text: meterMsg });
    }

    // =========================================================
    // PRIORITY 1: Strong category indicators ALWAYS WIN
    // No clarification needed for these
    // =========================================================
    
    // ELECTRICITY: meter, eskom, prepaid power, electricity, units
    const electricityIndicators = ['meter', 'eskom', 'prepaid power', 'electricity', 'elec', 'units', 'token'];
    const hasElectricityIntent = electricityIndicators.some(k => lowerText.includes(k));
    
    // If user clearly mentions electricity-related terms, it's electricity
    if (hasElectricityIntent) {
      // Check if they want to BUY (have amount) or just LIST
      const amountMatch = lowerText.match(/r\s?(\d+)/i);
      const meterMatch = lowerText.match(/\b(\d{10,14})\b/); // Meter numbers are typically 10-14 digits
      
      if (amountMatch || lowerText.includes('buy')) {
        // They want to BUY electricity
        const amount = amountMatch ? parseInt(amountMatch[1]) : null;
        const meterNumber = meterMatch ? meterMatch[1] : null;
        
        if (amount && meterNumber) {
          await updateConversationState(from, 'ELECTRICITY_METER', {
            amountCents: amount * 100,
          });
          const meterMsg = `💡 *Buy R${amount} Electricity*\n\nPlease enter your meter number to continue.`;
          await addToConversationHistory(from, 'assistant', meterMsg);
          return await sendWhatsAppText({
            to: from,
            text: meterMsg,
          });
        } else if (amount) {
          // Have amount, need meter
          await updateConversationState(from, 'ELECTRICITY_METER', {
            amountCents: amount * 100,
          });
          const meterMsg = `💡 *Buy R${amount} Electricity*\n\nPlease enter your meter number:`;
          await addToConversationHistory(from, 'assistant', meterMsg);
          return await sendWhatsAppText({
            to: from,
            text: meterMsg,
          });
        } else {
          // Need amount
          await updateConversationState(from, 'ELECTRICITY_AMOUNT', {
            meterNumber,
          });
          const amountMsg = `💡 *Buy Electricity*\n\nHow much electricity would you like to buy?\n\nReply with an amount (e.g., R50, R100, R500)\n(Min R10, Max R5000)`;
          await addToConversationHistory(from, 'assistant', amountMsg);
          return await sendWhatsAppText({
            to: from,
            text: amountMsg,
          });
        }
      }
      
      // Just listing electricity
      return await handleListElectricityProducts({ from, account });
    }
    
    // AIRTIME: explicit airtime mention
    const airtimeIndicators = ['airtime', 'phone credit', 'top up', 'topup', 'recharge'];
    const hasAirtimeIntent = airtimeIndicators.some(k => lowerText.includes(k));
    
    if (hasAirtimeIntent && !lowerText.includes('data') && !lowerText.includes('bundle')) {
      // Check if they want to BUY
      const amountMatch = lowerText.match(/r\s?(\d+)/i);
      
      if (amountMatch || lowerText.includes('buy')) {
        const amount = amountMatch ? parseInt(amountMatch[1]) : null;
        if (amount) {
          logSlotFill({
            intent: 'SMART_PRODUCT_QUERY',
            text,
            slots,
            routeDecision: 'AIRTIME_MSISDN',
            missing: ['msisdn'],
            from,
            accountId: account.id,
          });
          await updateConversationState(from, 'AIRTIME_MSISDN', { amountCents: amount * 100 });
          const msg = `📱 *Buy R${amount} Airtime*\n\nWhich phone number should I send the airtime to?\n\nReply with the number (e.g., 0781234567) or "me" for your own number.`;
          await addToConversationHistory(from, 'assistant', msg);
          return await sendWhatsAppText({ to: from, text: msg });
        }
        
        await updateConversationState(from, 'AIRTIME_AMOUNT', {});
        const msg = `📱 *Buy Airtime*\n\nHow much airtime would you like to buy?\n\nReply with an amount (e.g., R10, R50, R100)`;
        await addToConversationHistory(from, 'assistant', msg);
        return await sendWhatsAppText({ to: from, text: msg });
      }
      
      // Just listing airtime
      return await handleListAirtimeBundles({ from, account, networkCode: null });
    }
    
    // DATA: explicit data/bundle mention
    const dataIndicators = ['data', 'bundle', 'gig', 'gb', 'mb'];
    const hasDataIntent = dataIndicators.some(k => lowerText.includes(k));
    
    if (hasDataIntent) {
      // Extract network if mentioned
      let networkCode = null;
      if (/vodacom/i.test(lowerText)) networkCode = 'VODACOM';
      else if (/mtn/i.test(lowerText)) networkCode = 'MTN';
      else if (/cell\s?c|cellc/i.test(lowerText)) networkCode = 'CELLC';
      else if (/telkom/i.test(lowerText)) networkCode = 'TELKOM';

      // Extract period if mentioned (daily/weekly/monthly/night)
      let periodType = null;
      if (lowerText.includes('daily') || /\bday\b/i.test(lowerText)) periodType = 'DAILY';
      else if (lowerText.includes('weekly') || /\bweek\b/i.test(lowerText)) periodType = 'WEEKLY';
      else if (lowerText.includes('monthly') || /\bmonth\b/i.test(lowerText)) periodType = 'MONTHLY';
      else if (lowerText.includes('night')) periodType = 'NIGHT';
      
      return await handleListDataBundles({ from, account, entities: { networkCode, periodType } });
    }
    
    // GAMING: betting indicators
    const gamingIndicators = ['betting', 'hollywoodbets', 'lottostar', 'betway', 'supabets', 'gamble'];
    const hasGamingIntent = gamingIndicators.some(k => lowerText.includes(k));
    
    if (hasGamingIntent) {
      if (!isCategoryLive('GAMING')) {
        return await replyCategoryUnavailable(from, 'GAMING');
      }
      return await handleListGamingProducts({ from, account });
    }
    
    // LIFESTYLE: streaming/voucher indicators
    const lifestyleIndicators = ['netflix', 'uber', 'google play', 'steam', 'playstation', 'streaming'];
    const hasLifestyleIntent = lifestyleIndicators.some(k => lowerText.includes(k));
    
    if (hasLifestyleIntent) {
      if (!isCategoryLive('LIFESTYLE')) {
        return await replyCategoryUnavailable(from, 'LIFESTYLE');
      }
      return await handleListLifestyleProducts({ from, account });
    }
    
    // BILLPAY: TV/subscription indicators
    const billpayIndicators = ['dstv', 'gotv', 'multichoice', 'subscription'];
    const hasBillpayIntent = billpayIndicators.some(k => lowerText.includes(k));
    
    if (hasBillpayIntent) {
      if (!isCategoryLive('BILLPAY')) {
        return await replyCategoryUnavailable(from, 'BILLPAY');
      }
      return await handleListBillpayProducts({ from, account });
    }

    // =========================================================
    // PRIORITY 2: Database-driven matching for other queries
    // =========================================================
    
    // Get all active products grouped by category
    const categories = await prisma.vasProduct.groupBy({
      by: ['category'],
      where: { active: true },
      _count: { id: true },
    });
    
    // Get all operators/brands from database
    const operators = await prisma.vasProduct.findMany({
      where: { 
        active: true,
        operatorCode: { not: null },
      },
      select: { 
        operatorCode: true, 
        category: true,
        label: true,
      },
      distinct: ['operatorCode'],
    });
    
    // Get all networks
    const networks = await prisma.vasProduct.findMany({
      where: { 
        active: true,
        networkCode: { not: null },
      },
      select: { 
        networkCode: true, 
        category: true,
      },
      distinct: ['networkCode'],
    });

    // Build keyword map from database + common synonyms
    const categoryKeywords = {
      AIRTIME: ['airtime', 'recharge', 'top up', 'topup', 'top-up', 'phone credit'],
      DATA: ['data', 'bundle', 'bundles', 'mb', 'gb', 'gig', 'internet'],
      ELECTRICITY: ['electricity', 'prepaid', 'meter', 'token', 'units', 'power', 'elec', 'light', 'eskom'],
      // 'voucher'/'ott' are RESERVED for the money rail (Blu deposit voucher,
      // OTT money voucher) — mapping them here sent "can I buy an OTT
      // voucher?" to a Netflix menu (live sighting 2026-08-20). 'send money'
      // is WaPay's own feature, never REMITTANCE. Bare 'bet' substring-matched
      // inside 'better' — betting words must never surface in chat anyway.
      LIFESTYLE: ['gift card', 'streaming'],
      BILLPAY: ['subscription', 'dstv', 'gotv'],
      GAMING: ['gambling', 'casino'],
      REMITTANCE: ['remittance', 'mukuru', 'hello paisa'],
    };
    
    // Add operators to their category keywords
    for (const op of operators) {
      const cat = op.category;
      if (!categoryKeywords[cat]) categoryKeywords[cat] = [];
      categoryKeywords[cat].push(op.operatorCode.toLowerCase());
      const brandName = op.label.split(' ')[0].toLowerCase();
      if (!categoryKeywords[cat].includes(brandName)) {
        categoryKeywords[cat].push(brandName);
      }
    }
    
    // Add networks to their category keywords
    for (const net of networks) {
      const cat = net.category;
      if (!categoryKeywords[cat]) categoryKeywords[cat] = [];
      categoryKeywords[cat].push(net.networkCode.toLowerCase());
    }
    
    // Find matching categories
    const matches = [];
    for (const [category, keywords] of Object.entries(categoryKeywords)) {
      if (!categories.some(c => c.category === category)) continue;
      
      for (const keyword of keywords) {
        if (lowerText.includes(keyword)) {
          const existing = matches.find(m => m.category === category);
          if (!existing) {
            matches.push({ 
              category, 
              keyword, 
              confidence: keyword.length > 5 ? 0.9 : 0.7,
            });
          }
          break;
        }
      }
    }
    
    logStructured('smart_product_query_matches', {
      from,
      matches: matches.map(m => m.category),
      matchCount: matches.length,
    });

    // No matches - show all categories
    if (matches.length === 0) {
      return await handleListVasProducts({ from, account });
    }
    
    // Single match - show products for that category
    if (matches.length === 1) {
      const category = matches[0].category;
      return await showCategoryProducts({ from, account, category, text });
    }
    
    // Multiple matches - pick the highest confidence one instead of asking
    // This prevents confusing users with unnecessary questions
    matches.sort((a, b) => b.confidence - a.confidence);
    const bestMatch = matches[0];
    
    logStructured('smart_product_query_best_match', {
      from,
      bestMatch: bestMatch.category,
      allMatches: matches.map(m => ({ cat: m.category, conf: m.confidence })),
    });
    
    return await showCategoryProducts({ from, account, category: bestMatch.category, text });

  } catch (error) {
    console.error('Smart product query error:', error);
    logStructured('smart_product_query_error', {
      from,
      error: error.message,
    });
    
    // Fall back to listing all products
    return await handleListVasProducts({ from, account });
  }
}

/**
 * Show products for a specific category
 */
async function showCategoryProducts({ from, account, category, text }) {
  // Coming-soon categories never render a product menu — every route into
  // this function (keyword map, operator names) inherits the gate.
  if (!isCategoryLive(category)) {
    return await replyCategoryUnavailable(from, category);
  }
  const lowerText = text?.toLowerCase() || '';
  
  logStructured('show_category_products', {
    from,
    accountId: account.id,
    category,
  });

  try {
    // Build query
    const where = {
      category,
      active: true,
    };
    
    // Extract network if mentioned (for AIRTIME/DATA)
    let networkCode = null;
    if (category === 'AIRTIME' || category === 'DATA') {
      if (/vodacom/i.test(lowerText)) networkCode = 'VODACOM';
      else if (/mtn/i.test(lowerText)) networkCode = 'MTN';
      else if (/cell\s?c|cellc/i.test(lowerText)) networkCode = 'CELLC';
      else if (/telkom/i.test(lowerText)) networkCode = 'TELKOM';
      
      if (networkCode) where.networkCode = networkCode;
    }

    // Get products
    const products = await prisma.vasProduct.findMany({
      where,
      orderBy: [
        { popularity: 'desc' },
        { fixedPriceCents: 'asc' },
      ],
      take: 15,
    });
    
    if (products.length === 0) {
      return await sendWhatsAppText({
        to: from,
        text: `😕 I couldn't find any ${category.toLowerCase()} products right now.\n\nPlease try again later or ask "what can I buy?" to see all options.`,
      });
    }

    // Format based on category
    const categoryConfig = {
      AIRTIME: {
        emoji: '📱',
        title: 'Mobile Airtime',
        formatProduct: (p) => `R${(p.fixedPriceCents || p.priceCents) / 100} ${p.networkCode || ''} Airtime`,
        helpText: 'Reply: *"Buy R50 airtime for 0821234567"*',
      },
      DATA: {
        emoji: '📶',
        title: networkCode ? `${networkCode} Data Bundles` : 'Data Bundles',
        formatProduct: (p) => {
          const sizeMb = p.dataMb;
          const size = sizeMb >= 1024 ? `${(sizeMb / 1024).toFixed(sizeMb % 1024 === 0 ? 0 : 1)}GB` : `${sizeMb}MB`;
          const price = ((p.fixedPriceCents || p.priceCents) / 100).toFixed(0);
          const period = p.periodType ? ` (${p.periodType.toLowerCase()})` : '';
          return `${size}${period} – R${price}`;
        },
        helpText: 'Reply: *"Buy 1GB data for 0821234567"*',
      },
      ELECTRICITY: {
        emoji: '💡',
        title: 'Prepaid Electricity',
        formatProduct: (p) => {
          const range = p.minCents && p.maxCents ? `R${p.minCents/100} - R${p.maxCents/100}` : 'Variable';
          return `${p.label.split(' ')[0]} – ${range}`;
        },
        helpText: 'Reply: *"Buy R100 electricity for [meter number]"*',
      },
      LIFESTYLE: {
        emoji: '🎮',
        title: 'Entertainment Vouchers',
        formatProduct: (p) => {
          const price = ((p.fixedPriceCents || p.priceCents) / 100).toFixed(0);
          return `${p.label.split(' ')[0]} R${price}`;
        },
        helpText: 'Reply: *"Buy R100 Netflix voucher"*',
      },
      BILLPAY: {
        emoji: '📺',
        title: 'Bill Payments',
        formatProduct: (p) => {
          const price = p.fixedPriceCents ? `R${p.fixedPriceCents/100}` : 'Variable';
          return `${p.label} – ${price}`;
        },
        helpText: 'Reply: *"Pay my DStv"*',
      },
      GAMING: {
        emoji: '🎮',
        title: 'Gaming Top-ups',
        formatProduct: (p) => {
          const price = ((p.fixedPriceCents || p.priceCents) / 100).toFixed(0);
          return `${p.label.split(' ')[0]} R${price}`;
        },
        helpText: 'Reply with the operator and amount to top up.',
      },
      REMITTANCE: {
        emoji: '💸',
        title: 'Money Transfers',
        formatProduct: (p) => {
          const range = p.minCents && p.maxCents ? `R${p.minCents/100} - R${p.maxCents/100}` : 'Variable';
          return `${p.label.split(' ')[0]} – ${range}`;
        },
        helpText: 'Reply: *"Send R500 via Mukuru"*',
      },
    };

    const config = categoryConfig[category] || {
      emoji: '🛒',
      title: category,
      formatProduct: (p) => p.label,
      helpText: 'Tell me what you need!',
    };

    let message = `${config.emoji} *${config.title}*\n\n`;
    
    // Group by operator/network if applicable
    const grouped = {};
    for (const p of products) {
      const key = p.operatorCode || p.networkCode || 'default';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(p);
    }
    
    if (Object.keys(grouped).length > 1) {
      for (const [key, items] of Object.entries(grouped)) {
        if (key !== 'default') message += `*${key}*\n`;
        for (const p of items.slice(0, 5)) {
          message += `• ${config.formatProduct(p)}\n`;
        }
        message += '\n';
      }
    } else {
      for (const p of products.slice(0, 10)) {
        message += `• ${config.formatProduct(p)}\n`;
      }
      message += '\n';
    }
    
    message += `━━━━━━━━━━━━━━━━━━\n${config.helpText}`;

    return await sendWhatsAppText({
      to: from,
      text: message,
    });

  } catch (error) {
    console.error('Show category products error:', error);
    return await sendWhatsAppText({
      to: from,
      text: `❌ Sorry, I couldn't load the products. Please try again.`,
    });
  }
}

// ==============================================================================
// CATALOGUE HANDLERS - Return real data from VasProduct catalogue
// ==============================================================================

/**
 * Handle listing airtime options
 */
async function handleListAirtimeBundles({ from, account, networkCode }) {
  logStructured('vas_airtime_fetch_call', {
    from,
    accountId: account.id,
    intent: 'LIST_AIRTIME',
    networkCode,
  });

  try {
    // Build query
    const where = {
      category: 'AIRTIME',
      active: true,
    };
    
    if (networkCode) {
      where.networkCode = networkCode;
    }

    const products = await prisma.vasProduct.findMany({
      where,
      orderBy: [
        { networkCode: 'asc' },
        { fixedPriceCents: 'asc' },
      ],
      take: 20,
    });

    if (products.length === 0) {
      // No products in DB - show generic airtime info
      let message = `📱 *Airtime*\n\nYou can buy airtime for any SA network:\n\n`;
      message += `• Vodacom\n• MTN\n• Cell C\n• Telkom\n\n`;
      message += `Amount: R5 - R1000\n\n`;
      message += `Reply: *"Buy R50 airtime for 0821234567"* and I'll help you!`;
      
      await setActiveCategory(from, 'AIRTIME', ['VODACOM', 'MTN', 'CELLC', 'TELKOM']);
      
      return await sendWhatsAppText({
        to: from,
        text: message,
      });
    }

    // Group by network
    const byNetwork = {};
    for (const p of products) {
      const net = p.networkCode || 'OTHER';
      if (!byNetwork[net]) byNetwork[net] = [];
      byNetwork[net].push(p);
    }

    const networkDisplay = networkCode ? `${networkCode} ` : '';
    let message = `📱 *${networkDisplay}Airtime Options*\n\n`;
    
    for (const [network, networkProducts] of Object.entries(byNetwork)) {
      message += `*${network}*\n`;
      message += `   R5 - R1000 (any amount)\n\n`;
    }
    
    message += `Reply: *"Buy R50 airtime for 0821234567"* and I'll help you purchase!`;

    // Set active category so follow-up messages are interpreted correctly
    await setActiveCategory(from, 'AIRTIME', Object.keys(byNetwork));
    
    return await sendWhatsAppText({
      to: from,
      text: message,
    });

  } catch (error) {
    console.error('List airtime error:', error);
    return await sendWhatsAppText({
      to: from,
      text: `❌ Sorry, I couldn't fetch the airtime options right now. Please try again later.`,
    });
  }
}

/**
 * Handle listing data bundles from the catalogue
 */
async function handleListDataBundles({ from, account, entities }) {
  const { networkCode, periodType, networkConfidence } = entities || {};
  
  logStructured('vas_bundles_fetch_call', {
    from,
    accountId: account.id,
    intent: 'LIST_DATA_BUNDLES',
    networkCode,
    periodType,
    networkConfidence,
  });

  if (!isCategoryLive('DATA')) {
    return await replyCategoryUnavailable(from, 'DATA');
  }

  if (networkConfidence && networkConfidence < 0.7) {
    return await sendWhatsAppText({
      to: from,
      text: `Did you mean *Vodacom, MTN, Cell C, or Telkom*?`,
    });
  }

  try {
    const bundles = await searchProducts({
      category: 'DATA',
      networkCode,
      periodType: periodType ? periodType.toUpperCase() : undefined,
      limit: 40,
    });

    logStructured('vas_bundles_fetch_result', {
      from,
      intent: 'LIST_DATA_BUNDLES',
      networkCode,
      periodType,
      count: bundles.length,
      success: true,
    });

    if (!bundles || bundles.length === 0) {
      return await sendWhatsAppText({
        to: from,
        text: `📶 I couldn't find any ${networkCode || ''} ${periodType?.toLowerCase() || ''} bundles in our catalogue.\n\nTry asking for a different network (Vodacom, MTN, Cell C, Telkom) or period (daily, weekly, monthly).`,
      });
    }

    const generic = [];
    const appBundles = [];
    for (const b of bundles) {
      const normalized = b.metadata?.normalized || {};
      if (normalized.appTags?.length) {
        appBundles.push(b);
      } else {
        generic.push(b);
      }
    }

    const networkDisplay = networkCode ? `${networkCode}` : 'All Networks';
    const periodDisplay = periodType ? ` ${periodType.charAt(0) + periodType.slice(1).toLowerCase()}` : '';

    let message = `📶 *${networkDisplay}${periodDisplay} Data Bundles*\n`;
    message += `I’ll show a few great options (no long lists).\n\n`;

    const fmt = (p) => {
      const sizeMb = p.dataMb || p.metadata?.normalized?.dataMb;
      const sizeLabel = sizeMb >= 1024
        ? `${(sizeMb / 1024).toFixed(sizeMb % 1024 === 0 ? 0 : 1)}GB`
        : `${sizeMb || '?'}MB`;
      const price = ((p.fixedPriceCents || p.priceCents) / 100).toFixed(0);
      return `• ${sizeLabel} – R${price}`;
    };

    if (generic.length) {
      message += `*Top generic data*\n`;
      generic.slice(0, 5).forEach((p) => { message += `${fmt(p)}\n`; });
      message += '\n';
    }

    if (appBundles.length) {
      message += `*App bundles that can save money*\n`;
      appBundles.slice(0, 5).forEach((p) => {
        const apps = (p.metadata?.normalized?.appTags || []).join(', ');
        message += `${fmt(p)} (${apps})\n`;
      });
      message += '\n';
    }

    message += `Reply like: *"Buy 1GB data for 0821234567"* and I'll help you purchase.`;

    await setActiveCategory(from, 'DATA', bundles.map((b) => b.label).slice(0, 5));

    return await sendWhatsAppText({
      to: from,
      text: message,
    });

  } catch (error) {
    console.error('List data bundles error:', error);
    logStructured('vas_bundles_fetch_result', {
      from,
      intent: 'LIST_DATA_BUNDLES',
      success: false,
      error: error.message,
    });
    
    return await sendWhatsAppText({
      to: from,
      text: `❌ Sorry, I couldn't fetch the bundle list right now. Please try again later.`,
    });
  }
}

async function handleDataPurchaseFromSlots({ from, account, slots }) {
  const { msisdn, dataMb } = slots;
  const networkCode = slots.networkCode || detectNetworkCodeFromMsisdn(msisdn || '');
  const periodType = slots.periodType || null;

  // Find best matching product in catalogue
  const product = await prisma.vasProduct.findFirst({
    where: {
      active: true,
      category: 'DATA',
      networkCode,
      ...(periodType ? { periodType } : {}),
      dataMb,
    },
    orderBy: [
      { popularity: 'desc' },
      { fixedPriceCents: 'asc' },
      { priceCents: 'asc' },
    ],
  });

  if (!product) {
    return await sendWhatsAppText({
      to: from,
      text:
        `❌ I couldn't find a ${networkCode || 'matching'} ${periodType ? periodType.toLowerCase() + ' ' : ''}${dataMb >= 1024 ? `${(dataMb / 1024).toFixed(0)}GB` : `${dataMb}MB`} bundle in our catalogue.\n\n` +
        `Try a different size, or ask: "Show me ${networkCode || ''} bundles".`,
    });
  }

  const priceCents = product.fixedPriceCents || product.priceCents || 0;
  const sizeLabel = dataMb >= 1024 ? `${(dataMb / 1024).toFixed(0)}GB` : `${dataMb}MB`;
  const resolvedPeriod = product.periodType || periodType || 'ONCE_OFF';
  const vendorLabel = networkCode === 'CELLC' ? 'Cell C' : networkCode.charAt(0) + networkCode.slice(1).toLowerCase();

  await updateConversationState(from, 'DATA_CONFIRM', {
    msisdn,
    productId: product.externalCode,
    productName: product.label,
    vendorId: networkCode.toLowerCase(),
    vendorName: vendorLabel,
    amountCents: priceCents,
  });

  return await sendWhatsAppText({
    to: from,
    text:
      `📶 *Confirm Data Purchase*\n\n` +
      `Bundle: ${sizeLabel} ${String(resolvedPeriod).toLowerCase()}\n` +
      `Number: ${msisdn} (${vendorLabel})\n` +
      `Amount: R${(priceCents / 100).toFixed(2)}\n\n` +
      `Reply *YES* to confirm or *NO* to cancel.`,
  });
}

/**
 * Handle listing electricity products
 */
async function handleListElectricityProducts({ from, account }) {
  logStructured('vas_electricity_fetch_call', {
    from,
    accountId: account.id,
    intent: 'LIST_ELECTRICITY',
  });

  if (!isCategoryLive('ELECTRICITY')) {
    return await replyCategoryUnavailable(from, 'ELECTRICITY');
  }

  try {
    const products = await prisma.vasProduct.findMany({
      where: {
        category: 'ELECTRICITY',
        active: true,
      },
      orderBy: [
        { popularity: 'desc' },
        { label: 'asc' },
      ],
      take: 20,
    });

    logStructured('vas_electricity_fetch_result', {
      from,
      intent: 'LIST_ELECTRICITY',
      count: products.length,
      success: true,
    });

    if (products.length === 0) {
      return await sendWhatsAppText({
        to: from,
        text: `💡 I couldn't find any electricity providers in our catalogue right now.\n\nPlease try again later or contact support.`,
      });
    }

    // Group by operator
    const byOperator = {};
    for (const p of products) {
      const op = p.operatorCode || p.networkCode || 'OTHER';
      if (!byOperator[op]) byOperator[op] = [];
      byOperator[op].push(p);
    }

    let message = `💡 *Prepaid Electricity Providers*\n\nWe support the following electricity meters:\n\n`;
    
    for (const [operator, operatorProducts] of Object.entries(byOperator)) {
      const first = operatorProducts[0];
      const operatorName = first.label.split(' ')[0] || operator; // "Eskom Prepaid Electricity" -> "Eskom"
      message += `*${operatorName}*\n`;
      message += `   Variable amount (R${(first.minCents || 1000) / 100} - R${(first.maxCents || 500000) / 100})\n\n`;
    }
    
    message += `━━━━━━━━━━━━━━━━━━\n\n`;
    message += `*How to buy:*\n`;
    message += `Reply: *"Buy R50 electricity for [meter number]"*\n\n`;
    message += `I'll help you purchase electricity tokens! ⚡`;

    // Set active category so follow-up messages are interpreted correctly
    await setActiveCategory(from, 'ELECTRICITY', Object.keys(byOperator));
    
    return await sendWhatsAppText({
      to: from,
      text: message,
    });

  } catch (error) {
    console.error('List electricity error:', error);
    logStructured('vas_electricity_fetch_result', {
      from,
      intent: 'LIST_ELECTRICITY',
      success: false,
      error: error.message,
    });
    
    return await sendWhatsAppText({
      to: from,
      text: `❌ Sorry, I couldn't fetch the electricity providers right now. Please try again later.`,
    });
  }
}

/**
 * Handle listing lifestyle/OTT products
 */
async function handleListLifestyleProducts({ from, account }) {
  logStructured('vas_lifestyle_fetch_call', {
    from,
    accountId: account.id,
    intent: 'LIST_LIFESTYLE',
  });

  try {
    const products = await prisma.vasProduct.findMany({
      where: {
        category: 'LIFESTYLE',
        active: true,
      },
      orderBy: [
        { popularity: 'desc' },
        { fixedPriceCents: 'asc' },
      ],
      take: 20,
    });

    if (products.length === 0) {
      return await sendWhatsAppText({
        to: from,
        text: `🎮 I couldn't find any lifestyle vouchers in our catalogue right now.\n\nPlease try again later.`,
      });
    }

    // Group by operator
    const byOperator = {};
    for (const p of products) {
      const op = p.operatorCode || p.networkCode || 'OTHER';
      if (!byOperator[op]) byOperator[op] = [];
      byOperator[op].push(p);
    }

    let message = `🎮 *Entertainment Vouchers*\n\nAvailable vouchers:\n\n`;
    
    for (const [operator, operatorProducts] of Object.entries(byOperator)) {
      const first = operatorProducts[0];
      const operatorName = first.label.split(' ')[0] || operator;
      message += `*${operatorName}*\n`;
      for (const p of operatorProducts.slice(0, 3)) {
        const price = ((p.fixedPriceCents || p.priceCents) / 100).toFixed(0);
        message += `   R${price} voucher\n`;
      }
      message += '\n';
    }
    
    message += `Reply: *"Buy R50 Netflix voucher"* and I'll help you purchase.`;

    // Set active category so follow-up messages are interpreted correctly
    await setActiveCategory(from, 'LIFESTYLE', Object.keys(byOperator));
    
    return await sendWhatsAppText({
      to: from,
      text: message,
    });

  } catch (error) {
    console.error('List lifestyle error:', error);
    return await sendWhatsAppText({
      to: from,
      text: `❌ Sorry, I couldn't fetch the lifestyle vouchers right now. Please try again later.`,
    });
  }
}

/**
 * Handle listing billpay products
 */
async function handleListBillpayProducts({ from, account }) {
  logStructured('vas_billpay_fetch_call', {
    from,
    accountId: account.id,
    intent: 'LIST_BILLPAY',
  });

  try {
    const products = await prisma.vasProduct.findMany({
      where: {
        category: 'BILLPAY',
        active: true,
      },
      orderBy: [
        { popularity: 'desc' },
        { fixedPriceCents: 'asc' },
      ],
      take: 20,
    });

    if (products.length === 0) {
      return await sendWhatsAppText({
        to: from,
        text: `📺 I couldn't find any bill payment services in our catalogue right now.\n\nPlease try again later.`,
      });
    }

    let message = `📺 *Bill Payment Services*\n\nAvailable services:\n\n`;
    
    for (const p of products) {
      const price = p.fixedPriceCents ? `R${(p.fixedPriceCents / 100).toFixed(0)}` : 'Variable amount';
      message += `• ${p.label} – ${price}\n`;
    }
    
    message += `\nReply: *"Pay my DStv"* or *"Buy DStv Compact"* and I'll help you.`;

    return await sendWhatsAppText({
      to: from,
      text: message,
    });

  } catch (error) {
    console.error('List billpay error:', error);
    return await sendWhatsAppText({
      to: from,
      text: `❌ Sorry, I couldn't fetch the bill payment services right now. Please try again later.`,
    });
  }
}

/**
 * Handle listing gaming/betting products
 */
async function handleListGamingProducts({ from, account }) {
  logStructured('vas_gaming_fetch_call', {
    from,
    accountId: account.id,
    intent: 'LIST_GAMING',
  });

  try {
    const products = await prisma.vasProduct.findMany({
      where: {
        category: 'GAMING',
        active: true,
      },
      orderBy: [
        { popularity: 'desc' },
        { fixedPriceCents: 'asc' },
      ],
      take: 20,
    });

    if (products.length === 0) {
      return await sendWhatsAppText({
        to: from,
        text: `🎮 I couldn't find any gaming operators in our catalogue right now.\n\nPlease try again later.`,
      });
    }

    // Group by operator
    const byOperator = {};
    for (const p of products) {
      const op = p.operatorCode || p.networkCode || 'OTHER';
      if (!byOperator[op]) byOperator[op] = [];
      byOperator[op].push(p);
    }

    let message = `🎮 *Gaming Top-ups*\n\nAvailable operators:\n\n`;
    
    for (const [operator, operatorProducts] of Object.entries(byOperator)) {
      const first = operatorProducts[0];
      const operatorName = first.label.split(' ')[0] || operator;
      message += `*${operatorName}*\n`;
      for (const p of operatorProducts.slice(0, 3)) {
        const price = ((p.fixedPriceCents || p.priceCents) / 100).toFixed(0);
        message += `   R${price} top-up\n`;
      }
      message += '\n';
    }
    
    message += `Reply with the operator and amount to top up.`;

    // Set active category so follow-up messages are interpreted correctly
    await setActiveCategory(from, 'GAMING', Object.keys(byOperator));
    
    return await sendWhatsAppText({
      to: from,
      text: message,
    });

  } catch (error) {
    console.error('List gaming error:', error);
    return await sendWhatsAppText({
      to: from,
      text: `❌ Sorry, I couldn't fetch the gaming operators right now. Please try again later.`,
    });
  }
}

/**
 * Handle listing remittance products
 */
async function handleListRemittanceProducts({ from, account }) {
  logStructured('vas_remittance_fetch_call', {
    from,
    accountId: account.id,
    intent: 'LIST_REMITTANCE',
  });

  try {
    const products = await prisma.vasProduct.findMany({
      where: {
        category: 'REMITTANCE',
        active: true,
      },
      orderBy: [
        { popularity: 'desc' },
        { label: 'asc' },
      ],
      take: 20,
    });

    if (products.length === 0) {
      return await sendWhatsAppText({
        to: from,
        text: `💸 I couldn't find any money transfer services in our catalogue right now.\n\nPlease try again later.`,
      });
    }

    let message = `💸 *Money Transfer Services*\n\nAvailable services:\n\n`;
    
    for (const p of products) {
      const range = p.minCents && p.maxCents 
        ? `R${(p.minCents / 100).toFixed(0)} - R${(p.maxCents / 100).toFixed(0)}`
        : 'Variable amount';
      message += `• ${p.label} – ${range}\n`;
    }
    
    message += `\nReply: *"Send R500 via Mukuru"* and I'll help you transfer money.`;

    return await sendWhatsAppText({
      to: from,
      text: message,
    });

  } catch (error) {
    console.error('List remittance error:', error);
    return await sendWhatsAppText({
      to: from,
      text: `❌ Sorry, I couldn't fetch the money transfer services right now. Please try again later.`,
    });
  }
}

/**
 * Handle listing top VAS products
 */
async function handleListVasProducts({ from, account }) {
  logStructured('vas_list_vas_products', {
    from,
    accountId: account.id,
    intent: 'LIST_VAS_PRODUCTS',
  });

  try {
    // Get category counts
    const categoryCounts = await prisma.vasProduct.groupBy({
      by: ['category'],
      where: { active: true },
      _count: { id: true },
    });

    if (categoryCounts.length === 0) {
      return await sendWhatsAppText({
        to: from,
        text: `🚧 I couldn't find any VAS products in our catalogue right now.`,
      });
    }

    // Build friendly category list — LIVE categories only. Off categories
    // are not advertised at all (and betting words never appear in chat).
    const categoryNames = {
      AIRTIME: { name: '📱 Mobile Airtime', desc: 'Vodacom, MTN, Cell C, Telkom' },
      DATA: { name: '📶 Data Bundles', desc: 'Daily, Weekly, Monthly bundles' },
      ELECTRICITY: { name: '💡 Prepaid Electricity', desc: 'Eskom, City Power, and more' },
    };

    let message = `🛒 *WaPay VAS Products*\n\nHere's what you can buy on WaPay:\n\n`;
    
    for (const cat of categoryCounts) {
      if (!isCategoryLive(cat.category)) continue;
      const info = categoryNames[cat.category];
      if (info) {
        message += `${info.name}\n   _${info.desc}_\n\n`;
      }
    }
    
    message += `━━━━━━━━━━━━━━━━━━\n\n`;
    message += `*How to use:*\n`;
    message += `• "Show me Vodacom bundles"\n`;
    message += `• "Buy R50 airtime"\n`;
    message += `• "Weekly MTN bundles"\n`;
    message += `• "Redeem voucher"\n\n`;
    message += `Just tell me what you need! 🎉`;

    logStructured('vas_list_vas_products_result', {
      from,
      categoryCount: categoryCounts.length,
      success: true,
    });

    return await sendWhatsAppText({
      to: from,
      text: message,
    });

  } catch (error) {
    console.error('List VAS products error:', error);
    logStructured('vas_list_vas_products_result', {
      from,
      success: false,
      error: error.message,
    });
    
    return await sendWhatsAppText({
      to: from,
      text: `❌ Sorry, I couldn't fetch the product list right now. Please try again later.`,
    });
  }
}

// Legacy alias to ensure AI fallbacks route to catalogue-backed list
async function handleListAllProducts({ from, account }) {
  return await handleListVasProducts({ from, account });
}

/**
 * Handle voucher redemption
 */
async function handleVoucherRedemption({ from, pin, account }) {
  console.log('🎟️ Processing voucher redemption:', { from, pin: '***' });

  // Send "processing" message
  await sendWhatsAppText({
    to: from,
    text: `⏳ *Processing Voucher*\n\nPlease wait while we redeem your voucher...`,
  });

  const bluClient = new BluClient();
  try {
    // The idemKey is derived from the voucher PIN itself: a voucher is a
    // bearer instrument, so the same PIN must never be credited twice —
    // not on a webhook retry, and not to a different account either.
    const pinHash = crypto.createHash('sha256').update(String(pin)).digest('hex');
    // 'x' every 8 hex chars: a 13-digit run in the hash prefix trips the
    // ledger's timestamp guard (~1 in 481 vouchers) AFTER Blu consumed
    // the voucher — stranding the customer's cash (QA 2026-08-21).
    const idemKey = `wapay-redeem-${pinHash.slice(0, 32).replace(/(.{8})/g, '$1x')}`;

    // Check voucher status first to get amount and validate state
    let statusInfo;
    try {
      statusInfo = await bluClient.checkStatus(pin);
      console.log('🔎 Voucher status check', { from, status: statusInfo });
      
      if (statusInfo.status === 'USED') {
        await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
        return await sendWhatsAppText({
          to: from,
          text: `❌ *Voucher Already Used*\n\nThis voucher has already been redeemed. Please try another PIN.`,
        });
      }
      
      if (statusInfo.status === 'EXPIRED') {
        await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
        return await sendWhatsAppText({
          to: from,
          text: `❌ *Voucher Expired*\n\nThis voucher has expired. Please try another PIN.`,
        });
      }
      
      if (!statusInfo.amount_cents) {
        await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
        return await sendWhatsAppText({
          to: from,
          text: `❌ *Voucher Amount Unknown*\n\nCould not determine voucher value. Please verify the PIN and try again.`,
        });
      }
    } catch (statusError) {
      console.error('⚠️ Status check failed', statusError);
      await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
      return await sendWhatsAppText({
        to: from,
        text: `❌ *Status Check Failed*\n\nCould not verify voucher. Please try again in a moment.`,
      });
    }

    const amountCents = statusInfo.amount_cents;
    console.log('💰 Calling Blu API to redeem voucher', { amountCents });
    const result = await bluClient.redeem(pin, idemKey, amountCents);

    console.log('✅ Voucher redeemed successfully:', {
      providerRef: result.providerRef,
      amountCents: result.amount_cents
    });

    // Post to ledger. buildLoad applies the locked NET credit policy
    // (FEES.load.BLU): the customer is credited face value minus the rail's
    // discount, so the books can never go negative on a load. postEntry is
    // idempotent on idemKey — a replayed redemption returns the original
    // entry instead of crediting twice.
    console.log('📖 Posting to ledger');
    await ensureWallet({ accountId: account.id });
    const loadEntry = buildLoad({
      accountId: account.id,
      rail: RAIL.BLU,
      faceCents: result.amount_cents,
      idemKey,
    });
    loadEntry.externalRef = result.providerRef;
    const { journalEntryId, replayed } = await postEntry(loadEntry);
    const creditedCents = loadEntry.meta.creditCents;

    console.log('✅ Ledger posted:', journalEntryId, replayed ? '(replayed)' : '');

    // Get updated balance
    const { balance, displayName } = await getUserBalance(from);

    // Clear conversation state
    await updateConversationState(from, null);

    // Format amounts: show the voucher's face value and what actually landed.
    const faceRands = (result.amount_cents / 100).toFixed(2);
    const creditedRands = (creditedCents / 100).toFixed(2);

    // Memory: this customer loads with cash vouchers.
    noteDepositMethod({ accountId: account.id, method: 'VOUCHER' }).catch(() => {});

    // Send success message
    await sendWhatsAppText({
      to: from,
      text: `✅ *Voucher Redeemed Successfully!*\n\n🎟️ Voucher value: R ${faceRands}\n💰 Added to your wallet: R ${creditedRands}\n📈 New Balance: R ${balance}\n📝 Reference: ${result.providerRef}\n\nWhat would you like to do next?\n• Check balance\n• Buy airtime\n• Buy data\n\nReply with your choice!`,
    });

    return { ok: true };

  } catch (error) {
    console.error('❌ Voucher redemption error:', error);
    
    // Use userMessage if provided by BluClient (better error mapping)
    const userMessage = error.userMessage;
    const reasonRaw = (error.reason || '').toString().trim();
    const sanitizedReason =
      reasonRaw && !['USER_INPUT', 'AUTH', 'RETRYABLE', 'Error'].includes(reasonRaw) && reasonRaw.toLowerCase() !== 'no message available'
        ? reasonRaw
        : '';

    // Determine error type and message
    let errorMessage = userMessage || 'Sorry, we could not process your voucher. Please try again later.';
    const errorType = error.message;
    const allowRetry = errorType === 'USER_INPUT' || errorType === 'RETRYABLE';

    // Map Blu error messages to user-friendly text (if no userMessage from client)
    if (!userMessage) {
    if (errorType === 'USER_INPUT') {
      if (sanitizedReason) {
        errorMessage = sanitizedReason;
      } else {
        errorMessage = 'Blu could not redeem that voucher PIN. The voucher may be invalid, already used, or expired. Please verify the digits and try another voucher if needed.';
      }
    } else if (errorType === 'AUTH') {
        errorMessage = 'We couldn\'t complete your voucher redemption due to a provider configuration error. Please try again later or contact support.';
    } else if (errorType === 'RETRYABLE') {
      errorMessage = sanitizedReason || 'The voucher service is temporarily unavailable. Please try again in a few minutes.';
    } else if (sanitizedReason) {
      errorMessage = sanitizedReason;
      }
    }

    // Keep user in voucher flow if retry makes sense (but NOT for AUTH errors)
    await updateConversationState(from, allowRetry ? 'AWAITING_VOUCHER_PIN' : null);

    const retryHint = allowRetry
      ? `\n\nDouble-check the 16-digit PIN and enter it again when you're ready. Reply "cancel" to stop.`
      : `\n\nNeed help? Type "help" for options or try again later.`;

    await sendWhatsAppText({
      to: from,
      text: `❌ *Voucher Redemption Failed*\n\n${errorMessage}${retryHint}`,
    });

    return { ok: false, error: errorType || error.message };
  }
}
