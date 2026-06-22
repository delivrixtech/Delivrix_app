export interface TransientSshRetryResult<T> {
  result: T;
  attempts: number;
  settleMs: number;
}

export async function runWithTransientSshRetry<T>(input: {
  operation: () => Promise<T>;
  sleep: (ms: number) => Promise<void>;
  retryDelaysMs?: number[];
}): Promise<TransientSshRetryResult<T>> {
  const retryDelaysMs = input.retryDelaysMs ?? [30_000, 60_000];
  const errors: string[] = [];
  let settleMs = 0;
  const maxAttempts = retryDelaysMs.length + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return {
        result: await input.operation(),
        attempts: attempt,
        settleMs
      };
    } catch (error) {
      errors.push(errorMessage(error));
      if (!isTransientSshConnectError(error) || attempt === maxAttempts) {
        throw new Error(`SSH connect failed after ${attempt} attempt(s): ${errors.join(" | ")}`);
      }
      const delay = retryDelaysMs[attempt - 1] ?? 0;
      settleMs += delay;
      await input.sleep(delay);
    }
  }

  throw new Error(`SSH connect failed after ${maxAttempts} attempt(s): ${errors.join(" | ")}`);
}

export function isTransientSshConnectError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("timed out") ||
    message.includes("exit 255") ||
    message.includes("connection refused") ||
    message.includes("connection reset") ||
    message.includes("no route to host");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
