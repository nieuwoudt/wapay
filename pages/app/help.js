/**
 * WaPay personal portal: help (2026-10-21). What the portal does, why WhatsApp
 * replies are paused, support, and the PIN safety line. Static: no data.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import Shell from '../../components/app/Shell.js';
import { Banner, Icon, loadSession } from '../../components/app/kit.js';

export default function Help() {
  const [cfg, setCfg] = useState(null);
  useEffect(() => { loadSession().then(setCfg); }, []);
  const email = cfg?.supportEmail || 'help@wapay.co.za';
  return (
    <Shell title="Help" tab={cfg?.authed ? 'profile' : null} auth={false} nav={!!cfg?.authed}>
      <div className="top"><Link href={cfg?.authed ? '/app' : '/app/login'} className="back"><Icon name="back" size={18} />{cfg?.authed ? 'Home' : 'Log in'}</Link></div>
      <p className="h1">Help</p>
      <Banner banner={cfg?.banner || { show: true, text: 'WhatsApp replies are paused by WhatsApp until further notice. Your money is safe and everything here works.' }} />
      <div className="card">
        <p className="p" style={{ color: 'var(--ink)', fontWeight: 600, margin: '0 0 6px' }}>What you can do here</p>
        <ul className="steps" style={{ marginTop: 0 }}>
          <li>See your balance and everything in and out.</li>
          <li>Get paid: make a link and send it to whoever owes you.</li>
          <li>Top up by card or Instant EFT.</li>
          <li>Send money to any South African cell number, free.</li>
          <li>Pay out to your bank account, or as cash at an ATM.</li>
          <li>Reset your PIN with the ID number you gave for pay-outs.</li>
        </ul>
      </div>
      <div className="card">
        <p className="p" style={{ color: 'var(--ink)', fontWeight: 600, margin: '0 0 6px' }}>Why WhatsApp is quiet</p>
        <p className="p" style={{ margin: 0 }}>WhatsApp has paused the replies from WaPay's number for now. Your money and your account are not affected: everything you could do in the chat with your balance, you can do here with the same cell number and PIN.</p>
      </div>
      <div className="card">
        <p className="p" style={{ color: 'var(--ink)', fontWeight: 600, margin: '0 0 6px' }}>Staying safe</p>
        <p className="p" style={{ margin: 0 }}>WaPay never asks for your PIN by message. Type it only on this site (check the address) or in the WaPay chat, and only to approve your own payment. A payment link asks the payer for nothing but the payment.</p>
      </div>
      <div className="card">
        <p className="p" style={{ color: 'var(--ink)', fontWeight: 600, margin: '0 0 6px' }}>Support</p>
        <p className="p" style={{ margin: 0 }}>E-mail <a href={`mailto:${email}`}>{email}</a> with your cell number. Never send your PIN.</p>
      </div>
    </Shell>
  );
}
