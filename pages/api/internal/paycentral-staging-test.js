/**
 * Staging-only PayCentral card test (internal key). Lets the founder issue and exercise a test
 * virtual card through our own client before any customer flow exists (docs/CARDS.md 0.12).
 *
 *   POST { action: 'create', firstName, lastName, cellphoneNumber, idOrPassportNumber }
 *   POST { action: 'load', seqNo, amountCents, testId }      reference derived from testId
 *   POST { action: 'check', reference, seqNo, amountCents }  what PayCentral recorded
 *   POST { action: 'balance', seqNo }
 *   POST { action: 'statement', seqNo, days }
 *   POST { action: 'freeze', seqNo } | { action: 'unfreeze', seqNo }
 *
 * Safety:
 * - Refuses unless PAYCENTRAL_BASE_URL is PayCentral's staging API, so it can never touch a live
 *   card or live money.
 * - Moves no WaPay money: no ledger, no wallet, no customer record.
 * - Never logs the request body (it carries an ID number); answers with what the client returns
 *   (seq_no, last four, expiry, outcomes): never a card number or security code.
 * - Loads are capped at R500.
 */
import crypto from 'node:crypto';
import { PayCentralClient, payCentralConfigured, isStagingBaseUrl, STOP_REASONS } from '../../../lib/paycentral.js';

export const config = { maxDuration: 60 };

const MAX_TEST_LOAD_CENTS = 50000;

function keyOk(req) {
  const internalKey = process.env.WAPAY_INTERNAL_API_KEY || '';
  const presented = req.headers['x-internal-api-key'];
  if (!internalKey || typeof presented !== 'string' || !presented) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(internalKey).digest();
  return crypto.timingSafeEqual(a, b);
}

const bad = (res, message) => res.status(400).json({ error: 'BAD_INPUT', message });
const seqOk = (v) => typeof v === 'string' && /^\d{1,19}$/.test(v);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!keyOk(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!isStagingBaseUrl()) return res.status(403).json({ error: 'STAGING_ONLY', message: 'PAYCENTRAL_BASE_URL is not the staging API' });
  if (!payCentralConfigured()) return res.status(503).json({ error: 'NOT_CONFIGURED', message: 'PAYCENTRAL_API_EMAIL / PAYCENTRAL_API_PASSWORD not set' });

  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const action = String(b.action || '');
  let client;
  try {
    client = new PayCentralClient();
  } catch (e) {
    return res.status(503).json({ error: e?.code || 'CONFIG' });
  }

  try {
    switch (action) {
      case 'create': {
        if (!b.firstName || !/^\d{10,12}$/.test(String(b.cellphoneNumber || ''))) return bad(res, 'firstName and cellphoneNumber (10 to 12 digits) are required');
        const r = await client.virtualAllocate({
          cellphoneNumber: String(b.cellphoneNumber),
          firstName: String(b.firstName).slice(0, 50),
          lastName: b.lastName ? String(b.lastName).slice(0, 50) : undefined,
          idOrPassportNumber: b.idOrPassportNumber ? String(b.idOrPassportNumber).slice(0, 16) : undefined,
        });
        return res.status(200).json({ action, result: r });
      }
      case 'load': {
        const amountCents = Number(b.amountCents);
        if (!seqOk(b.seqNo)) return bad(res, 'seqNo is required');
        if (!Number.isSafeInteger(amountCents) || amountCents < 100 || amountCents > MAX_TEST_LOAD_CENTS) return bad(res, 'amountCents must be 100 to 50000');
        if (!/^[A-Za-z0-9-]{4,40}$/.test(String(b.testId || ''))) return bad(res, 'testId (4 to 40 letters, digits or dashes) is required; reuse it to repeat the same load');
        try {
          const r = await client.loadCard({ cardIdentifier: b.seqNo, amountCents, idemKey: `staging-test-load-${b.testId}`, notes: 'WaPay staging test' });
          return res.status(200).json({ action, result: r });
        } catch (e) {
          return res.status(502).json({ action, error: e?.code || 'ERROR', reference: e?.reference || null, nextStep: e?.reference ? 'call action check with this reference' : null });
        }
      }
      case 'check': {
        if (!/^\d{12,20}$/.test(String(b.reference || ''))) return bad(res, 'reference is required');
        const amountCents = b.amountCents === undefined ? undefined : Number(b.amountCents);
        const r = await client.checkReference(String(b.reference), { cardIdentifier: seqOk(b.seqNo) ? b.seqNo : undefined, amountCents });
        return res.status(200).json({ action, result: r });
      }
      case 'balance': {
        if (!seqOk(b.seqNo)) return bad(res, 'seqNo is required');
        return res.status(200).json({ action, result: await client.cardBalance(b.seqNo) });
      }
      case 'statement': {
        if (!seqOk(b.seqNo)) return bad(res, 'seqNo is required');
        const days = Math.min(Math.max(Number(b.days) || 7, 1), 90);
        const to = new Date();
        const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
        return res.status(200).json({ action, result: await client.cardStatement({ cardIdentifier: b.seqNo, from, to }) });
      }
      case 'freeze': {
        if (!seqOk(b.seqNo)) return bad(res, 'seqNo is required');
        return res.status(200).json({ action, result: await client.freezeCard({ cardIdentifier: b.seqNo, stopReasonId: STOP_REASONS.OTHER, notes: 'WaPay staging test' }) });
      }
      case 'unfreeze': {
        if (!seqOk(b.seqNo)) return bad(res, 'seqNo is required');
        return res.status(200).json({ action, result: await client.unfreezeCard({ cardIdentifier: b.seqNo, notes: 'WaPay staging test' }) });
      }
      default:
        return bad(res, 'action must be create, load, check, balance, statement, freeze or unfreeze');
    }
  } catch (e) {
    return res.status(502).json({ action, error: e?.code || 'ERROR', attempts: e?.attempts ?? null });
  }
}
