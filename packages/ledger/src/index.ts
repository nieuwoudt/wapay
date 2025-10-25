export type JournalPosting = {
  accountCode: string;
  debitCents?: number;
  creditCents?: number;
};

export function validateBalanced(postings: JournalPosting[]): void {
  const debit = postings.reduce((s, p) => s + (p.debitCents || 0), 0);
  const credit = postings.reduce((s, p) => s + (p.creditCents || 0), 0);
  if (debit !== credit) {
    throw new Error(`Journal not balanced: debit=${debit} credit=${credit}`);
  }
}


