/**
 * GET  /api/internal/incidents                      the incident responder's work list
 * POST /api/internal/incidents { fingerprint, note } close one item with the note that says what fixed it
 *
 * The list is every open and recurring row of the findings table: the live alerts (lib/incidents.js:
 * a chat loop the guard broke, a message WaPay's code sent past its gate, another sender's volume on
 * the number) and the daily conversation audit's findings, P1 first. Each row carries what happened,
 * where to look and masked sample words. No customer number, name or account id leaves this route.
 *
 * Auth (lib/responder-auth.js): `x-responder-key` (WAPAY_RESPONDER_KEY, a key that opens this route
 * and nothing else, for an agent that runs outside the founder's machine) or the internal key.
 *
 *   curl -H "x-responder-key: $KEY" https://wapay-api.vercel.app/api/internal/incidents
 *   curl -X POST -H "x-responder-key: $KEY" -H "content-type: application/json" \
 *     -d '{"fingerprint":"<40 hex>","note":"Fixed in <commit>, BUGLOG #<n>: <one line>"}' \
 *     https://wapay-api.vercel.app/api/internal/incidents
 *
 * The runbook is docs/audits/INCIDENT_RESPONDER.md.
 */
import prisma from '../../../lib/prisma.js';
import { responderAuth } from '../../../lib/responder-auth.js';
import { listForResponder, resolveForResponder } from '../../../lib/incidents-api.js';

export const config = { maxDuration: 20 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }
  const auth = responderAuth(req);
  if (!auth.ok) {
    console.log(JSON.stringify({ type: 'incidents_auth_rejected', status: auth.status }));
    return res.status(auth.status).json({ ok: false, error: auth.error });
  }
  try {
    if (req.method === 'GET') {
      const out = await listForResponder({ prisma, limit: req.query?.limit });
      return res.status(200).json({ ok: true, at: new Date().toISOString(), ...out });
    }
    const out = await resolveForResponder({ prisma, fingerprint: req.body?.fingerprint, note: req.body?.note, by: auth.as });
    if (!out.ok) return res.status(out.status).json({ ok: false, error: out.error });
    console.log(JSON.stringify({ type: 'incident_resolved', fingerprint: out.finding.fingerprint, by: auth.as }));
    return res.status(200).json(out);
  } catch (error) {
    console.error(JSON.stringify({ type: 'incidents_route_error', error: error?.message }));
    return res.status(500).json({ ok: false, error: 'UNAVAILABLE' });
  }
}
