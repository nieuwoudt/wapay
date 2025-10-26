import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '@wapay/utils';

/**
 * WhatsApp Webhook Handler
 * 
 * Handles:
 * 1. Webhook verification (GET)
 * 2. Incoming messages (POST)
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  
  // GET: Webhook verification
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === env.META_WEBHOOK_VERIFY_TOKEN) {
      console.log('Webhook verified successfully!');
      return res.status(200).send(challenge);
    } else {
      console.error('Webhook verification failed');
      return res.status(403).send('Forbidden');
    }
  }

  // POST: Handle incoming messages
  if (req.method === 'POST') {
    try {
      const body = req.body;

      // Log incoming webhook for debugging
      console.log('Incoming WhatsApp webhook:', JSON.stringify(body, null, 2));

      // Check if this is a WhatsApp message event
      if (body.object === 'whatsapp_business_account') {
        const entries = body.entry || [];

        for (const entry of entries) {
          const changes = entry.changes || [];

          for (const change of changes) {
            if (change.field === 'messages') {
              const messages = change.value?.messages || [];

              for (const message of messages) {
                const from = message.from; // User's WhatsApp ID
                const messageId = message.id;
                const messageType = message.type;
                const timestamp = message.timestamp;

                console.log('Received message:', {
                  from,
                  messageId,
                  messageType,
                  timestamp,
                });

                // Handle different message types
                if (messageType === 'text') {
                  const text = message.text?.body || '';
                  console.log('Text message:', text);

                  // TODO: Process the message (NLP parsing, intent detection, etc.)
                  // For now, just log it
                }

                if (messageType === 'interactive') {
                  const interactiveType = message.interactive?.type;
                  console.log('Interactive message:', interactiveType);

                  // TODO: Handle button replies, list replies, etc.
                }
              }
            }
          }
        }
      }

      // Always return 200 to acknowledge receipt
      return res.status(200).json({ ok: true });

    } catch (error: any) {
      console.error('Error processing WhatsApp webhook:', error);
      // Still return 200 to prevent Meta from retrying
      return res.status(200).json({ ok: true });
    }
  }

  // Method not allowed
  return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
}

