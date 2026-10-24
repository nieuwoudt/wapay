/**
 * WaPay personal portal: get paid (2026-10-21).
 *
 * GET                                                       → { links (every status, newest first); an open link also
 *                                                             carries shareText, reminderText and remindUrl (2026-10-24) }
 * POST {action:'prepare', amountCents}                      → the quote (both ways) and the intent the PIN approves
 * POST {action:'create', intentId, amountCents, label?, note, proof} → { link, shareText }; note (what it is for) is
 *                                                             required since 2026-10-24, refused with a plain line
 * POST {action:'cancel', code}                              → an open link of this customer's, cancelled
 *
 * Money never moves here: the link is an ordinary payment request that the
 * pay page settles. Creating one still needs the PIN proof (brief, binding),
 * checked before anything is written; the intent creates one link only.
 * A reminder is a text the customer sends themselves (the share sheet, or a
 * wa.me link where WhatsApp asks who to send it to): WaPay sends nothing.
 */
import { appDeps } from '../../../lib/app-deps.js';
import { gate, reply, intOf } from '../../../lib/app-http.js';
import { linksOf, webLine } from '../../../lib/app-portal.js';
import { capabilityById } from '../../../lib/capabilities.js';
import { linkPrepare, createLink, cancelLink } from '../../../lib/app-money.js';
import { webLinkTexts } from '../../../lib/pay-links.js';

export const config = { maxDuration: 15 };

export function createLinksHandler(depsOverride = null) {
  return async function handler(req, res) {
    const deps = depsOverride || (await appDeps());
    const g = await gate(req, res, deps);
    if (!g) return undefined;
    const account = g.session.account;
    if (req.method === 'GET') {
      try {
        const links = (await linksOf(deps, account, { now: deps.now() })).map((l) => (l.status === 'OPEN'
          ? { ...l, ...webLinkTexts({ account, request: { id: l.code, amountCents: l.amountCents, note: l.note, expiresAt: l.expiresAt } }) }
          : l));
        return res.status(200).json({ ok: true, links, feeLine: `${webLine(capabilityById('REQUEST_MONEY')?.feeLine?.() || '')} Links last 7 days.`.trim() });
      } catch (error) {
        console.error(JSON.stringify({ type: 'app_links_error', accountId: account.id, error: error?.message }));
        return res.status(500).json({ ok: false, error: 'TRY_AGAIN' });
      }
    }
    const b = req.body || {};
    try {
      if (b.action === 'prepare') {
        const out = linkPrepare({ amountCents: intOf(b.amountCents), now: deps.now() });
        return reply(res, out.ok ? out : { ...out, status: 400 });
      }
      if (b.action === 'create') {
        const out = await createLink(deps, { account, intentId: String(b.intentId || ''), amountCents: intOf(b.amountCents), label: b.label, note: b.note, proof: b.proof });
        if (out.ok) console.log(JSON.stringify({ type: 'app_link_created', accountId: account.id, code: out.link?.code, replayed: !!out.replayed }));
        return reply(res, out);
      }
      if (b.action === 'cancel') return reply(res, await cancelLink(deps, { account, code: b.code }));
      return res.status(400).json({ ok: false, error: 'ACTION' });
    } catch (error) {
      console.error(JSON.stringify({ type: 'app_links_write_error', accountId: account.id, action: b.action, error: error?.message }));
      return res.status(500).json({ ok: false, error: 'TRY_AGAIN' });
    }
  };
}

export default createLinksHandler();
