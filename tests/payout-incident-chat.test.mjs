/**
 * The 28 October incident replayed through the REAL message processor (BUGLOG #145 to #148; incident Build
 * rule 7: "Replay Ruth's evening … it must pass before release and stay in the regression suite").
 * tests/helpers/payout-incident-chat-run.mjs runs processMessage in a child process with the WhatsApp transport
 * captured, the database in memory and no model, and asserts what was actually sent:
 *
 * - while a R100 waits for approval with R116 set aside, "withdraw R228 to my capitec account" names the open
 *   withdrawal and starts nothing (no R228 confirmation, no second row);
 * - "Nothing is coming in to my bank account" is answered from the pay-out rows: the R100 that didn't go
 *   through and why, the R325 that was paid, nothing on its way, the balance; never the withdraw opener;
 * - "person" reaches a person; a fresh "withdraw R100" still starts the flow;
 * - a Pay agent pilot number gets the same answer before the agent, with no model call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
let result = null;
function run() {
  if (result) return result;
  const child = spawnSync(process.execPath, ['--no-warnings', '--experimental-test-module-mocks', fileURLToPath(new URL('./helpers/payout-incident-chat-run.mjs', import.meta.url))], {
    cwd: root,
    env: { ...process.env, WAPAY_ROOT: root, NODE_ENV: 'test', WAPAY_AGENT_V3_MSISDNS: '', OPENAI_API_KEY: '', WAPAY_PAYOUT_ENABLED: 'true', WAPAY_PAYOUT_KYC: 'off', WAPAY_PAYOUT_ALLOWLIST: '', WAPAY_OPS_ALERT_MSISDNS: '', ALERT_EMAIL: '', WAPAY_SUPPORT_WHATSAPP: '060 000 0000', OTT_PAYOUT_BASE_URL: '', WAPAY_PII_KEY: '' },
    encoding: 'utf8',
    timeout: 120000,
  });
  const line = String(child.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `no RESULT line; exit ${child.status}\nstdout: ${String(child.stdout).slice(-2000)}\nstderr: ${String(child.stderr).slice(-3000)}`);
  result = JSON.parse(line.slice('RESULT '.length));
  assert.equal(result.error, undefined, result.error);
  return result;
}
const one = (turn) => {
  assert.equal(turn.length, 1, `exactly one message, got ${turn.length}: ${JSON.stringify(turn)}`);
  return turn[0].text;
};
const plain = (t) => { assert.ok(!/bank rail|—/.test(t), `no jargon and no em dash: ${t}`); return t; };

test('21:18, a R100 waiting for approval: a second withdrawal names it and starts nothing', () => {
  const { second, status1 } = run();
  const text = plain(one(second.turn));
  assert.match(text, /^⏳ You already have a withdrawal waiting for approval: R100 by PayShap to your bank account •••918 \(reference WP161EF3F64B2374\)\. R116 is set aside for it\./);
  assert.match(text, /Say \*cancel withdrawal\* to cancel it/);
  assert.match(text, /💰 Balance: R360: R244 available and R116 set aside/);
  assert.ok(!/R228|Balance after|How much/.test(text), 'no second offer, no confirmation');
  assert.equal(second.state, null);
  assert.deepEqual(second.payouts, [{ status: 'AWAITING_APPROVAL', amountCents: 10000 }], 'no second row');
  const s = plain(one(status1.turn));
  assert.match(s, /⏳ R100 by PayShap to your bank account •••918, today at \d\d:\d\d: waiting for approval\./);
  assert.ok(!/Nothing is on its way/.test(s));
});

test('22:13, "Nothing is coming in to my bank account": the withdrawals from the record, never the withdraw opener', () => {
  const { complaint, why } = run();
  const text = plain(one(complaint.turn));
  assert.match(text, /^🔎 I checked your withdrawals:/);
  assert.match(text, /❌ R100 by PayShap to your bank account •••918, today at \d\d:\d\d: didn't go through, because the bank's payment system did not complete it\. The R100 and the R16 fee came back to your balance\. \(WP161EF3F64B2374\)/);
  assert.match(text, /✅ R325 by PayShap to your bank account •••918, yesterday at \d\d:\d\d: paid\./);
  assert.match(text, /Nothing is on its way to your bank right now\./);
  assert.match(text, /💰 Balance: R420\./);
  assert.match(text, /Reply \*person\* to talk to someone from WaPay\./);
  assert.ok(!/🏦|How much\?|so up to/.test(text), 'not the PayShap opener of 22:14');
  assert.equal(complaint.state, null, 'no withdraw flow was started');
  assert.equal(one(why.turn), text, '"why did my withdrawal fail" gets the same answer');
});

test('"person" reaches a person; a fresh "withdraw R100" still starts the withdrawal', () => {
  const { person, fresh } = run();
  assert.equal(one(person.turn), '🙋 To talk to a person from the WaPay team, WhatsApp 060 000 0000. Your money is safe.');
  const f = one(fresh.turn);
  assert.match(String(fresh.state || ''), /^PAYOUT_/, `the flow started: ${fresh.state}`);
  assert.ok(!/I checked your withdrawals|You already have a withdrawal/.test(f));
});

test('a Pay agent pilot number: the complaint is answered before the agent, from the record, with no model call', () => {
  const { agent } = run();
  assert.match(plain(one(agent.turn)), /^🔎 I can't see a withdrawal from your WaPay balance in the last 7 days, so nothing is on its way to your bank from WaPay\.\n\n💰 Balance: R50\./);
  assert.equal(agent.agentCalls, 0);
  assert.equal(agent.state, null);
});
