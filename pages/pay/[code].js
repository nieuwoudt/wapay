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

import Head from 'next/head';
import { useRef, useState } from 'react';

import { getPaymentRequest, maskedRequesterLabel, requesterNumberTail } from '../../lib/payment-requests.js';
import { paymentRequestFeeCents } from '../../lib/deposits.js';
import prisma from '../../lib/prisma.js';

const WA_NUMBER = '27760497624';

// Same shape the payer input's pattern attribute declares.
const PAYER_NUMBER_SHAPE = /^[0-9+ ]{10,15}$/;

function rands(cents) {
  return `R${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
}

export async function getServerSideProps({ params, query }) {
  const code = String(params.code || '').toUpperCase();
  const { adumoEnabled, primaryCardRail } = await import('../../lib/adumo.js');
  // Adumo is offered to payers only once it is the primary rail. While it is
  // enabled for the live R5 tests (WAPAY_PRIMARY_CARD_RAIL=PAYFAST) the page
  // stays PayFast-only, and a test reaches Adumo through
  // /api/pay/checkout?code=…&rail=adumo (docs/ADUMO.md section 5).
  const adumo = adumoEnabled() && primaryCardRail() === 'ADUMO';
  // Back from a declined / cancelled hosted-page attempt: a short reason, no PII.
  const declined = typeof query?.e === 'string' ? String(query.e).replace(/[^A-Za-z_ ]/g, '').slice(0, 24) : null;
  if (!/^[A-Z]{6,12}$/.test(code)) return { notFound: true };

  const request = await getPaymentRequest({ code });
  if (!request) return { notFound: true };

  let requesterLabel = 'A WaPay user';
  // Pay-link identity (2026-10-20): the name is the requester's own WhatsApp
  // profile name, so the page also shows the last three digits of their
  // number, a second signal the payer can check against the number they
  // know. Business links name the business instead and carry no tail.
  let requesterTail = null;
  try {
    const account = await prisma.account.findUnique({ where: { id: request.accountId } });
    requesterLabel = maskedRequesterLabel(account);
    requesterTail = requesterNumberTail(account);
  } catch {
    // The label is cosmetic — never block the page on it.
  }

  // WaPay for Business (2026-09-04): a business link names the BUSINESS, not
  // the owner's personal number, and itemises what is being paid for. The
  // stored name was sanitised at registration (lib/business.js) and is
  // rendered as plain text only.
  let isBusiness = false;
  let businessLogo = null;
  let status = request.status;
  if (request.businessId) {
    try {
      const business = await prisma.business.findUnique({ where: { id: request.businessId } });
      if (business?.name && business.status === 'ACTIVE') {
        requesterLabel = business.name;
        requesterTail = null;
        isBusiness = true;
        // The logo the business uploaded (a small data URL kept in its
        // settings, validated on upload); never anything else from settings.
        const logo = business.settings && typeof business.settings === 'object' ? business.settings.logo : null;
        if (typeof logo === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo) && logo.length < 120000) businessLogo = logo;
      } else if (status === 'PENDING') {
        // A suspended (or deleted) business collects nothing: the link reads
        // as no longer active, and checkout refuses it too.
        status = 'CANCELLED';
      }
    } catch {
      // Falls back to the owner's masked label.
    }
  }
  const items = Array.isArray(request.items)
    ? request.items
        .filter((it) => it && typeof it.name === 'string' && Number.isInteger(it.qty) && Number.isInteger(it.unitCents))
        .slice(0, 25)
        .map((it) => ({ name: String(it.name).slice(0, 60), qty: it.qty, unitCents: it.unitCents }))
    : [];

  return {
    props: {
      code,
      status,
      amountCents: request.amountCents,
      feeCents: paymentRequestFeeCents(request.amountCents),
      note: request.note ?? null,
      requesterLabel,
      requesterTail,
      isBusiness,
      businessLogo,
      adumo,
      declined,
      items,
      reference: typeof request.reference === 'string' && request.reference ? request.reference.slice(0, 40) : null,
      // Back from PayFast's return URL: the ITN may still be in flight.
      returned: query?.r === '1',
    },
  };
}

export default function PayRequestPage({ code, status, amountCents, feeCents, note, requesterLabel, requesterTail = null, returned, isBusiness = false, businessLogo = null, adumo = false, declined = null, items = [], reference = null }) {
  // Card button lights up the moment a plausible number is typed, and a tap
  // WITHOUT one answers with our own popup instead of a silent browser
  // bounce (founder feedback 2026-08-27). Same shape the input's pattern
  // attribute declares; the checkout API stays lenient regardless.
  const [payerNumber, setPayerNumber] = useState('');
  const [numberNudge, setNumberNudge] = useState(false);
  const payerInputRef = useRef(null);
  const numberLooksOk = PAYER_NUMBER_SHAPE.test(payerNumber.trim());

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
    tm: { fontSize: 13, fontWeight: 400, verticalAlign: 'super' },
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
    cardReady: {
      background: '#1d7a3f',
      color: '#fff',
      border: '1px solid #1d7a3f',
      boxShadow: '0 3px 12px rgba(29,122,63,0.35)',
    },
    nudge: {
      background: '#fff4e5',
      border: '1px solid #f0c36d',
      color: '#8a5a00',
      borderRadius: 10,
      padding: '10px 12px',
      fontSize: 14,
      fontWeight: 600,
      marginTop: 10,
      textAlign: 'left',
    },
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

  // The name plus the number tail, unless the label is already a masked number.
  const shownLabel = requesterTail && !String(requesterLabel).endsWith(requesterTail) ? `${requesterLabel} ${requesterTail}` : requesterLabel;
  const ogTitle = status === 'PENDING'
    ? `Please pay ${shownLabel} · ${rands(amountCents)}`
    : `Please Pay Me™ with WaPay`;

  return (
    <div style={styles.page}>
      <Head>
        <title>{ogTitle}</title>
        <meta property="og:title" content={ogTitle} />
        <meta
          property="og:description"
          content={`${status === 'PENDING' && note ? `For ${String(note).replace(/[\s.!]+$/, '')}. ` : ''}Tap to pay on WaPay. Free from a WaPay balance, or pay securely by card.`}
        />
        <meta property="og:site_name" content="Please Pay Me™ with WaPay" />
        <meta property="og:type" content="website" />
        <meta name="twitter:card" content="summary" />
      </Head>
      <div style={styles.card}>
        {/* "Please pay me" hero — the phrase the market responds to (founder
            2026-08-25). The PRODUCT stays WaPay-branded (naming decision
            2026-08-22: domain and phrase, never the brand). */}
        <div style={styles.logo}>
          🙏 Please Pay Me
          <span style={styles.tm}>™</span>
        </div>
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
              Tap the button above. Your receipt lands on WhatsApp as soon as the payment
              clears, usually within a minute. If you cancelled the payment, reopen the link to
              try again.
            </div>
          </>
        ) : status === 'PENDING' ? (
          <>
            {businessLogo && <img src={businessLogo} alt="" width={64} height={64} style={{ width: 64, height: 64, borderRadius: 16, objectFit: 'cover', display: 'block', margin: '0 auto 8px', background: '#fff' }} />}
            <div style={styles.sub}>{shownLabel} is requesting</div>
            <div style={styles.amount}>{rands(amountCents)}</div>
            {isBusiness && (items.length > 0 || reference) ? (
              <div style={{ textAlign: 'left', background: '#f6f9f7', border: '1px solid #e3ebe6', borderRadius: 12, padding: '10px 14px', margin: '10px 0 4px', fontSize: 14, color: '#333' }}>
                {items.map((it, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0' }}>
                    <span>{it.name}{it.qty > 1 ? ` × ${it.qty}` : ''}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{rands(it.qty * it.unitCents)}</span>
                  </div>
                ))}
                {reference ? <div style={{ color: '#666', fontSize: 12.5, marginTop: items.length ? 6 : 0 }}>Ref: {reference}</div> : null}
              </div>
            ) : null}
            {/* What the link is for (founder 2026-10-24: every personal link carries one; the payer reads it here). */}
            {note ? <div style={styles.note}>For: {note}</div> : null}
            {requesterTail ? (
              <div style={{ ...styles.fine, color: '#1f3b2a', background: '#eef6f0', borderRadius: 10, padding: '8px 12px', marginTop: 10 }}>
                Check the number. This request comes from the WaPay account on a number ending {requesterTail}.
                If that is not the person you expect, do not pay.
              </div>
            ) : null}

            {/* One way to pay, front and centre (founder 2026-10-22: payers were confused by
                three options and a paragraph). The number comes first because the receipt
                needs it; the card/EFT button is the only primary action; paying from a WaPay
                balance is a small link underneath for the people who have one. POST so the
                number never rides a query string into logs. */}
            <form
              method="POST"
              action="/api/pay/checkout"
              noValidate
              onSubmit={(e) => {
                // Autofill can set the field without firing onChange (iOS
                // Safari) — the gate trusts the DOM value at submit time,
                // never the mirrored state.
                const domValue = String(payerInputRef.current?.value ?? payerNumber);
                if (!PAYER_NUMBER_SHAPE.test(domValue.trim())) {
                  e.preventDefault();
                  setNumberNudge(true);
                  payerInputRef.current?.focus();
                }
              }}
            >
              <input type="hidden" name="code" value={code} />
              {declined ? <div style={styles.nudge}>That payment did not go through ({declined.toLowerCase().replace(/_/g, ' ')}). Nothing was charged. You can try again.</div> : null}
              <label style={styles.label} htmlFor="payer">
                Your WhatsApp number (for your receipt)
              </label>
              <input
                ref={payerInputRef}
                style={styles.input}
                id="payer"
                name="payer"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="073 123 4567"
                value={payerNumber}
                onChange={(e) => setPayerNumber(e.target.value)}
                required
                pattern="[0-9+ ]{10,15}"
                title="South African cellphone number, e.g. 0731234567"
              />
              {numberNudge && !numberLooksOk ? (
                <div style={styles.nudge}>📱 Enter your WhatsApp number first.</div>
              ) : null}
              <button
                type="submit"
                name="rail"
                value={adumo ? 'adumo' : 'payfast'}
                style={{ ...styles.btn, ...(numberLooksOk ? styles.cardReady : styles.secondary), marginTop: 10 }}
              >
                {adumo ? `Pay ${rands(amountCents)} by card, Instant EFT or Capitec Pay` : `Pay ${rands(amountCents)} by card or instant EFT`}
              </button>
              {adumo ? (
                <button type="submit" name="rail" value="payfast" style={{ ...styles.btn, ...styles.secondary, marginTop: 8 }}>
                  Other ways to pay (PayFast)
                </button>
              ) : null}
            </form>

            <div style={{ ...styles.fine, marginTop: 10 }}>
              Have a WaPay balance? <a href={waLink} style={{ color: '#359853', fontWeight: 600 }}>Pay from it in WhatsApp</a>, free.
            </div>
            <div style={styles.fine}>
              No fees for you: you pay exactly {rands(amountCents)}. Payments are processed securely by PayFast{adumo ? ' or Adumo (Nedbank)' : ''}; no WaPay account is needed.
              Your number is used to send your receipt on WhatsApp and to offer you your own free WaPay, which you're welcome to ignore.{isBusiness ? ` ${requesterLabel} receives your number for its records.` : ''}
            </div>
            <div style={styles.fine}>
              Have a WaPay account? <a href="https://app.wapay.co.za" style={{ color: '#359853', fontWeight: 600 }}>Log in at app.wapay.co.za</a> to see your balance, get paid and pay out.
            </div>
          </>
        ) : status === 'PAID' ? (
          <>
            <div style={styles.done}>✅</div>
            <div style={styles.sub}>This request has been paid.</div>
            <div style={styles.fine}>
              Have a WaPay account? <a href="https://app.wapay.co.za" style={{ color: '#359853', fontWeight: 600 }}>Log in at app.wapay.co.za</a> to see your balance, get paid and pay out.
            </div>
            <div style={styles.amount}>{rands(amountCents)}</div>
            <a style={{ ...styles.btn, ...styles.primary }} href={receiptLink}>
              📲 Get my receipt + my own WaPay
            </a>
            <div style={styles.fine}>
              Paid it by card? Tap the button. Your receipt is on WhatsApp, and your own free
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
