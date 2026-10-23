/**
 * WaPay personal portal: log in with the WaPay cell number and PIN (2026-10-21).
 * Nothing about a customer is on this page; the PIN goes once to /api/app/auth.
 */
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import Shell from '../../components/app/Shell.js';
import { Banner, Field, Logo, Notice, PinField, api, loadSession, forgetSession, useBusy } from '../../components/app/kit.js';

const safeNext = (n) => (typeof n === 'string' && /^\/app(\/[a-z0-9-]*)?(\?[\w=&%.-]*)?$/i.test(n) ? n : '/app');

export default function Login() {
  const router = useRouter();
  const [cfg, setCfg] = useState(null);
  const [cell, setCell] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, run] = useBusy();

  useEffect(() => {
    loadSession(true).then((s) => {
      if (s.authed) router.replace(safeNext(router.query.next));
      else setCfg(s);
    });
  }, [router.isReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (e) => {
    e.preventDefault();
    setError('');
    if (!/^\+?[\d\s()-]{9,16}$/.test(cell.trim())) { setError('Type your WaPay cell number, like 083 123 4567.'); return; }
    if (!/^\d{4,6}$/.test(pin)) { setError('Your WaPay PIN is 4 to 6 digits.'); return; }
    run(async () => {
      const r = await api('/api/app/auth', { method: 'POST', body: { action: 'login', msisdn: cell, pin } });
      setPin('');
      if (r.ok) {
        forgetSession();
        router.replace(safeNext(router.query.next));
        return;
      }
      setError(r.data.line || (r.status === 429 ? 'Too many tries. Please wait 15 minutes.' : 'That did not work. Please try again.'));
    });
  };

  return (
    <Shell title="Log in" auth={false} nav={false}>
      <div className="center" style={{ marginTop: 40 }}>
        <Logo size={44} />
        <p className="p mt">Your money, on the web. Log in with your WaPay cell number and PIN.</p>
      </div>
      {cfg && cfg.fixture ? <div className="dev">Development fixture: cell {cfg.fixture.cell}, PIN {cfg.fixture.pin}. No real account or money.</div> : null}
      {cfg && cfg.configured === false ? <Notice tone="warn">The web portal is not switched on yet. Your money is safe; please try again later.</Notice> : null}
      <form className="card" onSubmit={submit} noValidate>
        <Field label="Cell number" id="cell" type="tel" inputMode="tel" autoComplete="username" placeholder="083 123 4567" value={cell} onChange={(e) => setCell(e.target.value)} />
        <PinField value={pin} onChange={setPin} autoComplete="current-password" />
        <Notice tone="error">{error}</Notice>
        <button className="btn mt" type="submit" disabled={busy}>{busy ? 'Checking…' : 'Log in'}</button>
        <p className="note">Forgot your PIN? <Link href="/app/forgot-pin"><b>Reset it with your ID number</b></Link></p>
      </form>
      <Banner banner={cfg?.banner} />
      <p className="note">{cfg?.pinSafety || 'WaPay never asks for your PIN by message.'} <Link href="/app/help">Help</Link></p>
    </Shell>
  );
}
