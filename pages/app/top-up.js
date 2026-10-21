/**
 * WaPay personal portal: top up (2026-10-21). By card or Instant EFT on the
 * hosted PayFast page (the chat's deposit flow), back here after; a voucher
 * top-up only where the launch switches say it is live.
 */
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import Shell from '../../components/app/Shell.js';
import { AmountField, Chips, Icon, Kv, Notice, R, Rs, Spinner, api, parseRands, useBusy, useInterval } from '../../components/app/kit.js';

const PRESETS = [10000, 20000, 50000, 100000].map((c) => ({ key: c, label: Rs(c) }));

function Returned({ paymentId }) {
  const router = useRouter();
  const [state, setState] = useState('WAITING');
  const [amount, setAmount] = useState(null);
  const [tries, setTries] = useState(0);
  const check = async () => {
    const r = await api(`/api/app/topup?paid=${encodeURIComponent(paymentId)}`);
    setTries((n) => n + 1);
    if (r.ok) { setState(r.data.state); setAmount(r.data.amountCents); }
    else setState('UNKNOWN');
  };
  useEffect(() => { check(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useInterval(check, 4000, state === 'WAITING' && tries < 45);
  return (
    <div className="card center">
      <div className={`done-ic ${state === 'PAID' ? '' : 'wait'}`}><Icon name={state === 'PAID' ? 'check' : 'plus'} size={30} /></div>
      {state === 'PAID' && <p className="h1">{amount ? `${Rs(amount)} is in your balance` : 'Your top-up is in your balance'}</p>}
      {state === 'WAITING' && <p className="p">Waiting for PayFast to confirm your payment. This page updates by itself; your balance changes the moment the payment clears.</p>}
      {state === 'FAILED' && <p className="p">That payment did not go through, so nothing was added. You can try again.</p>}
      {state === 'UNKNOWN' && <p className="p">We could not find that payment. If you paid, your balance updates the moment it clears.</p>}
      <button type="button" className="btn" onClick={() => router.replace('/app')}>Back to home</button>
    </div>
  );
}

function TopUpScreen() {
  const router = useRouter();
  const [cfg, setCfg] = useState(null);
  const [amountText, setAmountText] = useState('');
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState('');
  const [busy, run] = useBusy();
  const amountCents = parseRands(amountText);
  const paid = typeof router.query.paid === 'string' ? router.query.paid : null;
  const cancelled = router.query.cancelled === '1';

  useEffect(() => { api('/api/app/topup').then((r) => r.ok && setCfg(r.data)); }, []);
  useEffect(() => {
    setQuote(null);
    if (!amountCents) return undefined;
    const t = setTimeout(() => api('/api/app/topup', { method: 'POST', body: { action: 'quote', amountCents } }).then((r) => setQuote(r.ok ? r.data : { error: r.data })), 300);
    return () => clearTimeout(t);
  }, [amountCents]);

  if (paid) return <Returned paymentId={paid} />;

  const go = () => {
    setError('');
    run(async () => {
      const r = await api('/api/app/topup', { method: 'POST', body: { action: 'card', amountCents } });
      if (!r.ok || !r.data.url) { setError(r.data.line || 'The payment page could not be opened just now. Please try again.'); return; }
      window.location.assign(r.data.url);
    });
  };

  return (
    <>
      <div className="top"><Link href="/app/pay" className="back"><Icon name="back" size={18} />Pay</Link></div>
      <p className="h1">Top up</p>
      <p className="p">Add money by card or Instant EFT. You pay on PayFast's secure page and come straight back here.</p>
      {cancelled ? <Notice tone="warn">The payment was cancelled, so nothing was charged.</Notice> : null}
      {!cfg ? <Spinner /> : (
        <>
          <div className="card">
            <AmountField value={amountText} onChange={setAmountText} label="Amount to add" />
            <Chips items={PRESETS} value={amountCents} onPick={(c) => setAmountText(String(c.key / 100))} />
            {quote && quote.ok ? (
              <>
                <Kv k="Added to your balance" v={R(quote.amountCents)} />
                <Kv k="Payment fee" v={R(quote.feeCents)} />
                <Kv k="You pay" v={R(quote.grossCents)} strong />
              </>
            ) : amountCents && quote?.error ? <Notice tone="error">{`Top-ups are between ${Rs(cfg.minCents)} and ${Rs(cfg.maxCents)}.`}</Notice> : null}
            <Notice tone="error">{error}</Notice>
            <button type="button" className="btn mt" disabled={busy || !(quote && quote.ok)} onClick={go}>{busy ? 'Opening PayFast…' : quote?.ok ? `Pay ${Rs(quote.grossCents)} by card or EFT` : 'Continue'}</button>
          </div>
          <h3>Other ways</h3>
          <div className="tiles">
            <div className={`tile ${cfg.voucher?.blu || cfg.voucher?.ott ? 'live' : 'soon'}`}>
              <span className="ic"><Icon name="ticket" size={22} /></span>Voucher<small>{cfg.voucher?.blu || cfg.voucher?.ott ? 'In the WaPay chat' : 'Coming soon'}</small>
            </div>
            <div className="tile soon"><span className="ic"><Icon name="store" size={22} /></span>Cash at a till<small>Coming soon</small></div>
            <div className="tile live"><span className="ic"><Icon name="in" size={22} /></span>Get paid<small><Link href="/app/get-paid">Make a link</Link></small></div>
          </div>
        </>
      )}
    </>
  );
}

export default function TopUp() {
  return (
    <Shell title="Top up" tab="pay">
      <TopUpScreen />
    </Shell>
  );
}
