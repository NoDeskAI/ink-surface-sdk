export class BackgroundWorkerTimeoutError extends Error {
  override name = 'TimeoutError';
  readonly code = 'background_worker_timeout';
}
export interface DeadlineSingleFlight {
  run(task: (signal: AbortSignal) => Promise<void>): Promise<boolean>;
}

/** Runs at most one task at a time and always releases the gate at the deadline.
 * The race is intentional: AbortSignal stops cooperative I/O, while the deadline
 * still releases the gate if an upstream dependency ignores cancellation. */
export function createDeadlineSingleFlight(input: {
  timeoutMs: number;
  label: string;
}): DeadlineSingleFlight {
  const timeoutMs = Number.isFinite(input.timeoutMs) ? Math.max(1, Math.floor(input.timeoutMs)) : 60_000;
  let inFlight = false;

  return {
    async run(task): Promise<boolean> {
      if (inFlight) return false;
      inFlight = true;
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = new BackgroundWorkerTimeoutError(`${input.label} timed out after ${timeoutMs}ms`);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      });
      const taskPromise = Promise.resolve().then(() => task(controller.signal));

      try {
        await Promise.race([taskPromise, deadline]);
        return true;
      } finally {
        if (timeout) clearTimeout(timeout);
        inFlight = false;
      }
    },
  };
}
