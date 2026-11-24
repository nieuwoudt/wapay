/**
 * WaPay personal portal: log in with the WaPay cell number and PIN (2026-10-21).
 * Since 2026-11-24 log-in is a step of the landing screen; this address keeps
 * working for old links and for a session that has ended (the ?next= return),
 * by showing the same screen with the log-in step open. Nothing about a
 * customer is on this page; the PIN goes once to /api/app/auth.
 */
import Landing from '../../components/app/Landing.js';

export default function Login() {
  return <Landing mode="login" />;
}
