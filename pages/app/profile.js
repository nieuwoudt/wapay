/**
 * WaPay personal portal: profile (2026-10-21). Who you are, the ID check,
 * saved pay-out details (labels only, remove), the invite link, change PIN,
 * help and log out.
 */
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import Shell from '../../components/app/Shell.js';
import { Banner, Icon, Kv, Notice, Pill, PinField, Row, Spinner, api, copyText, forgetSession, longDate, shareOrCopy, useBusy } from '../../components/app/kit.js';

const KYC_PILL = { VERIFIED: ['Verified', ''], PENDING: ['Started', 'amber'], PENDING_REVIEW: ['In review', 'amber'], DECLINED: ['Not passed', 'red'], EXPIRED: ['Not finished', 'grey'], NONE: ['Not yet', 'grey'] };

function ProfileScreen() {
  const router = useRouter();
  const [p, setP] = useState(null);
  const [msg, setMsg] = useState({ tone: 'ok', text: '' });
  const [invite, setInvite] = useState(null);
  const [kycUrl, setKycUrl] = useState('');
  const [pinOpen, setPinOpen] = useState(false);
  const [cur, setCur] = useState('');
  const [n1, setN1] = useState('');
  const [n2, setN2] = useState('');
  const [busy, run] = useBusy();

  const load = () => api('/api/app/profile').then((r) => r.ok && setP(r.data));
  useEffect(() => { load(); }, []);
  if (!p) return <Spinner />;

  const say = (text, tone = 'ok') => setMsg({ text, tone });
  const remove = (d) => run(async () => {
    if (!window.confirm(`Remove ${d.label} from your saved pay-out details?`)) return;
    const r = await api('/api/app/profile', { method: 'POST', body: { action: 'remove', id: d.id } });
    say(r.ok ? `${d.label} is removed.` : 'That could not be removed just now.', r.ok ? 'ok' : 'error');
    load();
  });
  const forgetAll = () => run(async () => {
    if (!window.confirm('Erase every saved pay-out detail and the ID number on file? Without an ID number on file, a forgotten PIN cannot be reset on the web.')) return;
    const r = await api('/api/app/profile', { method: 'POST', body: { action: 'forget' } });
    say(r.ok ? 'Your saved pay-out details and ID number are erased.' : 'That could not be done just now.', r.ok ? 'ok' : 'error');
    load();
  });
  const getInvite = () => run(async () => {
    const r = await api('/api/app/profile', { method: 'POST', body: { action: 'invite' } });
    if (r.ok) setInvite(r.data); else say('Your invite link could not be made just now.', 'error');
  });
  const verify = () => run(async () => {
    const r = await api('/api/app/profile', { method: 'POST', body: { action: 'verify' } });
    if (r.ok && r.data.url) setKycUrl(r.data.url); else say(r.data.line || 'The identity check could not start right now.', 'error');
  });
  const changePin = (e) => {
    e.preventDefault();
    if (!/^\d{4,6}$/.test(cur) || !/^\d{4,6}$/.test(n1)) { say('A PIN is 4 to 6 digits.', 'error'); return; }
    if (n1 !== n2) { say('The two new PINs did not match.', 'error'); return; }
    run(async () => {
      const r = await api('/api/app/profile', { method: 'POST', body: { action: 'pin', currentPin: cur, newPin: n1, newPinAgain: n2 } });
      setCur(''); setN1(''); setN2('');
      if (r.ok) { setPinOpen(false); say('Your PIN is changed. Use the new one in WhatsApp and here.'); return; }
      say(r.data.line || (r.data.error === 'WRONG_PIN' ? 'That is not your current PIN, so nothing changed.' : 'Your PIN could not be changed just now.'), 'error');
    });
  };
  const logout = () => run(async () => {
    await api('/api/app/auth', { method: 'POST', body: { action: 'logout' } });
    forgetSession();
    router.replace('/app/login');
  });

  const pill = KYC_PILL[p.kyc?.status] || KYC_PILL.NONE;
  return (
    <>
      <div className="center">
        <div className="avatar lg">{p.initials}</div>
        <p className="h1">{p.name || 'Your WaPay'}</p>
        <p className="p">{p.cell} · member since {longDate(p.memberSince)}</p>
      </div>
      <Notice tone={msg.tone}>{msg.text}</Notice>
      <div className="card tight" id="verify">
        <div className="kv">
          <span>ID check</span>
          <span>{p.kyc?.canVerify && !kycUrl ? <button type="button" className="pill grey" style={{ border: 0, cursor: 'pointer' }} onClick={verify}>{pill[0]} · Verify</button> : <Pill tone={pill[1]}>{pill[0]}</Pill>}</span>
        </div>
        {kycUrl ? <div style={{ padding: '4px 0 12px' }}><a className="btn" href={kycUrl} target="_blank" rel="noopener noreferrer">Open the secure identity check</a></div> : null}
        <Kv k="Language" v={p.language} />
        <div className="kv">
          <span>Invite a friend</span>
          <span>{invite ? <button type="button" className="pill" style={{ border: 0, cursor: 'pointer' }} onClick={async () => { const out = await shareOrCopy({ title: 'Join me on WaPay', text: invite.message, url: invite.link }); say(out === 'copied' ? 'Invite copied. Paste it to a friend.' : out === 'shared' ? 'Shared.' : ''); }}>Share</button> : <button type="button" className="pill grey" style={{ border: 0, cursor: 'pointer' }} onClick={getInvite}>Get my link</button>}</span>
        </div>
        {invite || p.invite ? <div className="linkbox" style={{ marginTop: 0 }}><Icon name="link" size={16} />{(invite || p.invite).link}<button type="button" className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={async () => say((await copyText((invite || p.invite).link)) ? 'Link copied.' : 'Could not copy here.')}>Copy</button></div> : null}
        <div className="kv"><span>Change PIN</span><span><button type="button" className="pill grey" style={{ border: 0, cursor: 'pointer' }} onClick={() => setPinOpen((x) => !x)}>{pinOpen ? 'Close' : 'Change'}</button></span></div>
        {pinOpen ? (
          <form onSubmit={changePin} style={{ padding: '6px 0 12px' }} noValidate>
            <PinField id="cur" label="Current PIN" value={cur} onChange={setCur} autoComplete="current-password" />
            <PinField id="n1" label="New PIN" value={n1} onChange={setN1} autoComplete="new-password" />
            <PinField id="n2" label="New PIN again" value={n2} onChange={setN2} autoComplete="new-password" />
            <button type="submit" className="btn" disabled={busy}>Save new PIN</button>
          </form>
        ) : null}
      </div>
      <h3>Saved pay-out details</h3>
      <div className="card tight">
        {p.destinations.length ? p.destinations.map((d) => (
          <Row key={d.id} icon={d.family === 'BANK' ? 'bank' : 'phone'} title={d.label} sub={d.family === 'BANK' ? 'Bank account' : 'Cellphone for cash codes'} right={<button type="button" className="btn ghost sm" onClick={() => remove(d)}>Remove</button>} />
        )) : <p className="p" style={{ margin: '12px 0' }}>Nothing saved. You can save details after a pay-out.</p>}
        {p.identity ? <Row icon="lock" title={`${p.identity.idType === 'PASSPORT' ? 'Passport' : 'ID number'} •••${p.identity.idLast3}`} sub="On file for pay-outs and PIN reset" /> : null}
      </div>
      {p.destinations.length || p.identity ? <button type="button" className="btn danger" disabled={busy} onClick={forgetAll}>Erase all saved details</button> : null}
      <h3>Help</h3>
      <div className="card">
        <Banner banner={p.banner} />
        <p className="small" style={{ margin: 0, lineHeight: 1.5 }}>Support: <a href={`mailto:${p.supportEmail}`}>{p.supportEmail}</a>. {p.pinSafety}</p>
        <p className="small" style={{ margin: '8px 0 0' }}><Link href="/app/help">What you can do here</Link></p>
      </div>
      <button type="button" className="btn ghost" disabled={busy} onClick={logout}><Icon name="out" size={18} />Log out</button>
    </>
  );
}

export default function Profile() {
  return (
    <Shell title="Profile" tab="profile">
      <ProfileScreen />
    </Shell>
  );
}
