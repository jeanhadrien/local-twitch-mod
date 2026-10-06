// Retry helper: fixed backoff delays, status-aware.
// Policy: initial attempt + one retry per delay entry. Default [500, 1000, 2000]
// means 4 attempts total, then the last error is thrown.
// Retryable: HTTP 429 / 5xx, network failures, timeouts (aborts).
// Fail fast: 400/401/403 and other client errors (401 = re-login, not retry).
export const DEFAULT_RETRY_DELAYS_MS = [500, 1000, 2000];

/** HTTP error carrying its status so retry logic can classify it. */
export class HttpStatusError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** True if another attempt is worth making. */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof HttpStatusError) return isRetryableStatus(err.status);
  // fetch network failure (TypeError) or timeout via AbortController.
  if (err instanceof TypeError) return true;
  return (
    err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run fn with fixed-delay retries. Throws the last error when exhausted. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  delaysMs: number[] = DEFAULT_RETRY_DELAYS_MS,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= delaysMs.length || !isRetryableError(err)) throw err;
      await sleep(delaysMs[attempt]);
      attempt++;
    }
  }
}
