/**
 * @wapay/nlp
 * 
 * Natural Language Processing for WaPay Chat Banking
 * 
 * Features:
 * - Entity extraction (amounts, networks, phone numbers, etc.)
 * - Intent classification (buy airtime, check balance, etc.)
 * - Intent routing (map intents to API endpoints)
 * - Disambiguation (handle missing/ambiguous entities)
 */

export * from './entities';
export * from './intents';
export * from './router';

