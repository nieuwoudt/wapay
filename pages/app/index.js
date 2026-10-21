/**
 * WaPay personal portal: home (2026-10-21). The balance (available = spend +
 * cash, the two lines underneath), the four quick actions, the status banner,
 * the last five movements and the coming-soon tiles.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import Shell from '../../components/app/Shell.js';
import { ActivityRow, Banner, Icon, Logo, Notice, Pill, R, Spinner, api } from '../../components/app/kit.js';

const ACTIONS = [
  { href: '/app/get-paid', label: 'Get paid', icon: 'in' },
  { href: '/app/top-up', label: 'Top up', icon: 'plus' },
  { href: '/app/send', label: 'Send', icon: 'send' },
  { href: '/app/pay-out', label: 'Pay out', icon: 'bank' },
];

function HomeScreen() {
  const [home, setHome] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api('/api/app/home').then((r) => (r.ok ? setHome(r.data) : setError('Your balance could not be loaded just now. Pull down or try again in a moment.')));
  }, []);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!home) return <Spinner />;
  const b = home.balance;
  return (
    <>
      <div className="top">
        <Logo />
        <Link href="/app/profile" className="avatar" aria-label="Profile">{home.initials}</Link>
      </div>
      {home.firstName ? <p className="p" style={{ margin: '0 2px 10px' }}>Hi {home.firstName}</p> : null}
      <section className="card balance" aria-label="Balance">
        <p className="t">Available balance</p>
        <p className="amt">{R(b.totalCents)}</p>
        <div className="sub">
          <span>Spend {R(b.spendCents)}</span>
          <span>Cash {R(b.cashCents)}</span>
          {b.heldCents > 0 ? <span>Held for a pay-out {R(b.heldCents)}</span> : null}
          {home.kyc?.nudge ? <Link href="/app/profile#verify" className="pill grey">Verify ID to lift limits</Link> : null}
        </div>
      </section>
      <nav className="actions" aria-label="Quick actions">
        {ACTIONS.map((a) => (
          <Link key={a.href} href={a.href} className="act"><span className="ic"><Icon name={a.icon} /></span>{a.label}</Link>
        ))}
      </nav>
      <Banner banner={home.banner} />
      <h3>Recent {home.recent?.length ? <Link href="/app/activity">See all</Link> : null}</h3>
      <div className="card tight">
        {home.recent?.length
          ? home.recent.map((it) => <ActivityRow key={it.id} item={it} />)
          : <p className="p" style={{ margin: '12px 0' }}>Nothing yet. Get paid with a link, or top up by card.</p>}
      </div>
      <h3>Coming soon</h3>
      <div className="tiles">
        {home.tiles.map((t) => (
          <div key={t.id} className={`tile ${t.live ? 'live' : 'soon'}`}>
            <span className="ic"><Icon name={t.icon} size={22} /></span>
            {t.label}
            <small>{t.note}</small>
          </div>
        ))}
      </div>
      <p className="note">{home.pinSafety} <Link href="/app/help">Help</Link></p>
      {!home.payoutsOn ? <p className="note">Pay-outs are not switched on for your account right now.</p> : null}
      {home.kyc?.status === 'PENDING_REVIEW' ? <p className="note"><Pill tone="amber">ID check in review</Pill></p> : null}
    </>
  );
}

export default function Home() {
  return (
    <Shell title="Home" tab="home">
      <HomeScreen />
    </Shell>
  );
}
