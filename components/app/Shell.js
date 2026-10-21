/**
 * The personal portal's frame (2026-10-21): the head, the stylesheet, the
 * centred 420 px column, the bottom navigation (Home, Pay, Activity,
 * Profile) and the sign-in guard. A signed-in screen renders nothing of the
 * customer's until /api/app/auth says the session is good; otherwise it goes
 * to /app/login and comes back after.
 */
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { createContext, useContext, useEffect, useState } from 'react';
import { CSS, Icon, Spinner, loadSession } from './kit.js';

const SessionContext = createContext(null);
export const useAppSession = () => useContext(SessionContext);

const TABS = [
  { key: 'home', href: '/app', label: 'Home', icon: 'home' },
  { key: 'pay', href: '/app/pay', label: 'Pay', icon: 'pay' },
  { key: 'activity', href: '/app/activity', label: 'Activity', icon: 'activity' },
  { key: 'profile', href: '/app/profile', label: 'Profile', icon: 'profile' },
];

export function Nav({ tab }) {
  return (
    <nav className="nav" aria-label="Main">
      {TABS.map((t) => (
        <Link key={t.key} href={t.href} className={tab === t.key ? 'on' : ''} aria-current={tab === t.key ? 'page' : undefined}>
          <Icon name={t.icon} size={22} />
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export function AppHead({ title }) {
  return (
    <Head>
      <title>{title ? `${title} · WaPay` : 'WaPay'}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="robots" content="noindex, nofollow" />
      <meta name="theme-color" content="#359853" />
      <meta name="referrer" content="same-origin" />
      <link rel="icon" href="/brand/favicon-32.png" />
      <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" />
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
    </Head>
  );
}

export default function Shell({ title, tab = null, auth = true, nav = true, children }) {
  const router = useRouter();
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(!auth);

  useEffect(() => {
    if (!auth) return undefined;
    let live = true;
    loadSession(true).then((s) => {
      if (!live) return;
      if (!s.authed) {
        router.replace(`/app/login?next=${encodeURIComponent(router.asPath || '/app')}`);
        return;
      }
      setSession(s);
      setReady(true);
    });
    return () => { live = false; };
  }, [auth]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <SessionContext.Provider value={session}>
      <AppHead title={title} />
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className={`frame ${nav ? '' : 'nonav'}`}>
        <main>{ready ? children : <Spinner />}</main>
        {nav && ready ? <Nav tab={tab} /> : null}
      </div>
    </SessionContext.Provider>
  );
}
