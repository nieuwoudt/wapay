/**
 * The founder's approval page (2026-10-26): opened from the link in a pay-out alert. Shows the waiting pay-out,
 * its fraud level and reasons, and approves or rejects it with one tap. lib/payout-approval.js.
 */
import { useEffect, useState } from 'react';
import Head from 'next/head';

const R = (c) => `R${(Number(c || 0) / 100).toFixed(2).replace(/\.00$/, '')}`;
const s = {
  page: { minHeight: '100vh', background: '#F4F6F5', fontFamily: 'Inter, system-ui, sans-serif', padding: 16, color: '#111' },
  card: { maxWidth: 460, margin: '20px auto', background: '#fff', borderRadius: 16, padding: 18, boxShadow: '0 1px 3px rgba(0,0,0,.08)' },
  kv: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderBottom: '1px solid #EEF0EF', fontSize: 14 },
  muted: { color: '#667', fontSize: 13 },
  go: { width: '100%', padding: 14, border: 0, borderRadius: 12, background: '#359853', color: '#fff', fontWeight: 700, fontSize: 16, marginTop: 14, cursor: 'pointer' },
  no: { width: '100%', padding: 12, border: '1px solid #E5B4B4', borderRadius: 12, background: '#fff', color: '#991B1B', fontWeight: 600, fontSize: 15, marginTop: 8, cursor: 'pointer' },
};
const LEVEL = { 1: '🟢 1/5', 2: '🟢 2/5', 3: '🟡 3/5', 4: '🟠 4/5', 5: '🔴 5/5' };

export default function ApprovePayout() {
  const [token, setToken] = useState('');
  const [p, setP] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('token') || '';
    setToken(t);
    fetch(`/api/ops/approve?token=${encodeURIComponent(t)}`).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setErr(j.reason === 'EXPIRED' ? 'This link has expired. Use Mission Control → Pay-outs.' : 'This link is not valid.');
      else setP(j.payout);
    }).catch(() => setErr('No connection.'));
  }, []);
  const decide = async (decision) => {
    if (decision === 'approve' && !window.confirm(`Pay ${R(p.amountCents)} to ${p.to?.name || 'the customer'} now?`)) return;
    if (decision === 'reject' && !window.confirm('Reject it? The money goes back to the customer\'s balance.')) return;
    setBusy(true);
    try {
      const r = await fetch('/api/ops/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, decision }) });
      setDone(await r.json().catch(() => ({ ok: false })));
    } finally { setBusy(false); }
  };
  const waiting = p?.status === 'AWAITING_APPROVAL';
  return (
    <div style={s.page}>
      <Head><title>Approve pay-out · WaPay</title><meta name="robots" content="noindex" /></Head>
      <div style={s.card}>
        <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 6 }}>Pay-out waiting for you</div>
        {err && <div style={{ background: '#FEF2F2', color: '#991B1B', padding: 12, borderRadius: 12 }}>{err}</div>}
        {!p && !err && <div style={s.muted}>Loading…</div>}
        {p && (
          <>
            <div style={s.kv}><span>Customer</span><span>{p.name || '–'} ({p.phone})</span></div>
            <div style={s.kv}><span>Account</span><span>{p.accountAgeDays} days old · {p.idChecked ? 'ID checked' : 'ID not checked'}{p.frozen ? ' · FROZEN' : ''}</span></div>
            <div style={s.kv}><span>Amount</span><span><b>{R(p.amountCents)}</b> by {p.methodLabel}</span></div>
            <div style={s.kv}><span>Fee</span><span>{R(p.feeCents)}{p.express ? ' (double, money under 2 h old)' : ''}</span></div>
            <div style={s.kv}><span>To</span><span>{[p.to?.name, p.to?.account || p.to?.mobile].filter(Boolean).join(' · ') || '–'}</span></div>
            <div style={s.kv}><span>Fraud level</span><span>{LEVEL[p.level] || '–'}</span></div>
            {p.reasons?.length ? <div style={{ ...s.muted, padding: '8px 0' }}>Why: {p.reasons.join(', ').toLowerCase().replace(/_/g, ' ')}</div> : null}
            <div style={s.kv}><span>Asked</span><span>{new Date(p.requestedAt).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })}</span></div>
            {done ? (
              <div style={{ marginTop: 14, padding: 12, borderRadius: 12, background: done.ok ? '#ECFDF3' : '#FEF2F2', color: done.ok ? '#14532D' : '#991B1B' }}>
                {done.ok ? (done.status === 'REJECTED' ? 'Rejected. The money is back in their balance.' : done.status === 'SETTLED' ? `Paid. Reference ${done.reference}.` : `Sent to the bank rail. Reference ${done.reference}.`)
                  : done.error === 'FLOAT_SHORT' ? `The pay-out float has ${R(done.floatCents)}, it needs ${R(done.needCents)}. Top up OTT, then approve again; it is still waiting.`
                  : done.error === 'FROZEN' ? 'The account is frozen, so it was rejected and the money went back.'
                  : done.error === 'NOT_WAITING' ? 'Already decided.' : `It did not go through (${done.error || 'error'}).`}
              </div>
            ) : waiting ? (
              <>
                <button style={s.go} disabled={busy} onClick={() => decide('approve')}>Approve and pay {R(p.amountCents)}</button>
                <button style={s.no} disabled={busy} onClick={() => decide('reject')}>Reject</button>
              </>
            ) : <div style={{ ...s.muted, marginTop: 12 }}>This pay-out is no longer waiting ({String(p.status).toLowerCase()}).</div>}
          </>
        )}
      </div>
    </div>
  );
}
