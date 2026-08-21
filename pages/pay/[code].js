/**
 * Public "please pay me" page — wapay.co.za/pay/<code>.
 *
 * Whoever opens the link sees who is asking, for how much, and two ways to
 * pay: their own WaPay balance (deep-links back into WhatsApp) or card/EFT
 * via PayFast (the payer covers the banded payment fee; the requester is
 * credited face value by the ITN webhook).
 *
 * Server-rendered; shows honest terminal states for PAID/EXPIRED/CANCELLED.
 * No customer PII beyond a masked requester name/number is ever rendered.
 */

import { getPaymentRequest } from '../../lib/payment-requests.js';
import { depositFeeCents } from '../../lib/deposits.js';
import prisma from '../../lib/prisma.js';

const WA_NUMBER = '27760497624';

function rands(cents) {
  return `R${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
}

export async function getServerSideProps({ params }) {
  const code = String(params.code || '').toUpperCase();
  if (!/^[A-Z]{6,12}$/.test(code)) return { notFound: true };

  const request = await getPaymentRequest({ code });
  if (!request) return { notFound: true };

  let requesterLabel = 'A WaPay user';
  try {
    const account = await prisma.account.findUnique({ where: { id: request.accountId } });
    if (account?.displayName) requesterLabel = account.displayName;
    else if (account?.msisdn) {
      const m = account.msisdn;
      requesterLabel = `${m.slice(0, 3)}•••${m.slice(-3)}`;
    }
  } catch {
    // The label is cosmetic — never block the page on it.
  }

  return {
    props: {
      code,
      status: request.status,
      amountCents: request.amountCents,
      feeCents: depositFeeCents(request.amountCents),
      note: request.note ?? null,
      requesterLabel,
    },
  };
}

export default function PayRequestPage({ code, status, amountCents, feeCents, note, requesterLabel }) {
  const styles = {
    page: {
      minHeight: '100vh',
      background: '#f4f7f5',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      padding: 16,
    },
    card: {
      background: '#fff',
      borderRadius: 16,
      boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
      padding: 32,
      maxWidth: 420,
      width: '100%',
      textAlign: 'center',
    },
    logo: { color: '#1d7a3f', fontSize: 28, fontWeight: 800, marginBottom: 20 },
    amount: { fontSize: 44, fontWeight: 800, color: '#111', margin: '8px 0' },
    sub: { color: '#555', fontSize: 15, marginBottom: 4 },
    note: { color: '#333', fontStyle: 'italic', margin: '12px 0' },
    btn: {
      display: 'block',
      width: '100%',
      padding: '14px 16px',
      borderRadius: 10,
      fontSize: 16,
      fontWeight: 700,
      textDecoration: 'none',
      marginTop: 12,
      boxSizing: 'border-box',
    },
    primary: { background: '#1d7a3f', color: '#fff' },
    secondary: { background: '#eef3ef', color: '#1d7a3f', border: '1px solid #cfe3d6' },
    fine: { color: '#888', fontSize: 12, marginTop: 16 },
    done: { fontSize: 40, margin: '10px 0' },
  };

  const waLink = `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(`Pay request ${code}`)}`;

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.logo}>WaPay</div>

        {status === 'PENDING' ? (
          <>
            <div style={styles.sub}>{requesterLabel} is requesting</div>
            <div style={styles.amount}>{rands(amountCents)}</div>
            {note ? <div style={styles.note}>“{note}”</div> : null}

            <a style={{ ...styles.btn, ...styles.primary }} href={waLink}>
              Pay from my WaPay — free
            </a>
            <a style={{ ...styles.btn, ...styles.secondary }} href={`/api/pay/checkout?code=${code}`}>
              Pay {rands(amountCents + feeCents)} by card / EFT
            </a>

            <div style={styles.fine}>
              Card payments include a {rands(feeCents)} payment fee and are processed securely by
              PayFast. No WaPay account needed. Paying from a WaPay balance is free — reply in
              WhatsApp to confirm with your PIN.
            </div>
          </>
        ) : status === 'PAID' ? (
          <>
            <div style={styles.done}>✅</div>
            <div style={styles.sub}>This request has already been paid.</div>
            <div style={styles.amount}>{rands(amountCents)}</div>
          </>
        ) : (
          <>
            <div style={styles.done}>⏳</div>
            <div style={styles.sub}>
              This payment request is no longer active
              {status === 'EXPIRED' ? ' (it expired)' : ''}.
            </div>
            <div style={styles.fine}>Ask the sender for a fresh link.</div>
          </>
        )}
      </div>
    </div>
  );
}
