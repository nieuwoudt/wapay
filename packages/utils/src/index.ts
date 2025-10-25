export function maskVoucherPin(pin: string): string {
  if (!pin) return '';
  const last4 = pin.slice(-4);
  return `****${last4}`;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}


