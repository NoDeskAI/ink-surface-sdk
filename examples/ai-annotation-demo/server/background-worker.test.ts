import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeadlineSingleFlight } from './background-worker';

describe('deadline single-flight background worker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips overlapping runs', async () => {
    let release!: () => void;
    const gate = createDeadlineSingleFlight({ timeoutMs: 60_000, label: 'test worker' });
    const first = gate.run(() => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();

    expect(await gate.run(async () => {})).toBe(false);
    release();
    await expect(first).resolves.toBe(true);
  });

  it('aborts a hung task and permits the next scheduled run', async () => {
    vi.useFakeTimers();
    const gate = createDeadlineSingleFlight({ timeoutMs: 1_000, label: 'test worker' });
    let observedSignal: AbortSignal | undefined;
    const hung = gate.run(async (signal) => {
      observedSignal = signal;
      await new Promise<void>(() => {});
    });
    const timedOut = expect(hung).rejects.toMatchObject({
      name: 'TimeoutError',
      code: 'background_worker_timeout',
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await timedOut;
    expect(observedSignal?.aborted).toBe(true);
    await expect(gate.run(async () => {})).resolves.toBe(true);
  });
});
