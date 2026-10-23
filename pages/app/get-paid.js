/**
 * WaPay personal portal: get paid (2026-10-21). Amount, then who owes you,
 * then the confirm with the PIN, then the link to share. Below: open and paid
 * links. The link is an ordinary payment request; the pay page settles it.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import Shell from '../../components/app/Shell.js';
import {
  AmountField, Chips, Field, Icon, Kv, Notice, Pill, PinField, R, Rs, Row, Spinner, api, copyText, parseRands, pinError, shareOrCopy, shortDate, useBusy,
} from '../../components/app/kit.js';

const PRESETS = [10000, 25000, 50000, 100000].map((c) => ({ key: c, label: Rs(c) }));
const STATUS_PILL = { OPEN: ['Open', 'grey'], PAID: ['Paid', ''], EXPIRED: ['Expired', 'grey'], CANCELLED: ['Cancelled', 'grey'] };

function LinkList({ links, onCancel }) {
  if (!links) return <Spinner />;
  if (!links.length) return <p className="p" style={{ margin: '12px 0' }}>No links yet.</p>;
  return links.map((l) => (
    <Row
      key={l.code}
      icon="link"
      title={`${l.label ? `${l.label} · ` : ''}${Rs(l.amountCents)}`}
      sub={l.status === 'PAID' ? `Paid ${shortDate(l.paidAt)}${l.paidBy ? ` · ${l.paidBy}` : ''}` : l.status === 'OPEN' ? `Open until ${shortDate(l.expiresAt)} · ${l.code}` : `${STATUS_PILL[l.status]?.[0] || l.status} · ${l.code}`}
      right={l.status === 'OPEN' && onCancel
        ? <button type="button" className="btn ghost sm" onClick={() => onCancel(l)}>Cancel</button>
        : <Pill tone={STATUS_PILL[l.status]?.[1] || 'grey'}>{STATUS_PILL[l.status]?.[0] || l.status}</Pill>}
    />
  ));
}

function GetPaidScreen() {
  const [step, setStep] = useState('amount');
  const [amountText, setAmountText] = useState('');
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [quote, setQuote] = useState(null);
  const [pin, setPin] = useState('');
  const [made, setMade] = useState(null);
  const [links, setLinks] = useState(null);
  const [feeLine, setFeeLine] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, run] = useBusy();

  const amountCents = parseRands(amountText);
  const loadLinks = () => api('/api/app/links').then((r) => { if (r.ok) { setLinks(r.data.links); setFeeLine(r.data.feeLine || ''); } });
  useEffect(() => { loadLinks(); }, []);

  const toWho = () => {
    setError('');
    run(async () => {
      const r = await api('/api/app/links', { method: 'POST', body: { action: 'prepare', amountCents } });
      if (!r.ok) { setError(r.data.minCents ? `A link is between ${Rs(r.data.minCents)} and ${Rs(r.data.maxCents)}.` : 'Type an amount, like 250.'); return; }
      setQuote(r.data);
      setStep('who');
    });
  };

  const create = (e) => {
    e.preventDefault();
    setError('');
    if (!/^\d{4,6}$/.test(pin)) { setError('Type your WaPay PIN to confirm.'); return; }
    run(async () => {
      const step1 = await api('/api/app/pin', { method: 'POST', body: { purpose: 'link', intentId: quote.intentId, amountCents: quote.amountCents, pin } });
      setPin('');
      if (!step1.ok) { setError(pinError(step1)); return; }
      const r = await api('/api/app/links', { method: 'POST', body: { action: 'create', intentId: quote.intentId, amountCents: quote.amountCents, label, note, proof: step1.data.proof } });
      if (!r.ok) { setError(r.data.line || 'The link could not be made just now. Please try again.'); if (r.data.error === 'NO_PROOF') setStep('who'); return; }
      setMade(r.data);
      setStep('ready');
      loadLinks();
    });
  };

  const cancel = (l) => run(async () => {
    const r = await api('/api/app/links', { method: 'POST', body: { action: 'cancel', code: l.code } });
    setMsg(r.ok ? `The ${Rs(l.amountCents)} link is cancelled.` : 'That link could not be cancelled; it may already be paid.');
    loadLinks();
  });

  const share = async () => {
    const out = await shareOrCopy({ title: 'WaPay payment link', text: made.shareText, url: made.link.url });
    setMsg(out === 'copied' ? 'Copied. Paste it into a chat or SMS.' : out === 'shared' ? 'Shared.' : out === 'cancelled' ? '' : 'Could not share here. Use Copy link.');
  };

  const restart = () => { setStep('amount'); setAmountText(''); setLabel(''); setNote(''); setQuote(null); setMade(null); setMsg(''); setError(''); };

  return (
    <>
      <div className="top"><Link href="/app/pay" className="back"><Icon name="back" size={18} />Pay</Link></div>
      {step === 'amount' && (
        <>
          <p className="h1">Get paid</p>
          <p className="p">Who owes you, and how much? You get a link to forward.</p>
          <div className="card">
            <AmountField value={amountText} onChange={setAmountText} autoFocus />
            <Chips items={PRESETS} value={amountCents} onPick={(c) => setAmountText(String(c.key / 100))} />
            <Notice tone="error">{error}</Notice>
          </div>
          <div className="sticky"><button type="button" className="btn" disabled={busy || !amountCents} onClick={toWho}>Continue</button></div>
        </>
      )}
      {step === 'who' && quote && (
        <form onSubmit={(e) => { e.preventDefault(); setStep('confirm'); }}>
          <p className="h1">{Rs(quote.amountCents)} from who?</p>
          <p className="p">The name is only for you, to find the link later.</p>
          <div className="card">
            <Field label="Who owes you" id="who" autoComplete="off" maxLength={40} placeholder="For example Thandi" value={label} onChange={(e) => setLabel(e.target.value)} />
            <Field label="For (optional, the payer sees this)" id="for" autoComplete="off" maxLength={120} placeholder="For example Rent" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="sticky"><button type="submit" className="btn">Continue</button></div>
          <button type="button" className="btn ghost mt" onClick={() => setStep('amount')}>Change the amount</button>
        </form>
      )}
      {step === 'confirm' && quote && (
        <form onSubmit={create} noValidate>
          <p className="h1">Confirm your link</p>
          <div className="card">
            <Kv k="Amount" v={R(quote.amountCents)} strong />
            <Kv k="Paid from a WaPay balance, you get" v={R(quote.netBalanceCents)} />
            <Kv k={`Paid by card, you get (${Rs(quote.feeCents)} fee)`} v={R(quote.netCardCents)} />
            {label ? <Kv k="Who" v={label} /> : null}
            {note ? <Kv k="For" v={note} /> : null}
            <Kv k="Link lasts" v={`${quote.ttlDays} days`} />
          </div>
          {quote.askForFullCents ? <p className="note">Want {Rs(quote.amountCents)} even by card? Ask for {Rs(quote.askForFullCents)} instead.</p> : null}
          <div className="card">
            <PinField value={pin} onChange={setPin} label="Enter your WaPay PIN to make the link" autoFocus />
            <Notice tone="error">{error}</Notice>
            <button type="submit" className="btn" disabled={busy}>{busy ? 'Making your link…' : 'Create link'}</button>
          </div>
          <button type="button" className="btn ghost" onClick={() => setStep('who')}>Back</button>
        </form>
      )}
      {step === 'ready' && made && (
        <>
          <p className="h1">Your link is ready</p>
          <p className="p">Send it to {made.link.label || 'whoever owes you'}. You will see it here the moment it is paid.</p>
          <div className="card">
            <Kv k="Amount" v={R(made.link.amountCents)} />
            <Kv k="You receive" v={`${R(made.quote.netBalanceCents)} from a balance, ${R(made.quote.netCardCents)} by card`} />
            <Kv k="Expires" v={shortDate(made.link.expiresAt)} />
            <div className="linkbox"><Icon name="link" size={18} />{made.link.url}</div>
            <button type="button" className="btn" onClick={share}><Icon name="share" size={18} />Share</button>
            <button type="button" className="btn ghost" onClick={async () => setMsg((await copyText(made.link.url)) ? 'Link copied.' : 'Could not copy here. Press and hold the link to copy it.')}><Icon name="copy" size={18} />Copy link</button>
            <Notice tone="ok">{msg}</Notice>
          </div>
          <button type="button" className="btn ghost" onClick={restart}>Make another link</button>
        </>
      )}
      {step !== 'confirm' && (
        <>
          <h3>Your links</h3>
          {step !== 'ready' ? <Notice tone="ok">{msg}</Notice> : null}
          <div className="card tight"><LinkList links={links} onCancel={cancel} /></div>
          <p className="note">{feeLine || 'The person paying never pays a fee. Links last 7 days.'}</p>
        </>
      )}
    </>
  );
}

export default function GetPaid() {
  return (
    <Shell title="Get paid" tab="pay">
      <GetPaidScreen />
    </Shell>
  );
}
