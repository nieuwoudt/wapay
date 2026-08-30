/**
 * Generate the WAPAY_ADMIN_PASSWORD_HASH value for Vercel.
 *
 *   node scripts/hash-admin-password.mjs 'your password here'
 *
 * Prints ONE line: the argon2id hash to paste into Vercel. The password
 * itself is never stored, logged, or transmitted — only this hash lives in
 * the environment, and it cannot be reversed into the password.
 *
 * The hash is SELF-CONTAINED (argon2id with its own random salt, no pepper),
 * so it verifies in any environment it is pasted into. It was briefly
 * peppered with PIN_PEPPER, which made locally-generated hashes impossible
 * to verify in production — see the note in lib/admin-auth.js.
 */
import argon2 from 'argon2';

const password = process.argv[2];
if (!password || password.length < 10) {
  console.error('Usage: node --env-file=.env scripts/hash-admin-password.mjs \'<password, 10+ chars>\'');
  process.exit(1);
}
const hash = await argon2.hash(password, {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
});
console.log(hash);
