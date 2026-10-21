/**
 * WaPay personal portal: send money (2026-10-21). Amount, then the cell
 * number, then the confirm with the PIN. Free; a member has it at once,
 * anyone else when they join (back to the sender after 30 days). The screen
 * reads the same either way.
 */
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import Shell from '../../components/app/Shell.js';
import { AmountField, Chips, Field, Icon, Kv, Notice, PinField, R, Rs, Spinner, api, parseRands, pinError, useBusy } from '../../components/app/kit.js';

const PRESETS = [5000, 10000, 20000, 50000].map((c) => ({ key: c, label: Rs(c) }));
const spaced = (n) => (String(n).length === 10 ? `${String(n).slice(0, 3)} ${String(n).slice(3, 6)} ${String(n).slice(6)}` : String(n));

function SendScreen() {
  const router = useRouter();
  const [cfg, setCfg] = useState(null);
  const [step, setStep] = useState('amount');
  const [amountText, setAmountText] = useState('');
  const [to, setTo] = useState('');
  const [preview, setPreview] = useState(null);
  const [pin, setPin] = useState('');
  const [done, setDone] = useState(null);
  const [error, setError] = useState('');
  const [busy, run] = useBusy();
  const amountCents = parseRands(amountText);

  useEffect(() => { api('/api/app/send').then((r) => r.ok && setCfg(r.data)); }, []);
  if (!cfg) return <Spinner />;

  const toWho = () => {
    setError('');
    if (!amountCents || amountCents < cfg.minCents || amountCents > cfg.maxCents) { setError(`You can send between ${Rs(cfg.minCents)} and ${Rs(cfg.maxCents)} at a time.`); return; }
    if (amountCents > cfg.balance.spendCents) { setError(`You have ${R(cfg.balance.spendCents)} available.`); return; }
    setStep('who');
  };

  const toConfirm = (e) => {
    e.preventDefault();
    setError('');
    run(async () => {
      const r = await api('/api/app/send', { method: 'POST', body: { action: 'preview', msisdn: to, amountCents } });
      if (!r.ok) { setError(r.data.line || 'That could not be checked just now. Please try again.'); return; }
      setPreview(r.data);
      setStep('confirm');
    });
  };

  const send = (e) => {
    e.preventDefault();
    setError('');
    if (!/^\d{4,6}$/.test(pin)) { setError('Type your WaPay PIN to confirm.'); return; }
    run(async () => {
      const step1 = await api('/api/app/pin', { method: 'POST', body: { purpose: 'send', intentId: preview.previewId, amountCents: preview.amountCents, pin } });
      setPin('');
      if (!step1.ok) { setError(step1.data?.error === 'EXPIRED' || step1.data?.error === 'NOT_FOUND' ? 'That confirmation timed out. Nothing was sent. Please start again.' : pinError(step1)); return; }
      const r = await api('/api/app/send', { method: 'POST', body: { action: 'execute', previewId: preview.previewId, proof: step1.data.proof } });
      if (!r.ok) { setError(r.data.line || 'That send did not go through. Nothing left your balance.'); return; }
      setDone(r.data);
      setStep('done');
    });
  };

  return (
    <>
      {step !== 'done' && <div className="top"><Link href="/app/pay" className="back"><Icon name="back" size={18} />Pay</Link></div>}
      {step === 'amount' && (
        <>
          <p className="h1">Send money</p>
          <p className="p">To any South African cell number. {cfg.ruleLine}</p>
          <div className="card">
            <AmountField value={amountText} onChange={setAmountText} autoFocus />
            <Chips items={PRESETS} value={amountCents} onPick={(c) => setAmountText(String(c.key / 100))} />
            <p className="small" style={{ margin: 0 }}>Available: {R(cfg.balance.spendCents)}</p>
            <Notice tone="error">{error}</Notice>
          </div>
          <div className="sticky"><button type="button" className="btn" disabled={!amountCents} onClick={toWho}>Continue</button></div>
        </>
      )}
      {step === 'who' && (
        <form onSubmit={toConfirm} noValidate>
          <p className="h1">Send {Rs(amountCents)} to who?</p>
          <div className="card">
            <Field label="Their cell number" id="to" type="tel" inputMode="tel" autoComplete="tel" placeholder="078 123 4567" value={to} onChange={(e) => setTo(e.target.value)} autoFocus />
            <Notice tone="error">{error}</Notice>
          </div>
          <div className="sticky"><button type="submit" className="btn" disabled={busy || !to}>{busy ? 'Checking…' : 'Continue'}</button></div>
          <button type="button" className="btn ghost mt" onClick={() => setStep('amount')}>Change the amount</button>
        </form>
      )}
      {step === 'confirm' && preview && (
        <form onSubmit={send} noValidate>
          <p className="h1">Send {Rs(preview.amountCents)} to {spaced(preview.recipient)}?</p>
          <p className="p">{preview.lines[1]} {preview.lines[2]}</p>
          <div className="card">
            <Kv k="Amount" v={R(preview.amountCents)} />
            <Kv k="Fee" v={R(preview.feeCents)} />
            <Kv k="Total" v={R(preview.totalCents)} strong />
            <Kv k="To" v={spaced(preview.recipient)} />
          </div>
          <div className="card">
            <PinField value={pin} onChange={setPin} label="Enter your WaPay PIN to send" autoFocus />
            <Notice tone="error">{error}</Notice>
            <button type="submit" className="btn" disabled={busy}>{busy ? 'Sending…' : `Send ${Rs(preview.amountCents)}`}</button>
          </div>
          <button type="button" className="btn ghost" onClick={() => { setPreview(null); setStep('who'); }}>Back</button>
        </form>
      )}
      {step === 'done' && done && (
        <div className="center">
          <div className="done-ic"><Icon name="check" size={30} /></div>
          <p className="h1">Sent {Rs(done.amountCents)} to {spaced(done.recipient)}</p>
          <p className="p">{done.lines[1]}</p>
          <div className="card"><Kv k="Your balance" v={R(done.newBalanceCents)} strong /></div>
          <button type="button" className="btn" onClick={() => router.replace('/app')}>Back to home</button>
        </div>
      )}
    </>
  );
}

export default function Send() {
  return (
    <Shell title="Send money" tab="pay">
      <SendScreen />
    </Shell>
  );
}
