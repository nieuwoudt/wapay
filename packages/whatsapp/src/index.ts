/**
 * The WhatsApp package's public surface: one sender, one template catalogue.
 *
 * A second, older client lived here until 2026-09-18: a `WhatsAppClient` class
 * with its own `sendTemplate`/`sendText`, a `Templates` builder object and a
 * `formatCurrencyCents` helper, plus an orphaned `templates.ts` beside it.
 * Nothing in the running product ever used them (their only importer was
 * `apps/api`, which is outside the build and does not compile), and a second
 * way to send meant a second way to send that lib/say.js does not record, so
 * a message could reach a customer without reaching the agent's memory.
 * Every send now goes through `send.ts` and, in the app, through lib/say.js.
 */
// Export template seeding and catalog functions
export { seedWhatsappTemplates } from './seedTemplates.js';
export { buildCatalog, resolveLanguage, isApproved, getAvailableTemplates, getAvailableLanguages } from './templateCatalog.js';
export { sendWhatsAppTemplate, sendWhatsAppText, sendWhatsAppCtaUrl, buildCtaUrlPayload, sendWhatsAppUtilityDirect, directSendEnabled, authTemplateComponents, sendTypingIndicator, outboundSendCount, runWithSendScope } from './send.js';
export type { SendTemplateArgs, SendTextArgs, SendCtaUrlArgs } from './send.js';

