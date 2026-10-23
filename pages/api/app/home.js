/**
 * WaPay personal portal: the home screen (2026-10-21).
 *
 * GET → { name, balance (available = SPEND + CASH, the two lines, held), banner,
 *         kyc, payoutsOn, recent (last 5), tiles }
 * Session-gated before any read. Labels and last digits only.
 */
import { appDeps } from '../../../lib/app-deps.js';
import { gate } from '../../../lib/app-http.js';
import { homeView } from '../../../lib/app-portal.js';

export const config = { maxDuration: 15 };

export function createHomeHandler(depsOverride = null) {
  return async function handler(req, res) {
    const deps = depsOverride || (await appDeps());
    const g = await gate(req, res, deps, { methods: ['GET'] });
    if (!g) return undefined;
    try {
      return res.status(200).json({ ok: true, ...(await homeView(deps, g.session.account)) });
    } catch (error) {
      console.error(JSON.stringify({ type: 'app_home_error', accountId: g.session.account.id, error: error?.message }));
      return res.status(500).json({ ok: false, error: 'TRY_AGAIN' });
    }
  };
}

export default createHomeHandler();
