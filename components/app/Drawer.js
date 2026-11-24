/**
 * The slide-over menu of the WaPay app (2026-11-24). The menu button opens it:
 * a panel that slides in from the left over the whole screen, the way a phone
 * app's own menu does, with every place in the app on it.
 *
 * It only shows what it is given and calls back: it makes no request, keeps
 * nothing in the browser and holds no wording about WaPay of its own. While it
 * is closed it is out of sight and takes no tap; while it is open the screen
 * behind it is inert, the keyboard stays inside it, Escape or a tap beside it
 * closes it, and so does a swipe to the left. Closing hands the keyboard to the
 * button that opened it (never back to the message box: on an iPhone that
 * would bring the on-screen keyboard up again).
 */
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { Icon } from './kit.js';

const FOCUSABLE = 'a[href], button:not([disabled])';

function Item({ item, onClose }) {
  const inner = (
    <>
      <span className="dic"><Icon name={item.icon} size={20} /></span>
      <span className="dl">{item.label}</span>
      {item.note ? <small>{item.note}</small> : null}
    </>
  );
  const tone = `ditem ${item.go ? 'go' : ''} ${item.dim ? 'dim' : ''}`;
  if (item.href) return <Link href={item.href} className={tone} onClick={onClose}>{inner}</Link>;
  return <button type="button" className={tone} onClick={() => { onClose(); item.onClick(); }}>{inner}</button>;
}

/**
 * @param {{ open: boolean, onClose: () => void, title: string, sub?: string,
 *   groups: Array<{ title?: string, items: Array<{ key: string, label: string, icon: string, href?: string, onClick?: () => void, note?: string, go?: boolean, dim?: boolean }> }>,
 *   foot?: Array<object>, opener?: { current: HTMLElement | null } }} props
 */
export default function Drawer({ open, onClose, title, sub = '', groups, foot = [], opener = null }) {
  const root = useRef(null);
  const sheet = useRef(null);
  const touch = useRef(null);

  // While it is open: the rest of the screen is inert (a screen reader cannot wander behind it),
  // the keyboard is inside the panel, and Escape closes it from anywhere. Closing undoes all three
  // and hands the keyboard to the menu button, unless the chosen item has already put it somewhere.
  useEffect(() => {
    if (!open) return undefined;
    const behind = [...(root.current?.parentElement?.children || [])].filter((el) => el !== root.current);
    const nav = document.querySelector('nav[aria-label="Main"]');
    if (nav) behind.push(nav);
    behind.forEach((el) => el.setAttribute('inert', ''));
    const onEscape = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onEscape);
    sheet.current?.focus();
    return () => {
      document.removeEventListener('keydown', onEscape);
      behind.forEach((el) => el.removeAttribute('inert'));
      const now = document.activeElement;
      const stillHere = !now || now === document.body || root.current?.contains(now);
      if (stillHere) opener?.current?.focus();
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e) => {
    if (e.key !== 'Tab') return;
    const stops = [...(sheet.current?.querySelectorAll(FOCUSABLE) || [])];
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  // A swipe to the left puts it away, as on a phone.
  const onTouchStart = (e) => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY }; };
  const onTouchEnd = (e) => {
    const from = touch.current;
    touch.current = null;
    if (!from) return;
    const t = e.changedTouches[0];
    if (from.x - t.clientX > 60 && Math.abs(t.clientY - from.y) < 60) onClose();
  };

  return (
    <div ref={root} className={`drawer ${open ? 'open' : ''}`}>
      {/* The shade beside the panel: a tap closes it. The close button inside is the one a screen reader is given. */}
      <button type="button" className="scrim" aria-hidden="true" tabIndex={-1} onClick={onClose} />
      <div ref={sheet} id="app-menu" className="sheet" role="dialog" aria-modal="true" aria-label="Menu" tabIndex={-1} onKeyDown={onKeyDown} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div className="dhead">
          {/* The Lovable W-mark: the brand of record. */}
          <img src="/brand/wapay-mark-256.png" width="36" height="36" alt="" />
          <div className="who"><b>{title}</b>{sub ? <span>{sub}</span> : null}</div>
          <button type="button" className="round" aria-label="Close menu" onClick={onClose}><Icon name="close" size={18} /></button>
        </div>
        <div className="dbody">
          {groups.filter((g) => g.items.length).map((g) => (
            <div key={g.title || 'first'} className="dgroup">
              {g.title ? <p className="dtitle">{g.title}</p> : null}
              {g.items.map((item) => <Item key={item.key} item={item} onClose={onClose} />)}
            </div>
          ))}
        </div>
        {foot.length ? <div className="dfoot">{foot.map((item) => <Item key={item.key} item={item} onClose={onClose} />)}</div> : null}
      </div>
    </div>
  );
}
