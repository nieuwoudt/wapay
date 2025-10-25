export async function handler() {
  // placeholder for cron/recon entrypoint
  return { ok: true };
}

if (process.env.NODE_ENV !== 'production') {
  handler().then(console.log).catch(console.error);
}


