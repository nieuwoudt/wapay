/**
 * WaPay personal portal: forgot PIN (2026-10-21). The cell number and the ID
 * or passport number given for pay-outs, then the new PIN twice. No WhatsApp.
 */
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import Shell from '../../components/app/Shell.js';
import { Field, Logo, Notice, PinField, api, loadSession, forgetSession, useBusy, Icon } from '../../components/app/kit.js';

export default function ForgotPin() {
  const router = useRouter();
  const [cfg, setCfg] = useState(null);
  const [step, setStep] = useState('id');
  const [cell, setCell] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const [token, setToken] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, run] = useBusy();

  useEffect(() => { loadSession(true).then(setCfg); }, []);
  const support = cfg?.supportEmail || 'help@wapay.co.za';

  const check = (e) => {
    e.preventDefault();
    setError('');
    run(async () => {
      const r = await api('/api/app/forgot', { method: 'POST', body: { action: 'check', msisdn: cell, idNumber } });
      if (r.ok && r.data.resetToken) { setToken(r.data.resetToken); setIdNumber(''); setStep('pin'); return; }
      setError(r.data.line || 'That did not work. Please try again.');
    });
  };

  const save = (e) => {
    e.preventDefault();
    setError('');
    if (!/^\d{4,6}$/.test(pin)) { setError('A PIN is 4 to 6 digits.'); return; }
    if (pin !== pin2) { setError('Those two did not match. Type your new PIN twice.'); return; }
    run(async () => {
      const r = await api('/api/app/forgot', { method: 'POST', body: { action: 'reset', resetToken: token, pin, pinAgain: pin2 } });
      setPin(''); setPin2('');
      if (r.ok) { forgetSession(); setDone(r.data.line || 'Your new PIN is set.'); setStep('done'); return; }
      if (r.data.error === 'START_AGAIN') { setToken(''); setStep('id'); }
      setError(r.data.line || 'That did not work. Please try again.');
    });
  };

  return (
    <Shell title="Reset your PIN" auth={false} nav={false}>
      <div className="top"><Link href="/app/login" className="back"><Icon name="back" size={18} />Log in</Link><Logo size={26} text={false} /></div>
      <p className="h1">Reset your PIN</p>
      {step === 'id' && (
        <form className="card" onSubmit={check} noValidate>
          <p className="p">Type your WaPay cell number and the ID or passport number you gave WaPay for pay-outs (the whole number).</p>
          <Field label="Cell number" id="cell" type="tel" inputMode="tel" autoComplete="username" placeholder="083 123 4567" value={cell} onChange={(e) => setCell(e.target.value)} />
          <Field label="ID or passport number" id="idnum" autoComplete="off" spellCheck={false} placeholder="13-digit SA ID, or passport number" value={idNumber} onChange={(e) => setIdNumber(e.target.value.slice(0, 24))} />
          <Notice tone="error">{error}</Notice>
          <button className="btn" type="submit" disabled={busy || !cell || !idNumber}>{busy ? 'Checking…' : 'Continue'}</button>
        </form>
      )}
      {step === 'pin' && (
        <form className="card" onSubmit={save} noValidate>
          <Notice tone="ok">ID number confirmed. Now choose a new PIN: 4 to 6 digits, not an easy one like 1234 or 0000.</Notice>
          <PinField id="newpin" label="New PIN" value={pin} onChange={setPin} autoComplete="new-password" autoFocus />
          <PinField id="newpin2" label="New PIN again" value={pin2} onChange={setPin2} autoComplete="new-password" />
          <Notice tone="error">{error}</Notice>
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save my new PIN'}</button>
        </form>
      )}
      {step === 'done' && (
        <div className="card">
          <div className="done-ic"><Icon name="check" size={30} /></div>
          <p className="p center">{done}</p>
          <button className="btn" type="button" onClick={() => router.replace('/app')}>Go to my balance</button>
        </div>
      )}
      <div className="card">
        <p className="small" style={{ margin: 0, lineHeight: 1.5 }}>
          No ID number on file with WaPay? It is asked the first time you pay out. Without it the PIN cannot be reset here: e-mail <a href={`mailto:${support}`}>{support}</a> from any address with your cell number, or ask WaPay on WhatsApp once replies are back.
        </p>
      </div>
      <p className="note">WaPay never asks for your PIN by message.</p>
    </Shell>
  );
}
