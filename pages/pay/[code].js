/**
 * Public "please pay me" page — wapay.co.za/pay/<code>.
 *
 * Whoever opens the link sees who is asking, for how much, and two ways to
 * pay: their own WaPay balance (deep-links back into WhatsApp) or card/EFT
 * via PayFast. The PAYER pays exactly the request amount — the card fee is
 * deducted from what the REQUESTER receives (founder decision 2026-08-22:
 * whoever sends the link carries the cost).
 *
 * Card payers leave their WhatsApp number with the payment (founder ask
 * 2026-08-22: every payer becomes a user): the receipt lands on WhatsApp,
 * and a brand-new number flows straight into onboarding. The number is
 * required by the form but the checkout API never blocks a payment on it.
 *
 * Returning from PayFast lands on /pay/<code>?r=1 — while the ITN is still
 * in flight that renders a "confirming" state with NO pay buttons, so an
 * impatient payer can't charge their card twice (the cancel URL comes back
 * without ?r=1, which restores the pay options).
 *
 * Server-rendered; shows honest terminal states for PAID/EXPIRED/CANCELLED.
 * No customer PII beyond a masked requester name/number is ever rendered.
 */

import { getPaymentRequest, maskedRequesterLabel } from '../../lib/payment-requests.js';
import { paymentRequestFeeCents } from '../../lib/deposits.js';
import prisma from '../../lib/prisma.js';

const WA_NUMBER = '27760497624';

function rands(cents) {
  return `R${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
}

export async function getServerSideProps({ params, query }) {
  const code = String(params.code || '').toUpperCase();
  if (!/^[A-Z]{6,12}$/.test(code)) return { notFound: true };

  const request = await getPaymentRequest({ code });
  if (!request) return { notFound: true };

  let requesterLabel = 'A WaPay user';
  try {
    const account = await prisma.account.findUnique({ where: { id: request.accountId } });
    requesterLabel = maskedRequesterLabel(account);
  } catch {
    // The label is cosmetic — never block the page on it.
  }

  return {
    props: {
      code,
      status: request.status,
      amountCents: request.amountCents,
      feeCents: paymentRequestFeeCents(request.amountCents),
      note: request.note ?? null,
      requesterLabel,
      // Back from PayFast's return URL: the ITN may still be in flight.
      returned: query?.r === '1',
    },
  };
}

export default function PayRequestPage({ code, status, amountCents, feeCents, note, requesterLabel, returned }) {
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
      border: 'none',
      cursor: 'pointer',
    },
    primary: { background: '#1d7a3f', color: '#fff' },
    secondary: { background: '#eef3ef', color: '#1d7a3f', border: '1px solid #cfe3d6' },
    fine: { color: '#888', fontSize: 12, marginTop: 16 },
    done: { fontSize: 40, margin: '10px 0' },
    label: {
      display: 'block',
      textAlign: 'left',
      color: '#555',
      fontSize: 13,
      fontWeight: 600,
      marginTop: 16,
      marginBottom: 6,
    },
    input: {
      width: '100%',
      padding: '12px 14px',
      borderRadius: 10,
      border: '1px solid #cfd8d2',
      fontSize: 16,
      boxSizing: 'border-box',
    },
  };

  const waLink = `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(`Pay request ${code}`)}`;
  const receiptLink = `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(`Receipt ${code}`)}`;

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        {/* "Please pay me" hero — the phrase the market responds to (founder
            2026-08-25). The PRODUCT stays WaPay-branded (naming decision
            2026-08-22: domain and phrase, never the brand). */}
        <div style={styles.logo}>🙏 Please pay me</div>
        <div style={{ ...styles.fine, marginTop: -14, marginBottom: 14 }}>with WaPay</div>

        {status === 'PENDING' && returned ? (
          <>
            <div style={styles.done}>⏳</div>
            <div style={styles.sub}>PayFast is confirming your payment…</div>
            <div style={styles.amount}>{rands(amountCents)}</div>
            <a style={{ ...styles.btn, ...styles.primary }} href={receiptLink}>
              📲 Get my receipt + my own WaPay
            </a>
            <div style={styles.fine}>
              Tap the button above — your receipt lands on WhatsApp as soon as the payment
              clears, usually within a minute. If you cancelled the payment, reopen the link to
              try again.
            </div>
          </>
        ) : status === 'PENDING' ? (
          <>
            <div style={styles.sub}>{requesterLabel} is requesting</div>
            <div style={styles.amount}>{rands(amountCents)}</div>
            {note ? <div style={styles.note}>“{note}”</div> : null}

            <a style={{ ...styles.btn, ...styles.primary }} href={waLink}>
              Pay from my WaPay — free
            </a>

            {/* POST: the number must never ride a query string into logs. */}
            <form method="POST" action="/api/pay/checkout">
              <input type="hidden" name="code" value={code} />
              <label style={styles.label} htmlFor="payer">
                Your WhatsApp number — your receipt goes there
              </label>
              <input
                style={styles.input}
                id="payer"
                name="payer"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="073 123 4567"
                required
                pattern="[0-9+ ]{10,15}"
                title="South African cellphone number, e.g. 0731234567"
              />
              <button type="submit" style={{ ...styles.btn, ...styles.secondary }}>
                Pay {rands(amountCents)} by card / EFT
              </button>
            </form>

            <div style={styles.fine}>
              No fees for you — you pay exactly {rands(amountCents)}. Card payments are processed
              securely by PayFast, no WaPay account needed. Your number is used to send your
              receipt on WhatsApp — and to offer you your own free WaPay, which you're welcome to
              ignore. Paying from a WaPay balance is free — reply in WhatsApp to confirm with
              your PIN.
            </div>
          </>
        ) : status === 'PAID' ? (
          <>
            <div style={styles.done}>✅</div>
            <div style={styles.sub}>This request has been paid.</div>
            <div style={styles.amount}>{rands(amountCents)}</div>
            <a style={{ ...styles.btn, ...styles.primary }} href={receiptLink}>
              📲 Get my receipt + my own WaPay
            </a>
            <div style={styles.fine}>
              Paid it by card? Tap the button — your receipt is on WhatsApp, and your own free
              WaPay takes a minute to set up.
            </div>
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
