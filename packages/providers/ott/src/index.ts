/**
 * @wapay/providers-ott — OTT Mobile voucher ISSUING rail.
 *
 * Spec: "OTT_Issuing API Rest v6". Endpoints: GetBalance, GetVoucher,
 * CheckVoucher, ConfirmVoucher, RejectVoucher.
 *
 * GetAPIKey is intentionally NOT implemented or exported anywhere in this
 * package: calling it rotates the live API key and invalidates the stored
 * OTT_API_KEY, breaking all hashed calls. See the note in ./client.js.
 */
export * from './types.js';
export { OttClient, hashParams, randToCents, centsToRand } from './client.js';
