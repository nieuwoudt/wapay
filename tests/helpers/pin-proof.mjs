// Tests mint the proof verifyPIN issues after a correct PIN (BUGLOG #112):
// executeWithdraw refuses without one, so every money test carries it.
import { issuePinProof } from '@wapay/auth/pin-proof';

if (!process.env.WAPAY_PIN_PROOF_SECRET) process.env.WAPAY_PIN_PROOF_SECRET = 'test-pin-proof-secret';

export const proofFor = (account, data) => issuePinProof({ accountId: account?.id, intentId: data?.intentId, amountCents: data?.amountCents });
