/**
 * WaPay personal portal: pay out (2026-10-21). Where (a saved destination, or
 * new details by method), how much, then the confirm (amount, fee, total, the
 * destination's label, the PIN last). The rules are answered in the chat's own
 * words; an identity check opens Didit in this browser and the pay-out waits
 * for it. Nothing here holds a full account or ID number after it is sent.
 */
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import Shell from '../../components/app/Shell.js';
import { AmountField, Chips, Field, Icon, Kv, Notice, PinField, R, Rs, Spinner, api, parseRands, pinError, useBusy } from '../../components/app/kit.js';

const familyOf = (m) => (m === 'PAYSHAP' || m === 'RTC' ? 'BANK' : 'CASH');

function PayOutScreen() {
  const router = useRouter();
  const [ctx, setCtx] = useState(null);
  const [step, setStep] = useState('where');
  const [method, setMethod] = useState(null);
  const [dest, setDest] = useState(null); // a saved destination { id, label, ... }
  const [details, setDetails] = useState({ bank: '', accountNumber: '', mine: true, mobile: '' });
  const [amountText, setAmountText] = useState('');
  const [check, setCheck] = useState(null);
  const [ident, setIdent] = useState({ fullName: '', idNumber: '', countryOfIssue: '' });
  const [save, setSave] = useState(false);
  const [nickname, setNickname] = useState('');
  const [pin, setPin] = useState('');
  const [result, setResult] = useState(null);
  const [problem, setProblem] = useState(null); // { line, kyc }
  const [kycUrl, setKycUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, run] = useBusy();
  const amountCents = parseRands(amountText);

  const load = () => api('/api/app/payout').then((r) => { if (r.ok) setCtx(r.data); else setError('Pay-outs could not be loaded just now. Please try again.'); return r; });
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !ctx) return <Notice tone="error">{error}</Notice>;
  if (!ctx) return <Spinner />;
  const methods = ctx.methods || [];
  const m = methods.find((x) => x.method === method) || null;
  const passport = /[A-Za-z]/.test(ident.idNumber);

  const pickSaved = (d) => {
    const family = d.family || familyOf(d.method);
    const offered = methods.filter((x) => x.family === family);
    const exact = offered.find((x) => x.method === d.method);
    const choice = exact || offered.find((x) => x.method === 'PAYSHAP') || offered[0];
    if (!choice) { setError(`${family === 'BANK' ? 'Bank' : 'Cash'} pay-outs are not available right now.`); return; }
    setError(''); setDest(d); setMethod(choice.method); setStep('amount');
  };
  const pickNew = (x) => { setError(''); setDest(null); setMethod(x.method); setStep('details'); };

  const body = (extra = {}) => ({
    method,
    amountCents,
    destinationId: dest?.id || null,
    details: dest ? null : { bank: details.bank, accountNumber: details.accountNumber, mine: details.mine, mobile: details.mobile },
    identity: ident.fullName || ident.idNumber ? { fullName: ident.fullName || undefined, idNumber: ident.idNumber || undefined, countryOfIssue: passport ? ident.countryOfIssue : undefined } : null,
    ...extra,
  });

  const doCheck = () => {
    setError(''); setProblem(null);
    run(async () => {
      const r = await api('/api/app/payout', { method: 'POST', body: { action: 'check', ...body() } });
      if (!r.ok) {
        if (r.data.line) setProblem({ line: r.data.line, kyc: r.data.kyc?.canVerify && r.data.error === 'KYC_REQUIRED', error: r.data.error, maxNowCents: r.data.maxNowCents });
        else setError(r.data.error === 'BAD_ACCOUNT_NUMBER' ? 'Check the account number.' : r.data.error === 'BAD_BANK' ? 'Pick the bank.' : r.data.error === 'BAD_MOBILE' ? 'Check the cellphone number.' : 'That amount could not be checked. Please try again.');
        return;
      }
      setCheck(r.data);
      setStep('confirm');
    });
  };

  const confirm = (e) => {
    e.preventDefault();
    setError('');
    if (check.needs?.fullName && ident.fullName.trim().split(/\s+/).length < 2) { setError('Type your full name as on the account: first name and surname.'); return; }
    if (check.needs?.idNumber && !ident.idNumber) { setError('Type your ID or passport number.'); return; }
    if (check.needs?.idNumber && passport && !ident.countryOfIssue) { setError('Pick the country that issued the passport.'); return; }
    if (!/^\d{4,6}$/.test(pin)) { setError('Type your WaPay PIN to confirm.'); return; }
    run(async () => {
      const step1 = await api('/api/app/pin', { method: 'POST', body: { purpose: 'payout', intentId: check.intentId, amountCents: check.amountCents, pin } });
      setPin('');
      if (!step1.ok) { setError(pinError(step1)); return; }
      const r = await api('/api/app/payout', { method: 'POST', body: { action: 'request', intentId: check.intentId, ...body(), save, nickname: save ? nickname : null, proof: step1.data.proof, feeCents: check.feeCents } });
      if (r.ok) { setResult(r.data); setStep('done'); setIdent({ fullName: '', idNumber: '', countryOfIssue: '' }); setDetails({ bank: '', accountNumber: '', mine: true, mobile: '' }); return; }
      if (r.data.error === 'KYC_REQUIRED') { setProblem({ line: r.data.line, kyc: !!r.data.kyc?.canVerify, error: r.data.error }); setStep('amount'); return; }
      setError(r.data.line || 'The pay-out did not go through. Nothing has left your balance.');
    });
  };

  const startKyc = () => run(async () => {
    const r = await api('/api/app/payout', { method: 'POST', body: { action: 'kyc', pending: { amountCents, method, destinationId: dest?.id || null } } });
    if (r.ok && r.data.url) { setKycUrl(r.data.url); return; }
    setProblem({ line: r.data.line || 'The identity check could not start right now. Please try again a little later.' });
  });

  const afterKyc = () => run(async () => {
    const r = await load();
    if (r.ok && r.data.kyc?.verified) { setKycUrl(''); setProblem(null); doCheck(); return; }
    setProblem({ line: r.data?.kyc?.status === 'PENDING_REVIEW' ? 'Your identity check is being reviewed. The pay-out can continue the moment it clears.' : 'The identity check is not finished yet. Finish it in the other tab, then tap the button again.', kyc: true });
  });

  const resume = () => {
    const p = ctx.pending;
    const d = p.destinationId ? (ctx.saved || []).find((x) => x.id === p.destinationId) : null;
    setAmountText(String(p.amountCents / 100));
    if (d) { setDest(d); setMethod(p.method && methods.some((x) => x.method === p.method) ? p.method : methods.find((x) => x.family === (d.family || familyOf(d.method)))?.method || null); setStep('amount'); return; }
    if (p.method && methods.some((x) => x.method === p.method)) { setMethod(p.method); setStep('details'); return; }
    setStep('where');
  };
  const dismiss = () => run(async () => { await api('/api/app/payout', { method: 'POST', body: { action: 'dismiss' } }); load(); });

  if (!ctx.enabled) {
    return (
      <>
        <div className="top"><Link href="/app/pay" className="back"><Icon name="back" size={18} />Pay</Link></div>
        <p className="h1">Pay out</p>
        <Notice tone="warn">Pay-outs are not switched on for your account right now. Your money stays safe in your balance.</Notice>
      </>
    );
  }

  const header = (title, sub, backTo) => (
    <>
      <div className="top">{backTo ? <button type="button" className="back" onClick={() => { setError(''); setProblem(null); setStep(backTo); }}><Icon name="back" size={18} />Back</button> : <Link href="/app/pay" className="back"><Icon name="back" size={18} />Pay</Link>}</div>
      <p className="h1">{title}</p>
      {sub ? <p className="p">{sub}</p> : null}
    </>
  );

  return (
    <>
      {ctx.frozen ? <Notice tone="warn">{ctx.frozen.line}</Notice> : null}

      {step === 'where' && (
        <>
          {header('Pay out', `Where should the money go? You have ${R(ctx.balance.totalCents)} available.`)}
          {ctx.pending ? (
            <div className="card">
              <p className="p" style={{ margin: '0 0 10px' }}>{ctx.kyc.verified ? 'You are verified. ' : ''}Continue your pay-out of {Rs(ctx.pending.amountCents)}?</p>
              <div className="split"><button type="button" className="btn" onClick={resume}>Continue</button><button type="button" className="btn ghost" onClick={dismiss}>Not now</button></div>
            </div>
          ) : null}
          {ctx.kyc.required && !ctx.kyc.verified ? <Notice tone="warn">Withdrawals need a once-off identity check on your phone. Verify your ID to continue.</Notice> : null}
          {ctx.saved?.length ? (
            <>
              <h3>Saved</h3>
              {ctx.saved.map((d) => (
                <button key={d.id} type="button" className="opt" onClick={() => pickSaved(d)}>
                  <span className="ic"><Icon name={(d.family || familyOf(d.method)) === 'BANK' ? 'bank' : 'phone'} /></span>
                  <span className="m"><b>{d.label}</b><span>{(d.family || familyOf(d.method)) === 'BANK' ? 'Bank account' : 'Cash, code by SMS'}{d.timesUsed ? ` · used ${d.timesUsed} time${d.timesUsed === 1 ? '' : 's'}` : ''}</span></span>
                  <Icon name="chevron" size={18} />
                </button>
              ))}
            </>
          ) : null}
          {ctx.coolOff ? <Notice tone="warn">{ctx.coolOff.line}</Notice> : (
            <>
              <h3>{ctx.saved?.length ? 'Or new details' : 'How do you want it?'}</h3>
              {methods.map((x) => (
                <button key={x.method} type="button" className="opt" onClick={() => pickNew(x)} disabled={x.maxNowCents == null}>
                  <span className="ic"><Icon name={x.family === 'BANK' ? 'bank' : 'phone'} /></span>
                  <span className="m"><b>{x.label}</b><span>{`Fee from ${Rs(x.feeFromCents)} · from ${Rs(x.minCents)}`}{x.maxNowCents == null ? ` · needs ${Rs(x.minCents + x.feeFromCents)} with the fee` : ''}</span></span>
                  <Icon name="chevron" size={18} />
                </button>
              ))}
            </>
          )}
          <Notice tone="error">{error}</Notice>
          {ctx.rulesNote ? <p className="note">{ctx.rulesNote}</p> : null}
        </>
      )}

      {step === 'details' && m && (
        <form onSubmit={(e) => { e.preventDefault(); setStep('amount'); }} noValidate>
          {header(m.label, m.hint, 'where')}
          <div className="card">
            {m.family === 'BANK' ? (
              <>
                <div className="field">
                  <label className="lbl" htmlFor="bank">Bank</label>
                  <select id="bank" className="input" value={details.bank} onChange={(e) => setDetails({ ...details, bank: e.target.value })}>
                    <option value="">Pick your bank</option>
                    {ctx.banks.map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
                  </select>
                </div>
                <Field label="Account number" id="acc" inputMode="numeric" autoComplete="off" placeholder="Your account number" value={details.accountNumber} onChange={(e) => setDetails({ ...details, accountNumber: e.target.value.replace(/[^\d\s]/g, '').slice(0, 24) })} hint="It must be an account in your own name." />
              </>
            ) : (
              <>
                <label className="check"><input type="checkbox" checked={details.mine} onChange={(e) => setDetails({ ...details, mine: e.target.checked })} />Send the code to my own cell number</label>
                {!details.mine ? <Field label="Cell number for the SMS code" id="mob" type="tel" inputMode="tel" autoComplete="off" placeholder="078 123 4567" value={details.mobile} onChange={(e) => setDetails({ ...details, mobile: e.target.value })} /> : null}
                <p className="small" style={{ margin: 0 }}>The code comes by SMS. Cash comes in multiples of {Rs(m.stepCents)}.</p>
              </>
            )}
          </div>
          <div className="sticky"><button type="submit" className="btn" disabled={m.family === 'BANK' ? !details.bank || details.accountNumber.replace(/\D/g, '').length < 6 : !details.mine && !details.mobile}>Continue</button></div>
        </form>
      )}

      {step === 'amount' && m && (
        <>
          {header('How much?', `${dest ? dest.label : m.label}. Between ${Rs(m.minCents)} and ${Rs(m.maxCents)}${m.cash ? `, in multiples of ${Rs(m.stepCents)}` : ''}.`, dest ? 'where' : 'details')}
          <div className="card">
            <AmountField value={amountText} onChange={(v) => { setAmountText(v); setProblem(null); }} autoFocus />
            <Chips
              items={[...(m.maxNowCents ? [{ key: m.maxNowCents, label: 'Everything' }] : []), ...[100000, 200000].filter((c) => m.maxNowCents && c < m.maxNowCents && c >= m.minCents).map((c) => ({ key: c, label: Rs(c) }))]}
              value={amountCents}
              onPick={(c) => { setAmountText(String(c.key / 100)); setProblem(null); }}
            />
            <p className="small" style={{ margin: 0 }}>You have {R(ctx.balance.totalCents)}. The fee comes off your balance on top of the amount.</p>
          </div>
          {problem ? <Notice tone="warn">{problem.line}</Notice> : null}
          {problem?.kyc && !kycUrl ? <button type="button" className="btn" disabled={busy} onClick={startKyc}>Verify my ID</button> : null}
          {kycUrl ? (
            <div className="card">
              <p className="p" style={{ margin: '0 0 10px' }}>The identity check opens in a new tab and takes about two minutes. Your pay-out waits here.</p>
              <a className="btn" href={kycUrl} target="_blank" rel="noopener noreferrer">Open the secure identity check</a>
              <button type="button" className="btn ghost" disabled={busy} onClick={afterKyc}>I have finished, continue</button>
            </div>
          ) : null}
          <Notice tone="error">{error}</Notice>
          {!kycUrl ? <div className="sticky"><button type="button" className="btn" disabled={busy || !amountCents} onClick={doCheck}>{busy ? 'Checking…' : 'Continue'}</button></div> : null}
          {ctx.rulesNote ? <p className="note">{ctx.rulesNote}</p> : null}
        </>
      )}

      {step === 'confirm' && check && (
        <form onSubmit={confirm} noValidate>
          {header('Confirm your pay-out', null, 'amount')}
          <div className="card">
            <Kv k="Amount" v={R(check.amountCents)} />
            <Kv k="Fee" v={check.express ? `${R(check.feeCents)} (double the usual ${R(check.normalFeeCents)})` : R(check.feeCents)} />
            {check.feeNote ? <p className="note">{check.feeNote}</p> : null}
            <Kv k="Total from your balance" v={R(check.totalCents)} strong />
            <Kv k="To" v={`${check.destinationLabel} · ${check.methodLabel}`} />
            {check.nameOnAccount ? <Kv k="Name on the account" v={check.nameOnAccount} /> : null}
            {check.idLine ? <Kv k="ID" v={check.idLine.replace(/^(ID number|Passport \/ foreign ID): /, '')} /> : null}
            <Kv k="Balance after" v={R(check.balanceAfterCents)} />
          </div>
          {check.needs?.fullName || check.needs?.idNumber ? (
            <div className="card">
              <p className="small" style={{ margin: '0 0 10px' }}>The bank needs these once. They must match the account holder.</p>
              {check.needs.fullName ? <Field label="Full name as on the account" id="fn" autoComplete="name" value={ident.fullName} onChange={(e) => setIdent({ ...ident, fullName: e.target.value.slice(0, 80) })} /> : null}
              {check.needs.idNumber ? <Field label="SA ID number, or passport number" id="idn" autoComplete="off" spellCheck={false} value={ident.idNumber} onChange={(e) => setIdent({ ...ident, idNumber: e.target.value.slice(0, 24) })} /> : null}
              {check.needs.idNumber && passport ? (
                <div className="field">
                  <label className="lbl" htmlFor="cc">Country that issued the passport</label>
                  <select id="cc" className="input" value={ident.countryOfIssue} onChange={(e) => setIdent({ ...ident, countryOfIssue: e.target.value })}>
                    <option value="">Pick the country</option>
                    {ctx.countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                  </select>
                </div>
              ) : null}
            </div>
          ) : null}
          {check.canSave ? (
            <div className="card">
              <label className="check"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />Save these details for next time. They are stored encrypted, used only for your pay-outs, and you can remove them in Profile.</label>
              {save ? <Field label="Name them (optional)" id="nick" autoComplete="off" maxLength={24} placeholder="For example Mine" value={nickname} onChange={(e) => setNickname(e.target.value)} /> : null}
            </div>
          ) : null}
          <div className="card">
            <PinField value={pin} onChange={setPin} label="Enter your WaPay PIN to confirm" autoFocus={!check.needs?.fullName && !check.needs?.idNumber} />
            <Notice tone="error">{error}</Notice>
            <button type="submit" className="btn" disabled={busy}>{busy ? 'Paying out…' : 'Confirm pay-out'}</button>
          </div>
          <p className="note">{check.arrival}</p>
        </form>
      )}

      {step === 'done' && result && (
        <div className="center">
          <div className={`done-ic ${result.payoutStatus === 'SETTLED' ? '' : 'wait'}`}><Icon name={result.payoutStatus === 'SETTLED' ? 'check' : 'bank'} size={30} /></div>
          <p className="h1">{result.payoutStatus === 'SETTLED' ? 'Sent' : 'On its way'}</p>
          {result.lines.map((l) => <p key={l} className="p">{l}</p>)}
          {result.steps?.length ? <div className="card" style={{ textAlign: 'left' }}>{result.steps.map((s) => <p key={s} className="small" style={{ margin: '0 0 6px', color: 'var(--ink)' }}>{s}</p>)}</div> : null}
          <div className="card" style={{ textAlign: 'left' }}>
            <Kv k="Reference" v={result.reference} />
            {result.feeCents != null ? <Kv k="Fee" v={R(result.feeCents)} /> : null}
            {result.newBalanceCents != null ? <Kv k="Balance now" v={R(result.newBalanceCents)} /> : null}
            {result.saved ? <Kv k="Saved as" v={result.saved.label} /> : null}
          </div>
          <button type="button" className="btn" onClick={() => router.replace('/app')}>Back to home</button>
          <button type="button" className="btn ghost" onClick={() => router.push('/app/activity')}>See activity</button>
        </div>
      )}
    </>
  );
}

export default function PayOut() {
  return (
    <Shell title="Pay out" tab="pay">
      <PayOutScreen />
    </Shell>
  );
}
