/**
 * Field-level encryption for the few customer values we keep that are more
 * sensitive than a cellphone number: a bank account number and an ID number
 * saved for the next withdrawal (founder ask 2026-10-04, "we only have to ask
 * them once"). AES-256-GCM under WAPAY_PII_KEY; every stored value carries the
 * key version it was written with so the key can be rotated: set
 * WAPAY_PII_KEY_VERSION=2 and WAPAY_PII_KEY to the new key, keep the old one
 * as WAPAY_PII_KEY_V1, and old rows still decrypt.
 *
 * Nothing here logs a plaintext, and a missing key is a typed refusal, never
 * a silent fallback to plaintext storage: without the key the beneficiary
 * feature is simply not offered (lib/payout-beneficiaries.js).
 */
import crypto from 'node:crypto';

const PREFIX = 'enc1';

export function currentKeyVersion() {
  const v = Number(process.env.WAPAY_PII_KEY_VERSION || 1);
  return Number.isInteger(v) && v >= 1 ? v : 1;
}

/** The 32-byte key for a version (hex or base64), or null when it is not configured. */
function keyFor(version) {
  const v = Number(version) || currentKeyVersion();
  const raw = v === currentKeyVersion() ? process.env.WAPAY_PII_KEY : process.env[`WAPAY_PII_KEY_V${v}`];
  if (!raw) return null;
  const s = String(raw).trim();
  const buf = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  return buf.length === 32 ? buf : null;
}

export function vaultConfigured() {
  return !!keyFor(currentKeyVersion());
}

const typed = (code, message) => Object.assign(new Error(message), { code });

/** Encrypt a short string. Returns { enc, keyVersion }. Throws VAULT_NOT_CONFIGURED. */
export function encryptPii(plain) {
  const keyVersion = currentKeyVersion();
  const key = keyFor(keyVersion);
  if (!key) throw typed('VAULT_NOT_CONFIGURED', 'WAPAY_PII_KEY is not set (32 bytes, hex or base64)');
  const text = String(plain ?? '');
  if (!text) throw typed('VAULT_EMPTY', 'nothing to encrypt');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc: [PREFIX, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':'), keyVersion };
}

/** Decrypt a value written by encryptPii. Throws VAULT_NOT_CONFIGURED / VAULT_BAD_VALUE. */
export function decryptPii(enc, keyVersion = 1) {
  const parts = String(enc || '').split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) throw typed('VAULT_BAD_VALUE', 'not an encrypted value');
  const key = keyFor(keyVersion);
  if (!key) throw typed('VAULT_NOT_CONFIGURED', `no key for version ${keyVersion}`);
  const [, ivB, tagB, ctB] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw typed('VAULT_BAD_VALUE', 'authentication failed');
  }
}

/** The last three digits of a number, the one mask used everywhere (never more). */
export function last3(value) {
  const d = String(value ?? '').replace(/\D/g, '');
  return d.slice(-3);
}
export function maskDigits(value) {
  const l = last3(value);
  return l ? `•••${l}` : '•••';
}
