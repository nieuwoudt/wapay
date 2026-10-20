/**
 * In-flight flow data sealed at rest (BUGLOG #113; founder 2026-10-16: "even
 * the bank information needs to be securely stored, and the IDs, all of
 * that"). A withdrawal in progress keeps the bank account number and the ID
 * or passport number the customer typed in Account.conversationData until
 * the flow ends. Saved details were already encrypted (lib/pii-vault.js);
 * these were plain JSON in the row for as long as the flow lived (Lisa's sat
 * there four hours on 2026-10-15).
 *
 *   sealFlowData(data)    every sensitive path becomes { $sealed, v } under
 *                         WAPAY_PII_KEY (AES-256-GCM, key versioned). Called
 *                         on every write (updateConversationState).
 *   unsealFlowData(data)  the reverse, on every read (getConversationState).
 *                         A sealed value that cannot be opened (the key was
 *                         removed) makes the whole flow unreadable: the
 *                         caller starts fresh, never with half the data.
 *
 * Without WAPAY_PII_KEY nothing is sealed (the code runs as before), and a
 * plain value written before the key existed still reads: the next write
 * seals it. All paths are sealed in one pass or the write throws; a row is
 * never half-sealed by this code. Pure apart from the vault's crypto.
 */
import { vaultConfigured, encryptPii, decryptPii } from './pii-vault.js';

export const SEALED_PATHS = Object.freeze([['recipient', 'account_number'], ['recipient', 'id_number'], ['idPending']]);

const isSealed = (v) => !!v && typeof v === 'object' && typeof v.$sealed === 'string';

function get(obj, path) {
  return path.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}
function set(obj, path, value) {
  const out = { ...obj };
  let cur = out;
  for (let i = 0; i < path.length - 1; i += 1) {
    cur[path[i]] = { ...(cur[path[i]] || {}) };
    cur = cur[path[i]];
  }
  cur[path[path.length - 1]] = value;
  return out;
}

/** Seal every sensitive path; plain when no key is configured. Throws if the vault fails mid-way. */
export function sealFlowData(data) {
  if (!data || typeof data !== 'object' || !vaultConfigured()) return data;
  let out = data;
  for (const path of SEALED_PATHS) {
    const v = get(out, path);
    if (v == null || v === '' || isSealed(v)) continue;
    const { enc, keyVersion } = encryptPii(String(v));
    out = set(out, path, { $sealed: enc, v: keyVersion });
  }
  return out;
}

/** Open every sealed path. { data, unreadable } where unreadable means start fresh. */
export function unsealFlowData(data) {
  if (!data || typeof data !== 'object') return { data, unreadable: false };
  let out = data;
  for (const path of SEALED_PATHS) {
    const v = get(out, path);
    if (!isSealed(v)) continue;
    try {
      out = set(out, path, decryptPii(v.$sealed, v.v || 1));
    } catch {
      return { data: null, unreadable: true };
    }
  }
  return { data: out, unreadable: false };
}

/** True when any sensitive path is still plain (diagnostics and tests). */
export function hasPlainSecrets(data) {
  return SEALED_PATHS.some((p) => { const v = get(data, p); return v != null && v !== '' && !isSealed(v); });
}
