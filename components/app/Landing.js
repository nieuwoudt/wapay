/**
 * The WaPay landing screen (2026-11-24): one screen for everyone. The W-mark,
 * a greeting, a message box and the pill menu; a member sees their balance and
 * the everyday jobs one tap away, someone who is not signed in is told what
 * WaPay does and can log in, pay a link or go and open an account.
 *
 * Everything here is answered by code. What is typed in the message box is
 * read on this page by lib/app-chat-router.js and goes nowhere: this screen
 * posts only the log-in (the cell number and the PIN from the PIN boxes) and
 * the log-out. A line shaped like a PIN, an ID or an account number is never
 * shown back and never sent (docs/GOLDEN_THREAD.md 2.13). No model is called
 * and no WhatsApp message is sent; "Open an account" opens the person's own
 * WhatsApp with a message ready, so the customer writes first.
 *
 * What it says about WaPay comes from the server (/api/app/guide, the ad
 * flow's own answers), never from wording typed into this file.
 */
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import Shell from './Shell.js';
import { ActivityRow, Banner, Field, Icon, Notice, Pill, PinField, R, Row, Rs, Spinner, api, forgetSession, loadSession, shortDate, useBusy } from './kit.js';
import { SECRET_LINE, greetingFor, payLinkCodeOf, routeMessage } from '../../lib/app-chat-router.js';

const safeNext = (n) => (typeof n === 'string' && /^\/app(\/[a-z0-9-]*)?(\?[\w=&%.-]*)?$/i.test(n) ? n : '/app');

// The only two things kept in this browser: the hide-balance choice and a dismissed install hint.
const HIDE_KEY = 'wapay_app_hide_balance';
const INSTALL_KEY = 'wapay_app_install_dismissed';
const keep = {
  get(k) { try { return window.localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch { /* private window: the choice lasts for this visit */ } },
};

const MEMBER_CHIPS = [
  { href: '/app/get-paid', label: 'Get paid' },
  { href: '/app/send', label: 'Send' },
  { href: '/app/pay-out', label: 'Pay out' },
  { href: '/app/top-up', label: 'Top up' },
  { href: '/app/links', label: 'My links' },
];
const VISITOR_CHIPS = [
  { act: { kind: 'open' }, label: 'Open an account', go: true },
  { act: { kind: 'paylink-ask' }, label: 'Pay a link' },
  { act: { kind: 'answer', topic: 'about' }, label: 'What is WaPay?' },
  { act: { kind: 'login' }, label: 'Log in' },
];

const NOT_LOADED = 'WaPay could not load that just now. Check your connection and try again.';

function BalanceCard({ home }) {
  const b = home.balance;
  return (
    <section className="card balance" aria-label="Balance">
      <p className="t">Available balance</p>
      <p className="amt">{R(b.totalCents)}</p>
      <div className="sub">
        <span>Spend {R(b.spendCents)}</span>
        <span>Cash {R(b.cashCents)}</span>
        {b.heldCents > 0 ? <span>Held for a pay-out {R(b.heldCents)}</span> : null}
        {home.kyc?.nudge ? <Link href="/app/profile#verify" className="pill grey">Verify ID to lift limits</Link> : null}
        {home.kyc?.status === 'PENDING_REVIEW' ? <Pill tone="amber">ID check in review</Pill> : null}
      </div>
      {!home.payoutsOn ? <p className="small" style={{ margin: '10px 0 0' }}>Pay-outs are not switched on for your account right now.</p> : null}
    </section>
  );
}

function RecentCard({ home }) {
  return (
    <section className="card tight" aria-label="Recent activity">
      {home.recent?.length
        ? home.recent.map((it) => <ActivityRow key={it.id} item={it} />)
        : <p className="p" style={{ margin: '12px 0' }}>Nothing yet. Get paid with a link, or top up by card.</p>}
      <Row href="/app/activity" icon="activity" title="See all activity" right="›" />
    </section>
  );
}

function LinksCard({ links }) {
  const open = links.filter((l) => l.status === 'OPEN');
  return (
    <section className="card tight" aria-label="Payment links">
      {open.length
        ? open.slice(0, 3).map((l) => <Row key={l.code} href="/app/links" icon="link" title={`${Rs(l.amountCents)}${l.note ? ` for ${l.note}` : ''}`} sub={`Open until ${shortDate(l.expiresAt)} · ${l.code}`} right={<Pill tone="amber">Open</Pill>} />)
        : <Row href="/app/links" icon="link" title="No open links" sub="See paid links, or make a new one" right="›" />}
      {open.length > 3 ? <Row href="/app/links" icon="link" title={`${open.length - 3} more open`} sub="Reminders and cancel on Your links" right="›" /> : null}
      <Row href="/app/get-paid" icon="in" title="Make a new link" right="›" />
    </section>
  );
}

/** The log-in step: the cell number, then the PIN in the PIN boxes. The same screen and answer for every number. */
function LoginCard({ cfg, guide, cell: startCell, onDone }) {
  const [cell, setCell] = useState(startCell || '');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, run] = useBusy();

  const submit = (e) => {
    e.preventDefault();
    setError('');
    if (!/^\+?[\d\s()-]{9,16}$/.test(cell.trim())) { setError('Type your WaPay cell number, like 083 123 4567.'); return; }
    if (!/^\d{4,6}$/.test(pin)) { setError('Your WaPay PIN is 4 to 6 digits.'); return; }
    run(async () => {
      const r = await api('/api/app/auth', { method: 'POST', body: { action: 'login', msisdn: cell, pin } });
      setPin('');
      if (r.ok) { forgetSession(); onDone(); return; }
      setError(r.data.line || (r.status === 429 ? 'Too many tries. Please wait 15 minutes.' : 'That did not work. Please try again.'));
    });
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label="Log in">
      {cfg.fixture ? <div className="dev">Development fixture: cell {cfg.fixture.cell}, PIN {cfg.fixture.pin}. No real account or money.</div> : null}
      {cfg.configured === false ? <Notice tone="warn">The web portal is not switched on yet. Your money is safe; please try again later.</Notice> : null}
      <Field label="Cell number" id="cell" type="tel" inputMode="tel" autoComplete="username" placeholder="083 123 4567" value={cell} onChange={(e) => setCell(e.target.value)} />
      <PinField value={pin} onChange={setPin} autoComplete="current-password" autoFocus={!!startCell} />
      <Notice tone="error">{error}</Notice>
      <button className="btn mt" type="submit" disabled={busy}>{busy ? 'Checking…' : 'Log in'}</button>
      <p className="note">Forgot your PIN? <Link href="/app/forgot-pin"><b>Reset it with your ID number</b></Link></p>
      {guide?.open ? <p className="note">New to WaPay? <a href={guide.open.url} target="_blank" rel="noopener noreferrer"><b>Open an account</b></a></p> : null}
      <p className="note">{cfg.pinSafety || 'WaPay never asks for your PIN by message.'} <Link href="/app/help">Help</Link></p>
    </form>
  );
}

export default function Landing({ mode = 'home' }) {
  const router = useRouter();
  const [cfg, setCfg] = useState(null);
  const [guide, setGuide] = useState(null);
  const [home, setHome] = useState(null);
  const [homeFailed, setHomeFailed] = useState(false);
  const [thread, setThread] = useState([]);
  const [text, setText] = useState('');
  const [login, setLogin] = useState(mode === 'login' ? { cell: '' } : null);
  const [hide, setHide] = useState(false);
  const [menu, setMenu] = useState(false);
  const [tip, setTip] = useState('');
  const [install, setInstall] = useState(null);
  const [hello, setHello] = useState('');
  const seq = useRef(0);
  const boxRef = useRef(null);
  const endRef = useRef(null);

  const authed = !!cfg?.authed;
  const push = (...items) => setThread((cur) => [...cur, ...items.map((it) => ({ id: (seq.current += 1), ...it }))]);
  const say = (line, extra = {}) => push({ who: 'wa', text: line || NOT_LOADED, ...extra });

  const loadHome = async () => {
    const r = await api('/api/app/home');
    if (r.ok) { setHome(r.data); setHomeFailed(false); return r.data; }
    setHomeFailed(true);
    return null;
  };

  // Who is here, and what the screen may say about WaPay.
  useEffect(() => {
    if (!router.isReady) return;
    loadSession(true).then((s) => {
      if (s.authed && mode === 'login') { router.replace(safeNext(router.query.next)); return; }
      setCfg(s);
      if (s.authed) { setLogin(null); loadHome(); }
    });
    api('/api/app/guide').then((r) => { if (r.ok) setGuide(r.data.guide); });
    setHide(keep.get(HIDE_KEY) === '1');
  }, [router.isReady]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setHello(greetingFor(new Date(), cfg?.me?.firstName)); }, [cfg]);
  useEffect(() => { if (thread.length || login) endRef.current?.scrollIntoView({ block: 'end' }); }, [thread.length, login]);
  useEffect(() => { if (!tip) return undefined; const t = setTimeout(() => setTip(''), 6000); return () => clearTimeout(t); }, [tip]);

  // The home-screen hint: Android offers its own prompt, an iPhone needs telling where the button is.
  useEffect(() => {
    if (keep.get(INSTALL_KEY)) return undefined;
    if (window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true) return undefined;
    const onPrompt = (e) => { e.preventDefault(); setInstall({ kind: 'prompt', event: e }); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    const ua = window.navigator.userAgent || '';
    if (/iphone|ipad|ipod/i.test(ua) && /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua)) setInstall({ kind: 'ios' });
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);
  const dismissInstall = () => { keep.set(INSTALL_KEY, '1'); setInstall(null); };
  const addToHome = async () => { try { await install.event.prompt(); } catch { /* the phone declined */ } dismissInstall(); };

  const toggleHide = () => setHide((h) => { keep.set(HIDE_KEY, h ? '0' : '1'); return !h; });
  const openPayLink = (code) => { say('Opening that payment link.'); window.location.assign(`/pay/${code}`); };

  const afterLogin = async () => {
    const next = router.query.next;
    if (next) { router.replace(safeNext(next)); return; }
    const s = await loadSession(true);
    setCfg(s);
    setLogin(null);
    setThread([]);
    if (s.authed) loadHome();
    if (mode === 'login') router.replace('/app');
  };

  const logout = async () => {
    await api('/api/app/auth', { method: 'POST', body: { action: 'logout' } });
    forgetSession();
    setHome(null);
    setThread([]);
    setCfg(await loadSession(true));
  };

  /** Do what the router decided. Nothing typed is passed to the server from here. */
  const act = async (r) => {
    setMenu(false);
    if (r.kind === 'paylink') { openPayLink(r.code); return; }
    if (r.kind === 'page') { router.push(r.href); return; }
    if (r.kind === 'logout') { logout(); return; }
    if (r.kind === 'thanks') { say("You're welcome."); return; }
    if (authed) {
      if (r.kind === 'card' && r.card === 'links') {
        const got = await api('/api/app/links');
        if (got.ok) push({ who: 'wa', card: 'links', links: got.data.links || [] }); else say(NOT_LOADED);
        return;
      }
      if (r.kind === 'card') {
        const h = home || (await loadHome());
        if (h) push({ who: 'wa', card: r.card, home: h }); else say('Your balance could not be loaded just now. Please try again in a moment.');
        return;
      }
      if (r.kind === 'answer') { say(guide?.member?.[r.topic]); return; }
      if (r.kind === 'vas') {
        const tile = (home?.tiles || []).find((x) => x.id === r.product);
        say(tile ? `${tile.label}: ${tile.note.charAt(0).toLowerCase()}${tile.note.slice(1)}.` : guide?.member?.vas);
        return;
      }
      say(guide?.memberFallback);
      return;
    }
    if (r.kind === 'cell') { setLogin({ cell: r.cell }); return; }
    if (r.kind === 'login') { setLogin({ cell: '' }); return; }
    if (r.kind === 'open') { say(guide?.open?.line, { actions: ['open'] }); return; }
    if (r.kind === 'paylink-ask') { say(guide?.payLink); boxRef.current?.focus(); return; }
    if (r.kind === 'answer') { say(guide?.visitor?.[r.topic], { actions: ['open'] }); return; }
    if (r.kind === 'greet') { say(guide ? `Welcome to WaPay. ${guide.line}` : null, { actions: ['open', 'login'] }); return; }
    say(guide?.fallback, { actions: ['open', 'login'] });
  };

  const onSubmit = (e) => {
    e.preventDefault();
    const typed = text.trim();
    if (!typed) return;
    setText('');
    const r = routeMessage(typed, { authed });
    // A secret is never shown back and never leaves this page.
    if (r.kind === 'secret') { push({ who: 'me', text: '•••' }, { who: 'wa', text: SECRET_LINE }); return; }
    if (r.kind !== 'cell') push({ who: 'me', text: typed });
    act(r);
  };

  const onPlus = async () => {
    let clip = '';
    try { clip = navigator.clipboard?.readText ? await navigator.clipboard.readText() : ''; } catch { clip = ''; }
    const code = payLinkCodeOf(clip);
    if (code) { openPayLink(code); return; }
    say(guide?.payLink);
    boxRef.current?.focus();
  };
  const onMic = () => { setTip("Tap the microphone on your keyboard to speak. WaPay records no audio."); boxRef.current?.focus(); };

  const chatting = thread.length > 0 || !!login;
  const b = home?.balance;

  return (
    <Shell title={authed ? 'Chat' : 'Welcome'} tab="chat" auth={false} locked={!authed} onLocked={() => say(guide?.locked, { actions: ['open', 'login'] })}>
      {!cfg ? <Spinner /> : (
        <div className="land">
          <div className="bar">
            <button type="button" className="round" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}><Icon name="menu" /></button>
            {authed ? <button type="button" className="round" aria-label={hide ? 'Show balance' : 'Hide balance'} onClick={toggleHide}><Icon name={hide ? 'eyeoff' : 'eye'} /></button> : <span />}
            {menu ? (
              <div className="menu" role="menu">
                {authed ? null : <button type="button" role="menuitem" onClick={() => act({ kind: 'login' })}>Log in</button>}
                {authed ? null : <button type="button" role="menuitem" onClick={() => act({ kind: 'open' })}>Open an account</button>}
                <Link href="/app/help" role="menuitem">Help</Link>
                {authed ? <button type="button" role="menuitem" onClick={() => act({ kind: 'logout' })}>Log out</button> : null}
              </div>
            ) : null}
          </div>
          <Banner banner={cfg.banner} />

          {chatting ? null : (
            <div className="hero">
              {/* The Lovable W-mark: the brand of record (never a bubble). */}
              <img src="/brand/wapay-mark-256.png" width="64" height="64" alt="WaPay" />
              <p className="greet">{authed ? hello : 'Welcome to WaPay'}</p>
              <p className="line">{authed ? 'What would you like to do today?' : guide?.line || ''}</p>
              {authed ? (
                <button type="button" className="balchip" onClick={() => (b ? act({ kind: 'card', card: 'balance' }) : loadHome())} aria-label="Balance">
                  {b ? <><span>Available</span> {hide ? '••••' : R(b.totalCents)}</> : <span>{homeFailed ? 'Balance unavailable. Tap to try again' : 'Loading your balance'}</span>}
                </button>
              ) : null}
            </div>
          )}

          {chatting ? (
            <div className="thread" aria-live="polite">
              {login && !thread.length ? <div className="center"><img src="/brand/wapay-mark-256.png" width="44" height="44" alt="WaPay" /></div> : null}
              {thread.map((it) => {
                if (it.who === 'me') return <div key={it.id} className="me">{it.text}</div>;
                if (it.card === 'balance') return <div key={it.id}><BalanceCard home={it.home} /><div style={{ height: 10 }} /><RecentCard home={it.home} /></div>;
                if (it.card === 'recent') return <RecentCard key={it.id} home={it.home} />;
                if (it.card === 'links') return <LinksCard key={it.id} links={it.links} />;
                return (
                  <div key={it.id} className="wa">
                    {it.text}
                    {it.actions?.includes('open') && guide?.open ? <a className="btn" href={guide.open.url} target="_blank" rel="noopener noreferrer">{guide.open.label}</a> : null}
                    {it.actions?.includes('login') ? <button type="button" className="btn ghost" onClick={() => act({ kind: 'login' })}>Log in</button> : null}
                  </div>
                );
              })}
              {login ? <LoginCard key={login.cell} cfg={cfg} guide={guide} cell={login.cell} onDone={afterLogin} /> : null}
              <div ref={endRef} />
            </div>
          ) : null}

          {authed && install && !chatting ? (
            <div className="notice info" role="status">
              {install.kind === 'ios'
                ? 'Add WaPay to your home screen: tap the Share button, then Add to Home Screen.'
                : 'Add WaPay to your home screen to open it like an app.'}
              <div className="split mt">
                {install.kind === 'prompt' ? <button type="button" className="btn sm" onClick={addToHome}>Add</button> : null}
                <button type="button" className="btn sm ghost" onClick={dismissInstall}>{install.kind === 'ios' ? 'Got it' : 'Not now'}</button>
              </div>
            </div>
          ) : null}

          <div className={`quick ${chatting ? 'one' : ''}`}>
            {authed
              ? MEMBER_CHIPS.map((c) => <Link key={c.href} href={c.href} className="chip">{c.label}</Link>)
              : VISITOR_CHIPS.map((c) => <button key={c.label} type="button" className={`chip ${c.go ? 'go' : ''}`} onClick={() => act(c.act)}>{c.label}</button>)}
          </div>
          {tip ? <p className="tip" role="status">{tip}</p> : null}
          <form className="composer" onSubmit={onSubmit}>
            <button type="button" className="cbtn plus" aria-label="Paste a pay link" onClick={onPlus}><Icon name="plus" size={18} /></button>
            <input ref={boxRef} value={text} onChange={(e) => setText(e.target.value.slice(0, 300))} placeholder={authed ? 'Ask WaPay anything' : 'Your cell number'} aria-label="Message" autoComplete="off" autoCorrect="off" spellCheck={false} enterKeyHint="send" />
            <button type="button" className="cbtn" aria-label="Speak with your keyboard's microphone" onClick={onMic}><Icon name="mic" /></button>
            <button type="submit" className="cbtn send" aria-label="Send" disabled={!text.trim()}><Icon name="up" size={18} stroke={2.2} /></button>
          </form>
        </div>
      )}
    </Shell>
  );
}
