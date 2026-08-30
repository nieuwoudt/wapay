/**
 * Generate the WAPAY_ADMIN_PASSWORD_HASH value for Vercel.
 *
 *   node --env-file=.env scripts/hash-admin-password.mjs 'your password here'
 *
 * Prints ONE line: the argon2id hash to paste into Vercel. The password
 * itself is never stored, logged, or transmitted — only this hash lives in
 * the environment, and it cannot be reversed into the password.
 *
 * NOTE: the hash is bound to PIN_PEPPER, so it must be generated with the
 * same PIN_PEPPER the deployment uses (that is why --env-file=.env matters).
 */
import argon2 from 'argon2';

const password = process.argv[2];
if (!password || password.length < 10) {
  console.error('Usage: node --env-file=.env scripts/hash-admin-password.mjs \'<password, 10+ chars>\'');
  process.exit(1);
}
const pepper = process.env.PIN_PEPPER || '';
if (!pepper) {
  console.error('WARNING: PIN_PEPPER is not set in this shell — the hash will not match production.');
}
const hash = await argon2.hash(password + pepper, {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
});
console.log(hash);
