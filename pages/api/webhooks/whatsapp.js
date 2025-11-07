/**
 * WhatsApp Webhook Handler
 * 
 * Handles:
 * 1. Webhook verification (GET)
 * 2. Incoming messages (POST)
 */
import { processMessage } from './message-processor';
import { isReady, assertReady } from '../../../lib/initTemplates';

export default async function handler(req, res) {
  
  // GET: Webhook verification
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log('Webhook verification request:', { mode, token: token ? 'present' : 'missing', challenge });

    // Verify token matches our environment variable
    const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN || process.env.META_WEBHOOK_VERIFY_TOKEN || 'wapay_webhook_secret_2025';
    
    if (mode === 'subscribe' && token === expectedToken) {
      console.log('✅ Webhook verified successfully!');
      return res.status(200).send(challenge);
    } else {
      console.error('❌ Webhook verification failed:', { mode, tokenMatch: token === expectedToken });
      return res.status(403).send('Forbidden');
    }
  }

  // POST: Handle incoming messages
  if (req.method === 'POST') {
    try {
      // Check if templates are ready
      if (!isReady()) {
        console.warn('⚠️  WhatsApp catalog not ready yet, returning 503');
        return res.status(503).json({ 
          error: 'Service temporarily unavailable', 
          message: 'Templates are still being initialized' 
        });
      }

      const body = req.body;

      // Log incoming webhook for debugging
      console.log('📱 Incoming WhatsApp webhook:', JSON.stringify(body, null, 2));

      // Check if this is a WhatsApp message event
      if (body.object === 'whatsapp_business_account') {
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

                console.log('📩 Received message:', {
                  from,
                  messageId,
                  messageType,
                  timestamp,
                  profile: profile.name || 'Unknown',
                });

                // Handle different message types
                if (messageType === 'text') {
                  const text = message.text?.body || '';
                  console.log('💬 Text message:', text);

                  // Process the message and send response
                  await processMessage({
                    from,
                    text,
                    messageId,
                    profile,
                  });
                }

                if (messageType === 'interactive') {
                  const interactiveType = message.interactive?.type;
                  console.log('🔘 Interactive message:', interactiveType);

                  // TODO: Handle button replies, list replies, etc.
                }
              }
            }

            // Handle message status updates
            if (change.field === 'message_status') {
              const statuses = change.value?.statuses || [];
              for (const status of statuses) {
                console.log('📊 Message status update:', {
                  id: status.id,
                  status: status.status,
                  timestamp: status.timestamp,
                });
              }
            }
          }
        }
      }

      // Always return 200 to acknowledge receipt
      return res.status(200).json({ ok: true, message: 'Webhook received' });

    } catch (error) {
      console.error('❌ Error processing WhatsApp webhook:', error);
      // Still return 200 to prevent Meta from retrying
      return res.status(200).json({ ok: true, error: error.message });
    }
  }

  // Method not allowed
  return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
}

