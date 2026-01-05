/**
 * Test helper that mirrors callWithRetry logic from vas.ts.
 * Keeps tests in JS so node --test can run without TS loaders.
 */
export async function callWithRetryTestHarness(fn, maxAttempts = 3) {
  let attempts = 0;
  try {
    const result = await (async function retry() {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        attempts = attempt;
        try {
          return await fn();
        } catch (error) {
          const code = error?.message;
          if (code === 'USER_INPUT' || code === 'AUTH' || code === 'INVALID_PHONE_NUMBER') {
            throw error;
          }
          if (attempt === maxAttempts) throw error;
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        }
      }
    })();
    return { attempts, result };
  } catch (error) {
    return { attempts, error };
  }
}

