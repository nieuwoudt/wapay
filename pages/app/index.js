/**
 * WaPay personal portal: the landing screen (2026-11-24). One chat-style
 * screen for everyone, signed in or not: components/app/Landing.js. Before
 * that date this was the signed-in home (the balance card, four quick actions,
 * open links, the last five movements, the coming-soon tiles); the balance and
 * the movements now open as cards in the thread, links are under Pay
 * (/app/links), and the tiles are on the Pay page.
 */
import Landing from '../../components/app/Landing.js';

export default function Home() {
  return <Landing />;
}
