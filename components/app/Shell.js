/**
 * The personal portal's frame (2026-10-21): the head, the stylesheet, the
 * centred 420 px column, the pill menu at the bottom (Chat, Pay, Activity,
 * Profile since 2026-11-24; Links moved under Pay) and the sign-in guard. A
 * signed-in screen renders nothing of the customer's until /api/app/auth says
 * the session is good; otherwise it goes to /app/login and comes back after.
 *
 * Since 2026-11-24 the app can be added to a phone's home screen: the head
 * names the manifest and the icons, the page follows the phone's dark or light
 * setting, and the service worker (public/app-sw.js) is registered here. The
 * worker stores nothing and never handles a request under /api/.
 */
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { createContext, useContext, useEffect, useState } from 'react';
import { CSS, Icon, Spinner, loadSession } from './kit.js';

const SessionContext = createContext(null);
export const useAppSession = () => useContext(SessionContext);

const TABS = [
  { key: 'chat', href: '/app', label: 'Chat', icon: 'chat' },
  { key: 'pay', href: '/app/pay', label: 'Pay', icon: 'pay' },
  { key: 'activity', href: '/app/activity', label: 'Activity', icon: 'activity' },
  { key: 'profile', href: '/app/profile', label: 'Profile', icon: 'profile' },
];

/**
 * The pill menu. For someone who is not signed in (`locked`) only Chat is a
 * link: the others are greyed buttons that say why, through `onLocked`.
 * Pressing the tab you are already on calls `onSame` (the landing screen uses
 * it to come back to its first view).
 */
export function Nav({ tab, locked = false, onLocked = null, onSame = null }) {
  return (
    <nav className="nav" aria-label="Main">
      {TABS.map((t) => (locked && t.key !== 'chat' ? (
        <button key={t.key} type="button" className="locked" aria-disabled="true" onClick={() => onLocked && onLocked(t)}>
          <Icon name={t.icon} size={22} />
          {t.label}
        </button>
      ) : (
        <Link key={t.key} href={t.href} className={tab === t.key ? 'on' : ''} aria-current={tab === t.key ? 'page' : undefined} onClick={tab === t.key && onSame ? () => onSame(t) : undefined}>
          <Icon name={t.icon} size={22} />
          {t.label}
        </Link>
      )))}
    </nav>
  );
}

export function AppHead({ title }) {
  return (
    <Head>
      <title>{title ? `${title} · WaPay` : 'WaPay'}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="robots" content="noindex, nofollow" />
      <meta name="color-scheme" content="light dark" />
      <meta name="theme-color" content="#F4F6F8" media="(prefers-color-scheme: light)" />
      <meta name="theme-color" content="#0E100F" media="(prefers-color-scheme: dark)" />
      <meta name="referrer" content="same-origin" />
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-title" content="WaPay" />
      <link rel="manifest" href="/manifest.webmanifest" />
      <link rel="icon" href="/brand/favicon-32.png" />
      <link rel="apple-touch-icon" href="/brand/app-icon-180.png" />
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
    </Head>
  );
}

export default function Shell({ title, tab = null, auth = true, nav = true, locked = false, onLocked = null, onSame = null, children }) {
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

  // The installed app's worker: an offline screen for a page load that cannot reach WaPay, and
  // nothing else. Production only, so a development server is never served a stale page.
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/app-sw.js', { scope: '/app' }).catch(() => {});
  }, []);

  return (
    <SessionContext.Provider value={session}>
      <AppHead title={title} />
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className={`frame ${nav ? '' : 'nonav'}`}>
        <main>{ready ? children : <Spinner />}</main>
        {nav && ready ? <Nav tab={tab} locked={locked} onLocked={onLocked} onSame={onSame} /> : null}
      </div>
    </SessionContext.Provider>
  );
}
