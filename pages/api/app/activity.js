/**
 * WaPay personal portal: activity (2026-10-21).
 *
 * GET ?before=<ISO> → { items (newest first, up to 50), nextBefore }
 * Every movement on the customer's own wallets from the journal, plus pay-outs
 * in progress or that did not go through. Session-gated before any read.
 */
import { appDeps } from '../../../lib/app-deps.js';
import { gate } from '../../../lib/app-http.js';
import { activityPage } from '../../../lib/app-portal.js';

export const config = { maxDuration: 15 };

export function createActivityHandler(depsOverride = null) {
  return async function handler(req, res) {
    const deps = depsOverride || (await appDeps());
    const g = await gate(req, res, deps, { methods: ['GET'] });
    if (!g) return undefined;
    const before = typeof req.query?.before === 'string' ? req.query.before.slice(0, 40) : null;
    try {
      return res.status(200).json({ ok: true, ...(await activityPage(deps, g.session.account, { before })) });
    } catch (error) {
      console.error(JSON.stringify({ type: 'app_activity_error', accountId: g.session.account.id, error: error?.message }));
      return res.status(500).json({ ok: false, error: 'TRY_AGAIN' });
    }
  };
}

export default createActivityHandler();
