/**
 * /ops/payout?token=… — the tap-to-pay page for one operator pay-out
 * (lib/ops-link.js). Shows the dry run, one button, then the result.
 */
import { useEffect, useState } from 'react';
import Head from 'next/head';

const R = (c) => `R${(Number(c || 0) / 100).toFixed(2)}`;

export default function OpsPayoutPage() {
  const [token, setToken] = useState('');
  const [dry, setDry] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('token') || '';
    setToken(t);
    if (!t) { setErr('No link token.'); return; }
    fetch(`/api/ops/payout-link?token=${encodeURIComponent(t)}`).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.reason === 'EXPIRED' ? 'This link has expired. Ask for a new one.' : 'This link is not valid.'); return; }
      setDry(j);
    }).catch(() => setErr('Could not load the pay-out.'));
  }, []);

  async function pay() {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/ops/payout-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
      const j = await r.json().catch(() => ({}));
      setResult(j);
      if (!r.ok && !j.result) setErr(j.error ? `Refused: ${j.error}` : 'The pay-out was refused.');
    } catch { setErr('The request failed. Check the result before trying again.'); }
    setBusy(false);
  }

  const s = { page: { fontFamily: 'Inter, system-ui, sans-serif', background: '#F4F6F8', minHeight: '100vh', margin: 0, padding: '24px 16px', color: '#111827' }, card: { background: '#fff', borderRadius: 16, padding: 18, maxWidth: 420, margin: '0 auto 12px', boxShadow: '0 1px 2px rgba(0,0,0,.05)' }, kv: { display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #E5E7EB', fontSize: 15 }, btn: { display: 'block', width: '100%', padding: 16, borderRadius: 14, border: 0, background: '#359853', color: '#fff', fontWeight: 700, fontSize: 17, marginTop: 14 }, muted: { color: '#6B7280', fontSize: 13 } };
  const q = dry?.quote; const ok = dry?.ok && !result;
  return (
    <div style={s.page}>
      <Head><title>WaPay ops · pay-out</title><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="robots" content="noindex" /></Head>
      <div style={s.card}>
        <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 6 }}>Operator pay-out</div>
        {err && <div style={{ background: '#FEF2F2', color: '#991B1B', padding: 12, borderRadius: 12, marginBottom: 10 }}>{err}</div>}
        {!dry && !err && <div style={s.muted}>Loading the dry run…</div>}
        {dry && (
          <>
            <div style={s.kv}><span>Customer</span><span>{dry.account?.name || '—'} ({dry.account?.phone})</span></div>
            <div style={s.kv}><span>To</span><span>{dry.destination?.label} · {q?.label}</span></div>
            <div style={s.kv}><span>Amount</span><span>{R(q?.amountCents)}</span></div>
            <div style={s.kv}><span>Fee</span><span>{R(q?.feeCents)}</span></div>
            <div style={s.kv}><span>Balance now</span><span>{R(dry.balances?.totalCents)}</span></div>
            <div style={s.kv}><span>ID on file</span><span>{dry.identity ? `${dry.identity.idType} •••${dry.identity.idLast3}` : 'none'}</span></div>
            <div style={s.kv}><span>Float</span><span>{R(dry.float?.balanceCents)}</span></div>
            <div style={{ ...s.kv, borderBottom: 0 }}><span>Checks</span><span>{dry.blockers?.length ? dry.blockers.join(', ') : 'all clear'}</span></div>
            <div style={s.muted}>By {dry.link?.by}: {dry.link?.reason}</div>
          </>
        )}
        {ok && <button style={{ ...s.btn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={pay}>{busy ? 'Paying…' : `Pay ${R(q?.amountCents)} now`}</button>}
        {dry && !dry.ok && !result && <div style={{ ...s.muted, marginTop: 10 }}>Nothing can be paid from this link while a check fails.</div>}
      </div>
      {result && (
        <div style={s.card}>
          <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 6 }}>{result.ok ? '✅ Sent' : '❌ Not sent'}</div>
          <div style={s.kv}><span>Status</span><span>{result.result?.status || result.error || '—'}</span></div>
          <div style={s.kv}><span>Reference</span><span>{result.result?.reference || '—'}</span></div>
          <div style={{ ...s.kv, borderBottom: 0 }}><span>Rail says</span><span>{result.result?.error || result.result?.providerRef || '—'}</span></div>
          <div style={s.muted}>A second tap returns this same result; it cannot pay twice.</div>
        </div>
      )}
    </div>
  );
}
