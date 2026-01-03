/**
 * Send a message exactly-once per errorKey.
 *
 * This is used to prevent duplicate user-facing error messages when:
 * - a flow is re-entrant
 * - the provider retries internally
 * - WhatsApp delivers duplicate inbound events
 */

export async function sendTextOnce({ to, errorKey, text, wasSent, markSent, send }) {
  if (!to || !text) return { ok: false };
  const key = String(errorKey || '');
  if (!key) {
    // No key means we cannot dedupe; still send (but callers should always supply a key).
    return await send({ to, text });
  }

  const already = await wasSent(to, key);
  if (already) return { ok: true, dedup: true };

  const result = await send({ to, text });
  await markSent(to, key);
  return result;
}


