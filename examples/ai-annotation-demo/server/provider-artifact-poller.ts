/**
 * 会议 provider 产物轮询骨架：统一负责退避梯度、终态定期重查、per-key single-flight，
 * 以及状态文件的 tmp+rename 原子 merge-save。候选发现与产物解析由各 provider 自己实现。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ProviderArtifactPollStep {
  attempt: number;
  nextCheckAt?: string;
  exhausted: boolean;
}

export interface ProviderArtifactTerminalState {
  terminal: boolean;
  updated_at?: string;
}

export function providerArtifactNextPoll(
  anchorMs: number,
  nowMs: number,
  minuteLadder: readonly number[],
): ProviderArtifactPollStep {
  if (!minuteLadder.length) return { attempt: 0, exhausted: true };
  const elapsedMinutes = Math.max(0, nowMs - anchorMs) / 60_000;
  const attempt = minuteLadder.filter((minute) => elapsedMinutes >= minute).length;
  const nextMinute = minuteLadder[attempt];
  return {
    attempt,
    ...(nextMinute !== undefined ? { nextCheckAt: new Date(anchorMs + nextMinute * 60_000).toISOString() } : {}),
    exhausted: elapsedMinutes >= minuteLadder[minuteLadder.length - 1],
  };
}

/** 终态不是永久封死：超过重查间隔后重新发现候选，允许晚到产物把终态翻转。 */
export function providerArtifactTerminalRecheckDue(
  state: ProviderArtifactTerminalState | undefined,
  nowMs: number,
  recheckIntervalMs: number,
): boolean {
  if (!state?.terminal) return false;
  const updatedMs = Date.parse(state.updated_at || '');
  return !Number.isFinite(updatedMs) || nowMs - updatedMs >= recheckIntervalMs;
}

export function loadProviderArtifactState<T>(
  path: string,
  fallback: () => T,
  normalize?: (parsed: unknown) => T,
): T {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return normalize ? normalize(parsed) : parsed as T;
  } catch {
    return fallback();
  }
}

export function atomicSaveProviderArtifactState<T>(path: string, state: T): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 写入失败时清理尚存的临时文件 */ }
    throw error;
  }
}

/** 写时重读并只合并自己的 key，避免不同会议在长网络请求后用旧快照互相覆盖。 */
export function mergeSaveProviderArtifactJob<TState, TJob>(input: {
  path: string;
  key: string;
  job: TJob;
  load: (path: string) => TState;
  meetings: (state: TState) => Record<string, TJob>;
}): void {
  const fresh = input.load(input.path);
  input.meetings(fresh)[input.key] = input.job;
  atomicSaveProviderArtifactState(input.path, fresh);
}

/** 同一 provider key 同时只跑一个任务；可等待另一个同 key 锁完成后再开始。 */
export class ProviderArtifactSingleFlight<T> {
  readonly #jobs = new Map<string, Promise<T>>();

  has(key: string): boolean {
    return this.#jobs.has(key);
  }

  pending(key: string): Promise<T> | undefined {
    return this.#jobs.get(key);
  }

  run(key: string, task: () => Promise<T>, waitFor?: Promise<unknown>): Promise<T> {
    const current = this.#jobs.get(key);
    if (current) return current;
    const job = Promise.resolve(waitFor)
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (this.#jobs.get(key) === job) this.#jobs.delete(key);
      });
    this.#jobs.set(key, job);
    return job;
  }
}
