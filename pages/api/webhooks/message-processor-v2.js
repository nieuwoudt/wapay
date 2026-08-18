/**
 * WhatsApp Message Processor V2
 * 
 * Integrates onboarding state machine with message routing.
 * Includes structured logging for debugging VAS flows.
 */

import { getOrCreateUser, getUserBalance, updateConversationState, getConversationState, addToConversationHistory, getConversationHistory, setActiveCategory, getActiveCategory, clearActiveCategory, wasMessageProcessed, markMessageProcessed, wasErrorSent, markErrorSent } from './user-manager.js';
import { sendWhatsAppText, sendWhatsAppTemplate } from '@wapay/whatsapp';
import prisma from '../../../lib/prisma.js';
import { resolveGift, buildRecipientNotification, buildVoucherClaimMessage, maskMsisdn } from '../../../lib/gifting.js';
import { hasPendingGifts, claimPendingGifts } from '../../../lib/pending-gifts.js';
import crypto from 'crypto';
import { BluClient, BluVasClient } from '@wapay/providers-blu';
import { buildLoad, RAIL } from '../../../lib/ledger-core.js';
import { postEntry, ensureWallet } from '../../../lib/ledger-post.js';
import { chatWithAI } from '@wapay/ai';
import { isValidSaMsisdn, normaliseMsisdn } from '../../../lib/msisdn.js';
import { getCategoryDisplayName, getLiveCategories, isCategoryLive, isCategoryEnabledForWaId } from '../../../lib/vas-config.js';
import { apiUrl, internalJsonHeaders } from '../../../lib/api-url.js';
import { parseSlots } from '../../../lib/slot-parser.js';
import { sendTextOnce } from '../../../lib/error-guard.js';
import { searchProducts } from '../../../lib/vas-search.js';
import {
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

  const confirmMsg =
    `🎁 *Confirm WaPay Voucher*\n\n` +
    `Voucher: ${randsShort(amountCents)}\n` +
    `Fee: ${randsShort(feeCents)}\n` +
    `Total: ${randsShort(totalCents)}\n` +
    `To: ${maskMsisdn(normalisedRecipient)}\n\n` +
    `They'll get a WaPay voucher they can spend online or take to their bank.\n\n` +
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

async function renderHome({ from, account }) {
  const { balance, displayName } = await getUserBalance(from);

  const msg1 = `👋 Hi ${displayName}!\n\n💰 Balance: ${formatMoneyZar(balance)}`;
  const msg2 =
    `What would you like to do today?\n\n` +
    `🛒 Buy\n` +
    `• Airtime\n` +
    `• Data\n` +
    `• Electricity\n` +
    `• Vouchers\n\n` +
    `💸 Send money\n` +
    `🏪 Pay a merchant\n` +
    `📄 View transactions\n` +
    `⚙️ Settings`;

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

  const msg3 =
    `⚡ Quick actions:\n` +
    `• ${quickActions[0]}\n` +
    `• ${quickActions[1]}\n` +
    `• ${quickActions[2]}`;

  logStructured('home_render', { from, accountId: account.id });

  await addToConversationHistory(from, 'assistant', msg1);
  await sendWhatsAppText({ to: from, text: msg1 });

  await addToConversationHistory(from, 'assistant', msg2);
  await sendWhatsAppText({ to: from, text: msg2 });

  await addToConversationHistory(from, 'assistant', msg3);
  await sendWhatsAppText({ to: from, text: msg3 });

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

/**
 * Process incoming WhatsApp message
 */
export async function processMessage({ from, text, messageId, profile }) {
  // Log incoming message
  logStructured('whatsapp_inbound', {
    from,
    text,
    messageId,
    profileName: profile?.name,
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

  // User is fully onboarded - handle normal operations
  return await handlePostOnboarding({
    account,
    from,
    text,
  });
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

        await sendWhatsAppText({
          to: from,
          text: buildVoucherClaimMessage({
            senderName,
            amountCents: gift.amountCents,
            pin: gift.voucherPin,
            serial: gift.voucherSerial,
          }),
        });

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
    console.log('💬 User in conversation state:', state);
    return await handleConversationState({ from, text, state, data, account });
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

  // =====================================================================
  // CONTEXT-AWARE INTENT DETECTION
  // Check if user was recently browsing a category - interpret follow-ups
  // in that context instead of defaulting to airtime
  // =====================================================================
  const categoryContext = await getActiveCategory(from);
  const normalized = text.toLowerCase().trim();
  
  if (categoryContext.isValid && categoryContext.category) {
    const category = categoryContext.category;
    const amountMatch = text.match(/r?\s?(\d+)/i);
    
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
          if (amount) {
            return await handleListGamingProducts({ from, account });
          }
          return await handleListGamingProducts({ from, account });
          
        case 'LIFESTYLE':
          // Lifestyle voucher flow
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
              text: `📱 *Buy R${amount} Airtime*\n\nWhich phone number should I send the airtime to?\n\nReply with the number (e.g., 0781234567) or "me" for your own number.`,
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
          text: `🎟️ *Redeem Voucher*\n\nPlease enter your 16-digit Blu Voucher PIN:\n\nExample: 1234-5678-9012-3456\n\nYour balance will be updated instantly!`,
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
            text: `📱 *Buy R${airtimeSlots.amountCents / 100} Airtime*\n\nWhich phone number should I send the airtime to?\n\nReply with the number (e.g., 0781234567) or "me" for your own number.`,
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
    /(deposit|top\s*up|topup|add|load|put)\s+(money|funds|cash|to my wallet|to wallet|into wallet)/.test(squashed) ||
    squashed.includes('deposit money') ||
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

/**
 * Handle conversation state (multi-turn conversations)
 */
async function handleConversationState({ from, text, state, data, account }) {
  console.log('💬 Handling conversation state:', { state, text, data });

  switch (state) {
    case 'AWAITING_VOUCHER_PIN':
      // User entered voucher PIN - single-step flow
      {
        const normalized = text.trim().toLowerCase();

        if (/^(cancel|stop|no|not now|later|reset|restart)$/i.test(normalized)) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `👍 No problem. When you're ready to add money again, just type "redeem voucher".`,
          });
        }

        if (/^(yes|yep|yeah|y|sure|ok|okay|alright|please|confirm)$/i.test(normalized)) {
          await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
          return await sendWhatsAppText({
            to: from,
            text: `Great! Please enter your 16-digit Blu Voucher PIN (numbers only).\nExample: 1234567890123456\n\nReply "cancel" to stop.`,
          });
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
        
        // Move to phone number collection
        await updateConversationState(from, 'AIRTIME_MSISDN', { amountCents });
        return await sendWhatsAppText({
          to: from,
          text: `📱 *R${amountCents / 100} Airtime*\n\nWhich phone number should I send the airtime to?\n\nReply with the number (e.g., 0781234567) or "me" for your own number.`,
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
        const amountCents = filledSlots.amountCents || data?.amountCents;
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
        if (!/^(yes|yep|yeah|y|sure|ok|okay|alright|confirm)$/i.test(normalized)) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `I've cancelled that request. Feel free to ask me anything else!`,
          });
        }
        
        if (/^(yes|yep|yeah|y|sure|ok|okay|alright|confirm)$/i.test(normalized)) {
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
        if (!/^(yes|yep|yeah|y|sure|ok|okay|alright|confirm)$/i.test(normalized)) {
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

    case 'AI_AIRTIME_PURCHASE':
    case 'AI_DATA_PURCHASE':
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

      if (!/^(yes|yep|yeah|y|sure|ok|okay|alright|confirm)$/i.test(normalized)) {
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

        // If the message doesn't look like a phone number at all, assume the
        // user wants out (mirrors AIRTIME_MSISDN).
        const digitsOnly = text.replace(/[^\d]/g, '');
        if (digitsOnly.length < 8) {
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

        if (!/^(yes|yep|yeah|y|sure|ok|okay|alright|confirm)$/i.test(normalized)) {
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
          text: `🔐 *Enter Your PIN*\n\nTo send the ${randsShort(amountCents)} WaPay voucher to ${maskMsisdn(recipientMsisdn)} (total ${randsShort(amountCents + (feeCents || 0))} incl. fee), please enter your WaPay PIN.`,
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
          text: `⏳ Sending your WaPay voucher...`,
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

          const receipt =
            `✅ Voucher sent!\n\n` +
            `🎁 Voucher: ${randsShort(paidAmountCents)}\n` +
            `💳 Fee: ${randsShort(paidFeeCents)}\n` +
            `📱 To: ${maskMsisdn(finalRecipient)}\n` +
            `🧾 Reference: ${executeData.reference}\n` +
            `📅 ${formatDateTimeZa(new Date())}\n\n` +
            `💳 New balance: R${((executeData.newBalance || 0) / 100).toFixed(2)}\n\n` +
            `They'll get their voucher the moment they message WaPay.`;
          await addToConversationHistory(from, 'assistant', receipt);
          await sendWhatsAppText({ to: from, text: receipt });

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
async function handleAIChat({ from, text, account }) {
  console.log('🤖 Routing to AI chat:', text);

  // Store user message in conversation history
  await addToConversationHistory(from, 'user', text);

  // Check if OpenAI is configured
  if (!process.env.OPENAI_API_KEY) {
    console.log('⚠️ OpenAI not configured, using fallback');
    const fallbackMsg = `👋 Hi there!\n\nI didn't quite understand that. Here's what I can help you with:\n\n💰 Check balance\n📱 Buy airtime\n📶 Buy data\n💡 Buy electricity\n🎬 Lifestyle vouchers\n🎮 Betting top-ups\n🎟️ Redeem voucher\n\nType "help" to see more options!`;
    await addToConversationHistory(from, 'assistant', fallbackMsg);
    return await sendWhatsAppText({
      to: from,
      text: fallbackMsg,
    });
  }

  try {
    // Get conversation history for context
    const history = await getConversationHistory(from, 5);
    const contextString = history.length > 0 
      ? `RECENT CONVERSATION:\n${history.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n')}\n\nNow respond to the latest message.`
      : '';

    const aiResponse = await chatWithAI(text, contextString);

    // Log AI response with intent
    if (aiResponse.triggerAction && aiResponse.intent) {
      logStructured('nlp_intent', {
        from,
        text,
        intent: aiResponse.intent,
        entities: aiResponse.entities,
        triggerAction: true,
        source: 'ai',
      });
    }

    // If AI detected an intent and wants to trigger action
    if (aiResponse.triggerAction && aiResponse.intent) {
      console.log('🎯 AI detected intent:', aiResponse.intent, aiResponse.entities);

      // IMPORTANT: Do NOT send raw JSON to users
      const responseText = sanitizeUserText(aiResponse.text) || 'Let me help you with that.';

      // Handle each intent
      switch (aiResponse.intent) {
        case 'BUY_AIRTIME':
          // Start airtime flow
          if (aiResponse.entities?.amount) {
            await updateConversationState(from, 'AIRTIME_MSISDN', { 
              amountCents: aiResponse.entities.amount * 100 
            });
            const msg = `📱 *Buy R${aiResponse.entities.amount} Airtime*\n\nWhich phone number should I send the airtime to?\n\nReply with the number (e.g., 0781234567) or "me" for your own number.`;
            await addToConversationHistory(from, 'assistant', msg);
          return await sendWhatsAppText({
            to: from,
              text: msg,
            });
          }
          
          await updateConversationState(from, 'AIRTIME_AMOUNT', aiResponse.entities || {});
          const airtimeMsg = `📱 *Buy Airtime*\n\nHow much airtime would you like to buy?\n\nReply with an amount (e.g., R10, R50, R100)`;
          await addToConversationHistory(from, 'assistant', airtimeMsg);
          return await sendWhatsAppText({
            to: from,
            text: airtimeMsg,
          });

        case 'BUY_DATA':
          if (!isCategoryLive('DATA')) {
            return await replyCategoryUnavailable(from, 'DATA');
          }
          await updateConversationState(from, null);
          return await handleListDataBundles({ from, account, entities: aiResponse.entities });

        case 'BUY_ELECTRICITY':
          // Start electricity purchase flow
          if (aiResponse.entities?.amount && aiResponse.entities?.meterNumber) {
            // Both amount and meter provided - go to meter state to generate preview
            await updateConversationState(from, 'ELECTRICITY_METER', {
              amountCents: aiResponse.entities.amount * 100,
            });
            const meterMsg = `💡 *Buy R${aiResponse.entities.amount} Electricity*\n\nPlease enter your meter number to confirm.`;
            await addToConversationHistory(from, 'assistant', meterMsg);
          return await sendWhatsAppText({
            to: from,
              text: meterMsg,
            });
          } else if (aiResponse.entities?.amount) {
            // Amount provided, need meter number
            await updateConversationState(from, 'ELECTRICITY_METER', {
              amountCents: aiResponse.entities.amount * 100,
            });
            const meterMsg = `💡 *Buy R${aiResponse.entities.amount} Electricity*\n\nPlease enter your meter number:`;
            await addToConversationHistory(from, 'assistant', meterMsg);
            return await sendWhatsAppText({
              to: from,
              text: meterMsg,
            });
          } else {
            // Need amount
            await updateConversationState(from, 'ELECTRICITY_AMOUNT', {
              meterNumber: aiResponse.entities?.meterNumber,
            });
            const amountMsg = `💡 *Buy Electricity*\n\nHow much electricity would you like to buy?\n\nReply with an amount (e.g., R50, R100, R500)\n(Min R10, Max R5000)`;
            await addToConversationHistory(from, 'assistant', amountMsg);
            return await sendWhatsAppText({
              to: from,
              text: amountMsg,
          });
          }

        case 'REDEEM_VOUCHER':
          await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
          const voucherMsg = `🎟️ *Redeem Voucher*\n\nPlease enter your 16-digit Blu Voucher PIN:\n\nExample: 1234-5678-9012-3456`;
          await addToConversationHistory(from, 'assistant', voucherMsg);
          return await sendWhatsAppText({
            to: from,
            text: voucherMsg,
          });

        case 'CHECK_BALANCE':
          const { balance, displayName } = await getUserBalance(from);
          const balanceMsg = `💰 *Your WaPay Balance*\n\nHi ${displayName}!\nYour current balance is R ${balance}\n\nWhat would you like to do next?`;
          await addToConversationHistory(from, 'assistant', balanceMsg);
          return await sendWhatsAppText({
            to: from,
            text: balanceMsg,
          });

        case 'LIST_PRODUCTS':
          return await handleListAllProducts({ from, account });

        case 'LIST_CATEGORY':
          const category = aiResponse.entities?.category;
          if (category === 'ELECTRICITY') {
            return await handleListElectricityProducts({ from, account });
          } else if (category === 'DATA') {
            return await handleListDataBundles({ from, account, networkCode: null });
          } else if (category === 'AIRTIME') {
            return await handleListAirtimeBundles({ from, account, networkCode: null });
          } else if (category === 'LIFESTYLE') {
            return await handleListLifestyleProducts({ from, account });
          } else if (category === 'GAMING') {
            return await handleListGamingProducts({ from, account });
          } else if (category === 'BILLPAY') {
            return await handleListBillpayProducts({ from, account });
          } else {
            return await handleListAllProducts({ from, account });
          }

        case 'BUY_LIFESTYLE':
          if (!isCategoryLive('LIFESTYLE')) {
            return await replyCategoryUnavailable(from, 'LIFESTYLE');
          }
          return await handleListLifestyleProducts({ from, account });

        case 'BUY_GAMING':
          if (!isCategoryLive('GAMING')) {
            return await replyCategoryUnavailable(from, 'GAMING');
          }
          return await handleListGamingProducts({ from, account });

        case 'HELP':
          const helpMsg = `📋 *WaPay Help Menu*\n\nHere's what I can help you with:\n\n💰 *Balance* - "What's my balance?"\n📱 *Airtime* - "Buy R50 airtime"\n📶 *Data* - "Buy 1GB data"\n💡 *Electricity* - "Buy R100 electricity"\n🎬 *Lifestyle* - "Netflix voucher"\n🎮 *Betting* - "Hollywoodbets top-up"\n🎟️ *Voucher* - "Redeem voucher"\n\nJust ask me in your own words!`;
          await addToConversationHistory(from, 'assistant', helpMsg);
          return await sendWhatsAppText({
            to: from,
            text: helpMsg,
          });

        default:
          // For unhandled intents, send only the text (never JSON)
          await addToConversationHistory(from, 'assistant', responseText);
          return await sendWhatsAppText({
            to: from,
            text: responseText,
          });
      }
    }

    // Otherwise, just send AI's informational response (text only, never JSON)
    const finalTextCandidate = typeof aiResponse === 'object' && aiResponse.text 
      ? aiResponse.text 
      : typeof aiResponse === 'string' 
        ? aiResponse 
        : 'I can help you with balance checks, airtime, data, electricity, and vouchers. What would you like to do?';

    const finalText = sanitizeUserText(finalTextCandidate) 
      || 'I can help you with balance checks, airtime, data, electricity, and vouchers. What would you like to do?';
    
    await addToConversationHistory(from, 'assistant', finalText);
    return await sendWhatsAppText({
      to: from,
      text: finalText,
    });

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
    const gamingIndicators = ['bet', 'betting', 'hollywood', 'lottostar', 'betway', 'supabets', 'gamble'];
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
      LIFESTYLE: ['voucher', 'gift card', 'ott', 'streaming'],
      BILLPAY: ['tv', 'subscription', 'bill'],
      GAMING: ['bet', 'betting', 'gamble', 'gambling', 'casino', 'lotto'],
      REMITTANCE: ['send money', 'transfer', 'remit', 'remittance'],
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
        title: 'Lifestyle & OTT Vouchers',
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
        emoji: '🎰',
        title: 'Betting & Gaming',
        formatProduct: (p) => {
          const price = ((p.fixedPriceCents || p.priceCents) / 100).toFixed(0);
          return `${p.label.split(' ')[0]} R${price}`;
        },
        helpText: 'Reply: *"Top up Hollywoodbets R50"*',
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

    let message = `🎮 *Lifestyle & OTT Vouchers*\n\nAvailable vouchers:\n\n`;
    
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
        text: `🎰 I couldn't find any betting operators in our catalogue right now.\n\nPlease try again later.`,
      });
    }

    // Group by operator
    const byOperator = {};
    for (const p of products) {
      const op = p.operatorCode || p.networkCode || 'OTHER';
      if (!byOperator[op]) byOperator[op] = [];
      byOperator[op].push(p);
    }

    let message = `🎰 *Betting & Gaming Top-ups*\n\nAvailable operators:\n\n`;
    
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
    
    message += `Reply: *"Top up Hollywoodbets R50"* and I'll help you.`;

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
      text: `❌ Sorry, I couldn't fetch the betting operators right now. Please try again later.`,
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

    // Build friendly category list
    const categoryNames = {
      AIRTIME: { name: '📱 Mobile Airtime', desc: 'Vodacom, MTN, Cell C, Telkom' },
      DATA: { name: '📶 Data Bundles', desc: 'Daily, Weekly, Monthly bundles' },
      ELECTRICITY: { name: '💡 Prepaid Electricity', desc: 'Eskom, City Power, and more' },
      BILLPAY: { name: '📺 Bill Payments', desc: 'DStv, GOtv subscriptions' },
      LIFESTYLE: { name: '🎮 Lifestyle & OTT', desc: 'Netflix, Uber, Google Play, Steam' },
      GAMING: { name: '🎰 Betting & Gaming', desc: 'Hollywoodbets, Lottostar, Betway' },
      REMITTANCE: { name: '💸 Money Transfers', desc: 'Mukuru, Hello Paisa, Mama Money' },
    };

    let message = `🛒 *WaPay VAS Products*\n\nHere's what you can buy on WaPay:\n\n`;
    
    for (const cat of categoryCounts) {
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
    const idemKey = `wapay-redeem-${pinHash.slice(0, 32)}`;

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
