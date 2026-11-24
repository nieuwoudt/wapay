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
 * flow's own answers), never from wording typed into this file. Money shown
 * here is read fresh each time it is asked for; a read that fails says so and
 * never shows an older figure.
 *
 * The menu button opens the slide-over menu (components/app/Drawer.js): every
 * place in the app for a member; for someone not signed in, how to start, what
 * WaPay is, and the member's places greyed until they log in.
 */
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import Shell from './Shell.js';
import Drawer from './Drawer.js';
import { ActivityRow, Banner, Field, Icon, Notice, Pill, PinField, R, Row, Rs, Spinner, api, forgetSession, loadSession, shortDate, useBusy } from './kit.js';
import { BAD_CELL_LINE, SECRET_LINE, greetingFor, payLinkCodeOf, routeMessage, safeNext } from '../../lib/app-chat-router.js';

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
const NO_BALANCE = 'Your balance could not be loaded just now. Please try again in a moment.';
const STILL_IN = 'You are still logged in: the log-out did not reach WaPay. Check your connection and try again.';
const HIDDEN = 'Your balance is hidden. Tap the eye at the top to show it.';

function BalanceCard({ home, hide }) {
  if (hide) return <section className="card" aria-label="Balance"><p className="p" style={{ margin: 0 }}>{HIDDEN}</p></section>;
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

function RecentCard({ home, hide }) {
  if (hide) return <section className="card" aria-label="Recent activity"><p className="p" style={{ margin: 0 }}>{HIDDEN}</p></section>;
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
  const lastRef = useRef(null);
  const menuBtn = useRef(null);

  const authed = !!cfg?.authed;
  const push = (...items) => setThread((cur) => [...cur, ...items.map((it) => ({ id: (seq.current += 1), ...it }))]);
  const say = (line, extra = {}) => push({ who: 'wa', text: line || NOT_LOADED, ...extra });

  const loadHome = async () => {
    const r = await api('/api/app/home');
    if (r.ok) { setHome(r.data); setHomeFailed(false); return r.data; }
    setHome(null);
    setHomeFailed(true);
    return null;
  };
  const loadGuide = async () => {
    const r = await api('/api/app/guide');
    if (!r.ok) return null;
    setGuide(r.data.guide);
    return r.data.guide;
  };
  const loadWho = () => loadSession(true).then((s) => {
    if (s.authed && mode === 'login') { router.replace(safeNext(router.query.next)); return; }
    setCfg(s);
    if (s.authed) { setLogin(null); loadHome(); }
  });

  // Who is here, and what the screen may say about WaPay.
  useEffect(() => {
    if (!router.isReady) return;
    loadWho();
    loadGuide();
    setHide(keep.get(HIDE_KEY) === '1');
  }, [router.isReady]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setHello(greetingFor(new Date(), cfg?.me?.firstName)); }, [cfg]);
  // The newest answer, or the log-in step, is brought to the top of what can be seen: its first line is never off screen.
  useEffect(() => { if (thread.length || login) lastRef.current?.scrollIntoView({ block: 'start' }); }, [thread.length, login]);
  useEffect(() => { if (!tip) return undefined; const t = setTimeout(() => setTip(''), 6000); return () => clearTimeout(t); }, [tip]);
  // An app left open and come back to shows today's balance, not this morning's.
  useEffect(() => {
    if (!authed) return undefined;
    const onShow = () => { if (document.visibilityState === 'visible') loadHome(); };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, [authed]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // "Got it" and a finished prompt are remembered; "Not now" only puts the hint away for this visit.
  const dismissInstall = (remember) => { if (remember) keep.set(INSTALL_KEY, '1'); setInstall(null); };
  const addToHome = async () => { try { await install.event.prompt(); } catch { /* the phone declined */ } dismissInstall(true); };

  const toggleHide = () => setHide((h) => { keep.set(HIDE_KEY, h ? '0' : '1'); return !h; });
  const openPayLink = (code) => { say('Opening that payment link.'); window.location.assign(`/pay/${code}`); };
  const goHome = () => { setMenu(false); setThread([]); setLogin(null); };

  const afterLogin = async () => {
    const target = safeNext(router.query.next);
    const s = await loadSession(true);
    setCfg(s);
    setLogin(null);
    setThread([]);
    if (s.authed) loadHome();
    if (target !== '/app' || router.asPath !== '/app') router.replace(target);
  };

  const logout = async () => {
    const r = await api('/api/app/auth', { method: 'POST', body: { action: 'logout' } });
    // Only a log-out WaPay answered is shown as one: a failed request leaves the session alive.
    if (!r.ok) { say(STILL_IN); return; }
    forgetSession();
    setHome(null);
    setThread([]);
    setCfg(await loadSession(true));
  };

  const lockedTap = async () => {
    // The log-in step is put away, so the line is not hidden above it.
    setLogin(null);
    const g = guide || (await loadGuide());
    say(g?.locked, { actions: ['open', 'login'] });
  };

  /** Do what the router decided. Nothing typed is passed to the server from here. */
  const act = async (r) => {
    setMenu(false);
    if (r.kind === 'home') { goHome(); return; }
    // Any other step puts the log-in step away, so the answer is not hidden above it.
    if (r.kind !== 'cell' && r.kind !== 'login') setLogin(null);
    if (r.kind === 'paylink') { openPayLink(r.code); return; }
    if (r.kind === 'page') { router.push(r.href); return; }
    if (r.kind === 'logout') { logout(); return; }
    if (r.kind === 'thanks') { say("You're welcome."); return; }
    if (r.kind === 'cell') { setLogin({ cell: r.cell }); return; }
    if (r.kind === 'login') { setLogin({ cell: '' }); return; }
    const g = guide || (await loadGuide());
    if (r.kind === 'paylink-ask') { say(g?.payLink); boxRef.current?.focus(); return; }
    if (authed) {
      if (r.kind === 'card' && r.card === 'links') {
        const got = await api('/api/app/links');
        if (got.ok) push({ who: 'wa', card: 'links', links: got.data.links || [] }); else say(NOT_LOADED);
        return;
      }
      if (r.kind === 'card') {
        // Read fresh every time it is asked for; a failed read says so and shows no older figure.
        const fresh = await loadHome();
        if (fresh) push({ who: 'wa', card: r.card, home: fresh }); else say(NO_BALANCE);
        return;
      }
      if (r.kind === 'answer') { say(g?.member?.[r.topic]); return; }
      if (r.kind === 'vas') {
        const tile = (home?.tiles || []).find((x) => x.id === r.product);
        // A tile that is switched on works in the chat today: the button opens the person's own WhatsApp. Nothing is bought here.
        say(tile ? `${tile.label}: ${tile.note.charAt(0).toLowerCase()}${tile.note.slice(1)}.` : g?.member?.vas, tile?.live ? { actions: ['chat'] } : {});
        return;
      }
      say(g?.memberFallback);
      return;
    }
    if (r.kind === 'open') { say(g?.open?.line, { actions: ['open'] }); return; }
    if (r.kind === 'support') { say(g?.support); return; }
    if (r.kind === 'answer') { say(g?.visitor?.[r.topic], { actions: ['open'] }); return; }
    if (r.kind === 'greet') { say(g ? `Welcome to WaPay. ${g.line}` : null, { actions: ['open', 'login'] }); return; }
    say(g?.fallback, { actions: ['open', 'login'] });
  };

  const onSubmit = (e) => {
    e.preventDefault();
    const typed = text.trim();
    if (!typed) return;
    setText('');
    const r = routeMessage(typed, { authed });
    // A secret is never shown back and never leaves this page.
    if (r.kind === 'secret') { push({ who: 'me', text: '•••' }, { who: 'wa', text: SECRET_LINE }); return; }
    // A number that is not a cell number is not shown back either: it may be some other number.
    if (r.kind === 'badcell') { push({ who: 'me', text: '•••' }, { who: 'wa', text: BAD_CELL_LINE }); return; }
    if (r.kind !== 'cell' && r.kind !== 'home') push({ who: 'me', text: typed });
    act(r);
  };

  const onPlus = async () => {
    let clip = '';
    try { clip = navigator.clipboard?.readText ? await navigator.clipboard.readText() : ''; } catch { clip = ''; }
    const code = payLinkCodeOf(clip);
    if (code) { openPayLink(code); return; }
    act({ kind: 'paylink-ask' });
  };
  const onMic = () => { setTip("Tap the microphone on your keyboard to speak. WaPay records no audio."); boxRef.current?.focus(); };

  // The slide-over menu: every place in the app. Labels only; what WaPay says about itself stays in the guide.
  // A question row shows its own label as the question, so the answer has something to answer.
  const ask = (topic, label) => ({ label, onClick: () => { push({ who: 'me', text: label }); act({ kind: 'answer', topic }); } });
  const MONEY = [
    { key: 'get-paid', label: 'Get paid', icon: 'in', href: '/app/get-paid' },
    { key: 'send', label: 'Send', icon: 'send', href: '/app/send' },
    { key: 'pay-out', label: 'Pay out', icon: 'bank', href: '/app/pay-out' },
    { key: 'top-up', label: 'Top up', icon: 'plus', href: '/app/top-up' },
  ];
  const payALink = { key: 'pay-link', label: 'Pay a link', icon: 'pay', onClick: () => act({ kind: 'paylink-ask' }) };
  const help = { key: 'help', label: 'Help', icon: 'help', href: '/app/help' };
  const menuGroups = authed
    ? [
      { items: [{ key: 'home', label: 'Home', icon: 'chat', onClick: goHome }] },
      { title: 'Money', items: [...MONEY, { key: 'links', label: 'My links', icon: 'link', href: '/app/links' }, payALink] },
      // The same tiles as the Pay page: each says where it works today, by the launch switches.
      { title: 'Buy', items: (home?.tiles || []).map((t) => ({ key: t.id, label: t.label, icon: t.icon, note: t.note, dim: !t.live, onClick: () => act({ kind: 'vas', product: t.id }) })) },
      { title: 'You', items: [{ key: 'activity', label: 'Activity', icon: 'activity', href: '/app/activity' }, { key: 'profile', label: 'Profile', icon: 'profile', href: '/app/profile' }] },
    ]
    : [
      { items: [
        { key: 'open', label: 'Open an account', icon: 'plus', go: true, onClick: () => act({ kind: 'open' }) },
        { key: 'login', label: 'Log in', icon: 'profile', onClick: () => act({ kind: 'login' }) },
        payALink,
      ] },
      { title: 'About WaPay', items: [
        { key: 'about', icon: 'chat', ...ask('about', 'What is WaPay?') },
        { key: 'how', icon: 'check', ...ask('how', 'How does it work?') },
        { key: 'fees', icon: 'fee', ...ask('fees', 'What does it cost?') },
        { key: 'vas', icon: 'phone', ...ask('vas', 'Can I buy airtime, data or electricity?') },
      ] },
      // A member's places, greyed: a tap says to log in or open an account first.
      { title: 'After you log in', items: [...MONEY, { key: 'activity', label: 'Activity', icon: 'activity' }].map(({ href, ...item }) => ({ ...item, dim: true, onClick: lockedTap })) },
    ];
  const menuFoot = authed ? [help, { key: 'logout', label: 'Log out', icon: 'out', onClick: logout }] : [help];

  const chatting = thread.length > 0 || !!login;
  const b = home?.balance;
  const placeholder = authed ? 'Ask WaPay anything' : 'Your cell number';
  const lastId = login ? null : thread[thread.length - 1]?.id;
  const mark = (it) => (it.id === lastId ? lastRef : undefined);

  return (
    <Shell title={authed ? 'Chat' : 'Welcome'} tab="chat" auth={false} locked={!authed} onLocked={lockedTap} onSame={goHome}>
      {!cfg ? <Spinner /> : (
        <div className="land">
          <div className="bar">
            <button ref={menuBtn} type="button" className="round" aria-label="Menu" aria-expanded={menu} aria-controls="app-menu" onClick={() => setMenu(true)}><Icon name="menu" /></button>
            {authed ? <button type="button" className="round" aria-label={hide ? 'Show balance' : 'Hide balance'} aria-pressed={hide} onClick={toggleHide}><Icon name={hide ? 'eyeoff' : 'eye'} /></button> : <span />}
          </div>
          <Banner banner={cfg.banner} />
          {cfg.offline ? (
            <Notice tone="warn">
              No connection. Check your data or Wi-Fi.
              <div className="split mt"><button type="button" className="btn sm ghost" onClick={() => { loadWho(); loadGuide(); }}>Try again</button></div>
            </Notice>
          ) : null}

          {chatting ? null : (
            <div className="hero">
              {/* The Lovable W-mark: the brand of record (never a bubble). */}
              <img src="/brand/wapay-mark-256.png" width="64" height="64" alt="WaPay" />
              <p className="greet">{authed ? hello : 'Welcome to WaPay'}</p>
              <p className="line">{authed ? 'What would you like to do today?' : guide?.line || ''}</p>
              {authed ? (
                <button type="button" className="balchip" onClick={() => (b ? act({ kind: 'card', card: 'balance' }) : loadHome())} aria-label={b && hide ? 'Balance hidden' : undefined}>
                  {b ? <><span>Available</span> {hide ? '••••' : R(b.totalCents)}</> : <span>{homeFailed ? 'Balance unavailable. Tap to try again' : 'Loading your balance'}</span>}
                </button>
              ) : null}
            </div>
          )}

          {chatting ? (
            <div className="thread" aria-live="polite">
              {login && !thread.length ? <div className="center"><img src="/brand/wapay-mark-256.png" width="44" height="44" alt="WaPay" /></div> : null}
              {thread.map((it) => {
                if (it.who === 'me') return <div key={it.id} ref={mark(it)} className="me">{it.text}</div>;
                if (it.card === 'balance') return <div key={it.id} ref={mark(it)}><BalanceCard home={it.home} hide={hide} />{hide ? null : <><div style={{ height: 10 }} /><RecentCard home={it.home} hide={false} /></>}</div>;
                if (it.card === 'recent') return <div key={it.id} ref={mark(it)}><RecentCard home={it.home} hide={hide} /></div>;
                if (it.card === 'links') return <div key={it.id} ref={mark(it)}><LinksCard links={it.links} /></div>;
                return (
                  <div key={it.id} ref={mark(it)} className="wa">
                    {it.text}
                    {it.actions?.includes('open') && guide?.open ? <a className="btn" href={guide.open.url} target="_blank" rel="noopener noreferrer">{guide.open.label}</a> : null}
                    {it.actions?.includes('chat') && guide?.chat ? <a className="btn" href={guide.chat.url} target="_blank" rel="noopener noreferrer">{guide.chat.label}</a> : null}
                    {it.actions?.includes('login') ? <button type="button" className="btn ghost" onClick={() => act({ kind: 'login' })}>Log in</button> : null}
                  </div>
                );
              })}
              {login ? <div ref={lastRef}><LoginCard key={login.cell} cfg={cfg} guide={guide} cell={login.cell} onDone={afterLogin} /></div> : null}
            </div>
          ) : null}

          {authed && install && !chatting ? (
            <div className="notice info install" role="status">
              {install.kind === 'ios'
                ? 'Add WaPay to your home screen: tap the Share button, then Add to Home Screen.'
                : 'Add WaPay to your home screen to open it like an app.'}
              <div className="split mt">
                {install.kind === 'prompt' ? <button type="button" className="btn sm" onClick={addToHome}>Add</button> : null}
                <button type="button" className="btn sm ghost" onClick={() => dismissInstall(install.kind === 'ios')}>{install.kind === 'ios' ? 'Got it' : 'Not now'}</button>
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
            <input ref={boxRef} value={text} onChange={(e) => setText(e.target.value.slice(0, 300))} placeholder={placeholder} aria-label={placeholder} autoComplete="off" autoCorrect="off" spellCheck={false} enterKeyHint="send" />
            <button type="button" className="cbtn" aria-label="Speak with your keyboard's microphone" onClick={onMic}><Icon name="mic" /></button>
            <button type="submit" className="cbtn send" aria-label="Send" disabled={!text.trim()}><Icon name="up" size={18} stroke={2.2} /></button>
          </form>
          <Drawer open={menu} onClose={() => setMenu(false)} title={authed ? cfg.me?.firstName || 'WaPay' : 'WaPay'} sub={authed ? 'Your WaPay account' : 'Welcome'} groups={menuGroups} foot={menuFoot} opener={menuBtn} />
        </div>
      )}
    </Shell>
  );
}
