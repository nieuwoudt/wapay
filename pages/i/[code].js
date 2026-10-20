/**
 * Referral link landing: pleasepayme.co.za/i/<code> (docs/REFERRALS.md, 2026-10-20).
 *
 * The member's forwardable invite carries this link. Whoever taps it is sent
 * straight on to WhatsApp (wa.me) with the first message to WaPay prefilled
 * and carrying the member's invite code; when they send it, the chat stamps
 * the new account with the referrer (lib/referrals.js). The redirect also
 * carries utm_source=referral and utm_content=<code> so web analytics can see
 * the channel; the code in the message is what attributes.
 *
 * No database, no personal data: a malformed code is a 404, a well-formed one
 * redirects whether or not anyone holds it (the chat resolves it; an unknown
 * code simply starts the ordinary welcome). Nothing here messages anyone.
 */

import { referralRedirect } from '../../lib/referrals.js';

export async function getServerSideProps({ params }) {
  const target = referralRedirect(params?.code);
  if (!target) return { notFound: true };
  console.log(JSON.stringify({ type: 'referral_link_opened', code: target.code, timestamp: new Date().toISOString() }));
  return { redirect: { destination: target.location, permanent: false } };
}

// Never rendered: getServerSideProps always redirects or 404s.
export default function ReferralInvite() {
  return null;
}
