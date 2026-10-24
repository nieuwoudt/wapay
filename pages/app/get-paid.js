/**
 * WaPay personal portal: get paid (2026-10-21). Amount, then what it is for
 * (required since 2026-10-24: the person paying reads it) and, for the
 * customer only, who owes it, then the confirm with the PIN, then the link to
 * share. Every link is tracked on /app/links. The link is an ordinary payment
 * request; the pay page settles it.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import Shell from '../../components/app/Shell.js';
import {
  AmountField, Chips, Field, Icon, Kv, Notice, PinField, R, Rs, Row, api, copyText, parseRands, pinError, shareOrCopy, shortDate, useBusy,
} from '../../components/app/kit.js';
import { DESCRIPTION_MAX, sanitizeLinkDescription, descriptionRefusal } from '../../lib/link-description.js';

const PRESETS = [10000, 25000, 50000, 100000].map((c) => ({ key: c, label: Rs(c) }));

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
  const [noteError, setNoteError] = useState('');
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
      if (!r.ok) {
        if (r.data.error === 'DESCRIPTION') { setNoteError(r.data.line || descriptionRefusal(r.data.reason)); setStep('who'); return; }
        setError(r.data.line || 'The link could not be made just now. Please try again.');
        if (r.data.error === 'NO_PROOF') setStep('who');
        return;
      }
      setMade(r.data);
      setStep('ready');
      loadLinks();
    });
  };

  // What it is for is checked here, before the PIN, with the same rules the server applies again.
  const toConfirm = (e) => {
    e.preventDefault();
    const d = sanitizeLinkDescription(note);
    if (!d.ok) { setNoteError(descriptionRefusal(d.reason)); return; }
    setNoteError('');
    setNote(d.text);
    setStep('confirm');
  };

  const share = async () => {
    const out = await shareOrCopy({ title: 'WaPay payment link', text: made.shareText, url: made.link.url });
    setMsg(out === 'copied' ? 'Copied. Paste it into a chat or SMS.' : out === 'shared' ? 'Shared.' : out === 'cancelled' ? '' : 'Could not share here. Use Copy link.');
  };

  const restart = () => { setStep('amount'); setAmountText(''); setLabel(''); setNote(''); setNoteError(''); setQuote(null); setMade(null); setMsg(''); setError(''); };
  const openCount = (links || []).filter((l) => l.status === 'OPEN').length;

  return (
    <>
      <div className="top"><Link href="/app/pay" className="back"><Icon name="back" size={18} />Pay</Link></div>
      {step === 'amount' && (
        <>
          <p className="h1">Get paid</p>
          <p className="p">How much, and what is it for? You get a link to forward.</p>
          <div className="card">
            <AmountField value={amountText} onChange={setAmountText} autoFocus />
            <Chips items={PRESETS} value={amountCents} onPick={(c) => setAmountText(String(c.key / 100))} />
            <Notice tone="error">{error}</Notice>
          </div>
          <div className="sticky"><button type="button" className="btn" disabled={busy || !amountCents} onClick={toWho}>Continue</button></div>
        </>
      )}
      {step === 'who' && quote && (
        <form onSubmit={toConfirm} noValidate>
          <p className="h1">What is the {Rs(quote.amountCents)} for?</p>
          <p className="p">The person paying sees it on the link. A few words is enough.</p>
          <div className="card">
            <Field label="What it is for (the payer sees this)" id="for" autoComplete="off" maxLength={DESCRIPTION_MAX + 20} placeholder="For example braids, or rent" value={note} onChange={(e) => { setNote(e.target.value); setNoteError(''); }} error={noteError} hint={`Up to ${DESCRIPTION_MAX} characters. No links or phone numbers.`} autoFocus />
            <Field label="Who owes you (optional, only you see this)" id="who" autoComplete="off" maxLength={40} placeholder="For example Thandi" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="sticky"><button type="submit" className="btn" disabled={!note.trim()}>Continue</button></div>
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
            <Kv k="For" v={note} />
            {label ? <Kv k="Who" v={label} /> : null}
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
          <p className="p">Send it to {made.link.label || 'whoever owes you'}. Share sends the message below, link included. Your links shows when it is paid.</p>
          <div className="card">
            <Kv k="Amount" v={R(made.link.amountCents)} />
            <Kv k="For" v={made.link.note || note} />
            <Kv k="You receive" v={`${R(made.quote.netBalanceCents)} from a balance, ${R(made.quote.netCardCents)} by card`} />
            <Kv k="Expires" v={shortDate(made.link.expiresAt)} />
            <div className="linkbox" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{made.shareText}</div>
            <button type="button" className="btn" onClick={share}><Icon name="share" size={18} />Share</button>
            <button type="button" className="btn ghost" onClick={async () => setMsg((await copyText(made.link.url)) ? 'Link copied.' : 'Could not copy here. Press and hold the link to copy it.')}><Icon name="copy" size={18} />Copy link</button>
            <Notice tone="ok">{msg}</Notice>
          </div>
          <Link href="/app/links" className="btn ghost">See your links</Link>
          <button type="button" className="btn ghost" onClick={restart}>Make another link</button>
        </>
      )}
      {step !== 'confirm' && (
        <>
          <h3>Your links</h3>
          <div className="card tight">
            <Row href="/app/links" icon="link" title="Your links" sub={links == null ? 'Status, reminders and cancel' : openCount ? `${openCount} open · status, reminders and cancel` : 'None open · see paid and past links'} right="›" />
          </div>
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
