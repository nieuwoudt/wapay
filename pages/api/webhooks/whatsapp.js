/**
 * WhatsApp Webhook Handler
 * 
 * Handles:
 * 1. Webhook verification (GET)
 * 2. Incoming messages (POST)
 */
import { processMessage } from './message-processor-v2.js';
import { isReady } from '../../../lib/initTemplates.js';
import { ensureTemplatesReady } from './_middleware.js';
import { checkInboundWebhook, readRawBody } from '../../../lib/webhook-security.js';
import { claimMessage } from '../../../lib/ledger-post.js';

// X-Hub-Signature-256 is an HMAC over the EXACT raw bytes Meta sent; Next's
// body parser must stay off so those bytes are available. GET verification
// only reads query params, so it is unaffected.
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  
  // GET: Webhook verification
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log('Webhook verification request:', { mode, token: token ? 'present' : 'missing', challenge });

    // Verify token comes ONLY from env — the old hardcoded fallback value is
    // public knowledge, so an unset env var must fail verification, not open it.
    const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN || process.env.META_WEBHOOK_VERIFY_TOKEN;

    if (mode === 'subscribe' && expectedToken && token === expectedToken) {
      console.log('✅ Webhook verified successfully!');
      return res.status(200).send(challenge);
    } else {
      console.error('❌ Webhook verification failed:', { mode, tokenMatch: token === expectedToken });
      return res.status(403).send('Forbidden');
    }
  }

  // POST: Handle incoming messages
  if (req.method === 'POST') {
    // IMPORTANT:
    // - Meta expects a fast 200 OK from the webhook. If we block on template seeding
    //   or message processing, Meta can consider the delivery failed/retry.
    // - So we ACK immediately, then process asynchronously (best-effort).
    // - The ONLY things allowed before the ACK are signature verification and
    //   JSON parsing — an unverified payload must never reach processing.

    let rawBody;
    try {
      rawBody = await readRawBody(req);
    } catch (error) {
      console.error(JSON.stringify({ type: 'wa_webhook_body_read_error', error: error?.message }));
      return res.status(400).json({ error: 'invalid body' });
    }

    const check = checkInboundWebhook({
      rawBody,
      signatureHeader: req.headers['x-hub-signature-256'],
      appSecret: process.env.META_APP_SECRET,
      env: process.env,
    });

    if (!check.ok) {
      console.error(JSON.stringify({ type: 'wa_webhook_signature_rejected', reason: check.reason }));
      return res.status(401).json({ error: 'invalid signature' });
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      console.error(JSON.stringify({ type: 'wa_webhook_invalid_json' }));
      return res.status(400).json({ error: 'invalid json' });
    }

    // Processing MUST complete before the ACK. On Vercel serverless,
    // execution after the response is not guaranteed — a fire-and-forget
    // block here is silently killed, which reads as a mute bot (this exact
    // failure shipped on 2026-08-18 and cost a morning of debugging; the
    // long-running January deployment awaited, which is why it was stable).
    // Meta tolerates several seconds before retrying; typical processing is
    // 2–10s, within the 60s function budget. Errors still ACK 200 so Meta
    // does not retry-storm — message dedupe makes replays safe regardless.
    await (async () => {
      try {
        // Best-effort template initialization: never block the webhook ACK on this.
        if (!isReady()) {
          console.log('⏳ Templates not ready (non-blocking init)...');
          try {
            await ensureTemplatesReady();
            console.log('✅ Templates initialized successfully');
          } catch (error) {
            console.error('❌ Template init failed (continuing without blocking):', error);
          }
        }

        // Log incoming webhook for debugging (keep it single-line for Vercel)
        console.log('📱 Incoming WhatsApp webhook:', JSON.stringify(body));

        // Check if this is a WhatsApp message event
        if (body?.object === 'whatsapp_business_account') {
          const entries = body.entry || [];

          for (const entry of entries) {
            const changes = entry.changes || [];

            for (const change of changes) {
              if (change.field === 'messages') {
                const value = change.value || {};
                const messages = value.messages || [];
                const contacts = value.contacts || [];
                const contact = contacts[0] || {};
                const profile = contact.profile || {};

                for (const message of messages) {
                  const from = message.from; // User's WhatsApp ID
                  const messageId = message.id;
                  const messageType = message.type;
                  const timestamp = message.timestamp;

                  console.log(
                    '📩 Received message:',
                    JSON.stringify({
                      from,
                      messageId,
                      messageType,
                      timestamp,
                      profile: profile?.name || 'Unknown',
                    })
                  );

                  // De-dupe: Meta retries deliveries, and a replayed message must
                  // not drive a second money flow. claimMessage is a DB-unique
                  // insert — false means this wa message id was already handled.
                  // Status callbacks never enter this loop, so they are unaffected.
                  if (messageId) {
                    let claimed = true;
                    try {
                      claimed = await claimMessage({ waMessageId: messageId, accountId: undefined });
                    } catch (dedupeError) {
                      // Availability over dedupe: if the dedupe store is down we
                      // still process (accepting duplicate risk) rather than
                      // dropping the message.
                      console.error(
                        JSON.stringify({
                          type: 'wa_webhook_dedupe_error',
                          messageId,
                          error: dedupeError?.message,
                        })
                      );
                    }
                    if (!claimed) {
                      console.log(JSON.stringify({ type: 'wa_webhook_duplicate', messageId }));
                      continue;
                    }
                  }

                  // Handle different message types
                  if (messageType === 'text') {
                    const text = message.text?.body || '';
                    console.log('💬 Text message:', text);

                    await processMessage({
                      from,
                      text,
                      messageId,
                      profile,
                    });
                  }

                  // Shared contact card — "send money to this person in my
                  // contacts". The processor turns it into a recipient (and
                  // remembers it as a beneficiary); previously these were
                  // silently dropped and the user had to type the number.
                  if (messageType === 'contacts') {
                    const shared = message.contacts?.[0];
                    const phone = shared?.phones?.[0] || {};
                    const sharedContact = {
                      // wa_id is already digits-only and country-prefixed;
                      // fall back to the display phone string.
                      rawNumber: phone.wa_id || phone.phone || '',
                      name:
                        shared?.name?.formatted_name ||
                        shared?.name?.first_name ||
                        null,
                    };
                    console.log(
                      '👤 Contact shared:',
                      JSON.stringify({ hasNumber: Boolean(sharedContact.rawNumber), name: sharedContact.name })
                    );

                    await processMessage({
                      from,
                      text: '',
                      messageId,
                      profile,
                      sharedContact,
                    });
                  }

                  // Template quick-reply buttons
                  if (messageType === 'button') {
                    const buttonPayload = message.button?.payload || '';
                    const buttonText = message.button?.text || '';

                    console.log(
                      '🔘 Template button clicked:',
                      JSON.stringify({
                        payload: buttonPayload,
                        text: buttonText,
                        template: 'Template button (quick_reply type)',
                      })
                    );

                    await processMessage({
                      from,
                      text: buttonText || buttonPayload || 'continue',
                      messageId,
                      profile,
                    });
                  }

                  // Interactive messages (button_reply, list_reply, product selection)
                  if (messageType === 'interactive') {
                    const interactiveType = message.interactive?.type;
                    console.log('🔘 Interactive message type:', interactiveType);

                    if (interactiveType === 'button_reply') {
                      const buttonId = message.interactive?.button_reply?.id;
                      const buttonTitle = message.interactive?.button_reply?.title;

                      console.log(
                        '🔘 Interactive button clicked:',
                        JSON.stringify({ id: buttonId, title: buttonTitle })
                      );

                      await processMessage({
                        from,
                        text: buttonTitle || buttonId || 'continue',
                        messageId,
                        profile,
                      });
                    }

                    if (interactiveType === 'list_reply') {
                      const listId = message.interactive?.list_reply?.id;
                      const listTitle = message.interactive?.list_reply?.title;
                      const listDescription = message.interactive?.list_reply?.description;

                      console.log(
                        '📋 List item selected:',
                        JSON.stringify({ id: listId, title: listTitle, description: listDescription })
                      );

                      await processMessage({
                        from,
                        text: listTitle || listId || 'continue',
                        messageId,
                        profile,
                      });
                    }

                    if (interactiveType === 'product') {
                      const productId = message.interactive?.product?.id;
                      const productRetailerId = message.interactive?.product?.retailer_id;

                      console.log(
                        '🛍️ Product selected:',
                        JSON.stringify({ id: productId, retailerId: productRetailerId })
                      );

                      await processMessage({
                        from,
                        text: `Product: ${productRetailerId || productId}`,
                        messageId,
                        profile,
                      });
                    }

                    if (interactiveType === 'nfm_reply') {
                      const nfmReply = message.interactive?.nfm_reply;
                      console.log('📱 Flow reply received:', JSON.stringify(nfmReply));

                      await processMessage({
                        from,
                        text: 'Flow completed',
                        messageId,
                        profile,
                      });
                    }
                  }
                }
              }

              if (change.field === 'message_status') {
                const statuses = change.value?.statuses || [];
                for (const status of statuses) {
                  console.log(
                    '📊 Message status update:',
                    JSON.stringify({
                      id: status.id,
                      status: status.status,
                      timestamp: status.timestamp,
                    })
                  );
                }
              }
            }
          }
        }
      } catch (error) {
        console.error('❌ Error processing WhatsApp webhook:', error);
      }
    })();

    res.status(200).json({ ok: true });
    console.log('✅ WA_WEBHOOK_ACK_SENT');
    return;
  }

  // Method not allowed
  return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
}

