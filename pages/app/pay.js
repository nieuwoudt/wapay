/**
 * WaPay personal portal: the Pay tab (2026-10-21): get paid, send, pay out, top up.
 * Since 2026-11-24 it also carries the coming-soon tiles that used to sit on
 * home: each one is live exactly when the chat would sell it to this customer.
 */
import { useEffect, useState } from 'react';
import Shell from '../../components/app/Shell.js';
import { Icon, Row, api } from '../../components/app/kit.js';

function Tiles() {
  const [tiles, setTiles] = useState(null);
  useEffect(() => { api('/api/app/home').then((r) => { if (r.ok) setTiles(r.data.tiles || []); }); }, []);
  if (!tiles?.length) return null;
  return (
    <>
      <h3>More</h3>
      <div className="tiles">
        {tiles.map((t) => (
          <div key={t.id} className={`tile ${t.live ? 'live' : 'soon'}`}>
            <span className="ic"><Icon name={t.icon} size={22} /></span>
            {t.label}
            <small>{t.note}</small>
          </div>
        ))}
      </div>
    </>
  );
}

export default function Pay() {
  return (
    <Shell title="Pay" tab="pay">
      <p className="h1">Pay</p>
      <p className="p">Move money in and out. Every payment is confirmed with your WaPay PIN.</p>
      <div className="card tight">
        <Row href="/app/get-paid" icon="in" title="Get paid" sub="Make a link and send it to whoever owes you" right="›" />
        <Row href="/app/links" icon="link" title="Your links" sub="See who has paid, send a reminder or cancel" right="›" />
        <Row href="/app/send" icon="send" title="Send money" sub="To any SA cell number, free" right="›" />
        <Row href="/app/pay-out" icon="bank" title="Pay out" sub="To your bank account, or cash at an ATM" right="›" />
        <Row href="/app/top-up" icon="plus" title="Top up" sub="By card or Instant EFT" right="›" />
      </div>
      <div className="card tight">
        <Row href="/app/help" icon="help" title="Help" sub="What works here, fees and support" right="›" />
      </div>
      <Tiles />
    </Shell>
  );
}
