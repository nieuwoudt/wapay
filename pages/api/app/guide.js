/**
 * WaPay personal portal: what the landing screen says about WaPay (2026-11-24).
 *
 * GET → { ok, guide } the one line, the answers for a visitor and for a member, the
 *       fallback lines, and the link that opens the person's own WhatsApp to open an account.
 *
 * Public and the same for everyone: no session is read and no customer data is
 * in it. Every answer is the ad flow's own (lib/app-portal.js guideView), so the
 * web says what the chat says. Nothing typed on the landing screen is sent here.
 */
import { appDeps } from '../../../lib/app-deps.js';
import { gate } from '../../../lib/app-http.js';
import { guideView } from '../../../lib/app-portal.js';

export const config = { maxDuration: 10 };

export function createGuideHandler(depsOverride = null) {
  return async function handler(req, res) {
    const deps = depsOverride || (await appDeps());
    const g = await gate(req, res, deps, { auth: false, methods: ['GET'] });
    if (!g) return undefined;
    return res.status(200).json({ ok: true, guide: guideView() });
  };
}

export default createGuideHandler();
