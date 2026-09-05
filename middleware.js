/**
 * Host routing for the admin console (founder 2026-08-28) and the WaPay for
 * Business portal (2026-09-04).
 *
 * The console must live on a wapay.co.za domain, NOT on the pay-link domain
 * (pleasepayme.co.za) that customers see. Set WAPAY_ADMIN_HOST to the admin
 * domain in Vercel; then /admin serves only there, and that host's root
 * redirects into the console. WAPAY_BUSINESS_HOST does the same for
 * /business (e.g. business.wapay.co.za). Unset = no restriction (nothing
 * breaks before the DNS exists).
 *
 * Deliberately narrow: it never touches /api/* (auth-gated already, and the
 * Didit webhook must stay reachable on the app domain).
 */

import { NextResponse } from 'next/server';
import { adminHostDecision } from './lib/admin-host.js';
import { businessHostDecision } from './lib/business-host.js';

export const config = { matcher: ['/', '/admin', '/admin/:path*', '/business', '/business/:path*'] };

export function middleware(req) {
  const host = req.headers.get('host') || '';
  const pathname = req.nextUrl.pathname;
  const adminHost = String(process.env.WAPAY_ADMIN_HOST || '').trim().toLowerCase();
  const businessHost = String(process.env.WAPAY_BUSINESS_HOST || '').trim().toLowerCase();
  const admin = adminHostDecision({ host, pathname, adminHost });
  // The two portals must live on DIFFERENT hosts. If an operator points both
  // envs at one host, the business host gating is ignored (its root would
  // otherwise be swallowed by the admin rewrite) and the collision is logged.
  const sameHost = adminHost && adminHost === businessHost;
  if (sameHost) console.error(JSON.stringify({ type: 'portal_host_collision', host: adminHost, hint: 'WAPAY_ADMIN_HOST and WAPAY_BUSINESS_HOST must differ; business host gating disabled' }));
  const business = businessHostDecision({ host, pathname, businessHost: sameHost ? '' : businessHost });

  if (admin === 'block' || business === 'block') {
    // 404, not a redirect: neither portal's existence is advertised on the
    // customer-facing domains.
    return new NextResponse(null, { status: 404 });
  }
  if (admin === 'rewrite' || business === 'rewrite') {
    const url = req.nextUrl.clone();
    url.pathname = admin === 'rewrite' ? '/admin' : '/business';
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}
