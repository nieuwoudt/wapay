/**
 * WaPay personal portal: your payment links (2026-10-24, founder: "track their
 * payment links online on the web version like we do for our business
 * accounts"). Every link with its status, what it is for, the amount, when it
 * was made and when it closes or was paid (and how: a WaPay balance or a
 * card). An open link can be copied, shared, reminded and cancelled.
 *
 * A reminder is a message the customer sends themselves: the phone's share
 * sheet, or WhatsApp opened with the text ready so it asks who to send it to.
 * Nothing here sends a WhatsApp message and nothing here reaches a model; the
 * texts come from the server (lib/pay-links.js), the same words as the chat.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import Shell from '../../components/app/Shell.js';
import { Icon, Notice, Pill, Rs, Spinner, api, copyText, shortDate, useBusy } from '../../components/app/kit.js';

const FILTERS = [['open', 'Open'], ['paid', 'Paid'], ['all', 'All']];
const STATUS = { OPEN: ['Open', 'amber'], PAID: ['Paid', ''], EXPIRED: ['Expired', 'grey'], CANCELLED: ['Cancelled', 'grey'] };

function whenLine(l) {
  const made = `Made ${shortDate(l.createdAt)}`;
  if (l.status === 'PAID') return `Paid ${shortDate(l.paidAt)}${l.paidBy ? ` from ${l.paidBy === 'card' ? 'a card' : 'a WaPay balance'}` : ''} · ${made.toLowerCase()}`;
  if (l.status === 'OPEN') return `${made} · open until ${shortDate(l.expiresAt)}`;
  if (l.status === 'EXPIRED') return `${made} · expired ${shortDate(l.expiresAt)}`;
  return `${made} · cancelled`;
}

function LinkCard({ l, canShare, busy, onCancel, onSay }) {
  const share = async (text, done) => {
    try {
      await navigator.share({ text });
      onSay(done);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      onSay((await copyText(text)) ? 'Copied. Paste it into a chat or SMS.' : 'Could not share here. Use Copy link.');
    }
  };
  const [label, tone] = STATUS[l.status] || [l.status, 'grey'];
  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{Rs(l.amountCents)}</div>
          <div style={{ fontSize: 14, marginTop: 2, wordBreak: 'break-word' }}>{l.note ? `For ${l.note}` : 'No description (made before descriptions)'}</div>
        </div>
        <Pill tone={tone}>{label}</Pill>
      </div>
      <p className="small" style={{ margin: '8px 0 0' }}>{whenLine(l)}{l.label ? ` · ${l.label}` : ''} · {l.code}</p>
      {l.status === 'OPEN' ? (
        <>
          <div className="split mt">
            <button type="button" className="btn ghost sm" onClick={async () => onSay((await copyText(l.url)) ? 'Link copied.' : 'Could not copy here. Press and hold the link to copy it.')}><Icon name="copy" size={16} />Copy link</button>
            {canShare
              ? <button type="button" className="btn ghost sm" onClick={() => share(l.shareText, 'Shared.')}><Icon name="share" size={16} />Share</button>
              : <button type="button" className="btn ghost sm" onClick={async () => onSay((await copyText(l.shareText)) ? 'Message copied. Paste it into a chat or SMS.' : 'Could not copy here. Use Copy link.')}><Icon name="share" size={16} />Copy message</button>}
          </div>
          <div className="split mt">
            {canShare
              ? <button type="button" className="btn sm" onClick={() => share(l.reminderText, 'Reminder ready. Send it to the person who owes you.')}><Icon name="send" size={16} />Send reminder</button>
              : <a className="btn sm" href={l.remindUrl} target="_blank" rel="noreferrer"><Icon name="send" size={16} />Send reminder</a>}
            <button type="button" className="btn danger sm" disabled={busy} onClick={() => onCancel(l)}>Cancel link</button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function LinksScreen() {
  const [links, setLinks] = useState(null);
  const [filter, setFilter] = useState(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [canShare, setCanShare] = useState(false);
  const [busy, run] = useBusy();

  const load = () => api('/api/app/links').then((r) => {
    if (!r.ok) { setError('Your links could not be loaded just now. Please try again.'); return; }
    setLinks(r.data.links);
    setFilter((f) => f || (r.data.links.some((l) => l.status === 'OPEN') ? 'open' : 'all'));
  });
  useEffect(() => {
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = (l) => {
    if (typeof window !== 'undefined' && !window.confirm(`Cancel the ${Rs(l.amountCents)} link${l.note ? ` for ${l.note}` : ''}? It stops working for anyone who has it.`)) return;
    run(async () => {
      const r = await api('/api/app/links', { method: 'POST', body: { action: 'cancel', code: l.code } });
      setMsg(r.ok ? `The ${Rs(l.amountCents)} link is cancelled.` : 'That link could not be cancelled. It may already be paid.');
      await load();
    });
  };

  const shown = (links || []).filter((l) => filter === 'all' || (filter === 'open' ? l.status === 'OPEN' : l.status === 'PAID'));
  const openCount = (links || []).filter((l) => l.status === 'OPEN').length;

  return (
    <>
      <div className="top">
        <p className="h1" style={{ margin: 0 }}>Your links</p>
        <Link href="/app/get-paid" className="btn sm"><Icon name="plus" size={16} />New link</Link>
      </div>
      <p className="p">{openCount ? `${openCount} open. ` : ''}See who has paid, send a reminder, or cancel a link you no longer need.</p>
      <Notice tone="error">{error}</Notice>
      <Notice tone="ok">{msg}</Notice>
      {links == null && !error ? <Spinner /> : null}
      {links ? (
        <>
          <div className="chips" role="tablist" aria-label="Show">
            {FILTERS.map(([key, text]) => (
              <button key={key} type="button" role="tab" aria-selected={filter === key} className={`chip ${filter === key ? 'on' : ''}`} onClick={() => setFilter(key)}>{text}</button>
            ))}
          </div>
          {shown.length
            ? shown.map((l) => <LinkCard key={l.code} l={l} canShare={canShare} busy={busy} onCancel={cancel} onSay={setMsg} />)
            : <p className="p" style={{ margin: '12px 2px' }}>{filter === 'open' ? 'No open links.' : filter === 'paid' ? 'No paid links yet.' : 'No links yet.'} <Link href="/app/get-paid">Make a link</Link></p>}
          <p className="note">A reminder is a message you send yourself: WaPay does not message the person who owes you. The person paying never pays a fee. Links last 7 days.</p>
        </>
      ) : null}
    </>
  );
}

export default function Links() {
  return (
    <Shell title="Your links" tab="links">
      <LinksScreen />
    </Shell>
  );
}
