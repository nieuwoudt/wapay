export type TemplateName =
  | 'redeem_in_progress'
  | 'deposit_receipt'
  | 'deposit_failed'
  | 'topup_collect_number'
  | 'airtime_select_amount'
  | 'airtime_preview_confirm'
  | 'airtime_receipt'
  | 'data_select_bundle'
  | 'data_preview_confirm'
  | 'data_receipt';

export function formatCurrencyCents(cents: number): string {
  return (cents / 100).toFixed(2);
}


