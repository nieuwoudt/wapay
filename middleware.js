/**
 * Host routing for the admin console (founder 2026-08-28).
 *
 * The console must live on a wapay.co.za domain, NOT on the pay-link domain
 * (pleasepayme.co.za) that customers see. Set WAPAY_ADMIN_HOST to the admin
 * domain in Vercel; then /admin serves only there, and that host's root
 * redirects into the console. Unset = no restriction (nothing breaks before
 * the DNS exists).
 *
 * Deliberately narrow: it never touches /api/* (auth-gated already, and the
 * Didit webhook must stay reachable on the app domain).
 */

import { NextResponse } from 'next/server';
import { adminHostDecision } from './lib/admin-host.js';

export const config = { matcher: ['/', '/admin', '/admin/:path*'] };

export function middleware(req) {
  const decision = adminHostDecision({
    host: req.headers.get('host') || '',
    pathname: req.nextUrl.pathname,
    adminHost: process.env.WAPAY_ADMIN_HOST,
  });

  if (decision === 'rewrite') {
    const url = req.nextUrl.clone();
    url.pathname = '/admin';
    return NextResponse.rewrite(url);
  }
  if (decision === 'block') {
    // 404, not a redirect: the console's existence is not advertised on the
    // customer-facing domains.
    return new NextResponse(null, { status: 404 });
  }
  return NextResponse.next();
}
