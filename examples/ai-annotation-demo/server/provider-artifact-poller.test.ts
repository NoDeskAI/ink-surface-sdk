import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  atomicSaveProviderArtifactState,
  loadProviderArtifactState,
  mergeSaveProviderArtifactJob,
  providerArtifactNextPoll,
  providerArtifactTerminalRecheckDue,
  ProviderArtifactSingleFlight,
} from './provider-artifact-poller';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('provider artifact poller', () => {
  it('computes an anchor-based ladder and periodically rechecks terminal states', () => {
    const anchor = Date.parse('2026-07-17T00:00:00.000Z');
    expect(providerArtifactNextPoll(anchor, anchor + 6 * 60_000, [2, 5, 15])).toEqual({
      attempt: 2,
      nextCheckAt: '2026-07-17T00:15:00.000Z',
      exhausted: false,
    });
    expect(providerArtifactNextPoll(anchor, anchor + 15 * 60_000, [2, 5, 15])).toEqual({
      attempt: 3,
      exhausted: true,
    });
    const terminal = { terminal: true, updated_at: '2026-07-17T00:00:00.000Z' };
    expect(providerArtifactTerminalRecheckDue(terminal, anchor + 9 * 60_000, 10 * 60_000)).toBe(false);
    expect(providerArtifactTerminalRecheckDue(terminal, anchor + 10 * 60_000, 10 * 60_000)).toBe(true);
  });

  it('atomically merge-saves one key without clobbering another key', () => {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-provider-poller-'));
    roots.push(root);
    const path = join(root, 'state.json');
    type State = { schema: 'v1'; meetings: Record<string, { status: string }> };
    const fallback = (): State => ({ schema: 'v1', meetings: {} });
    const load = (input: string) => loadProviderArtifactState<State>(input, fallback);
    atomicSaveProviderArtifactState(path, { schema: 'v1', meetings: { first: { status: 'ready' } } });
    mergeSaveProviderArtifactJob({
      path,
      key: 'second',
      job: { status: 'pending' },
      load,
      meetings: (state) => state.meetings,
    });
    expect(JSON.parse(readFileSync(path, 'utf8')).meetings).toEqual({
      first: { status: 'ready' },
      second: { status: 'pending' },
    });
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('single-flights concurrent work for the same key', async () => {
    const gate = new ProviderArtifactSingleFlight<string>();
    let release!: (value: string) => void;
    const task = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const first = gate.run('meeting', task);
    const second = gate.run('meeting', task);
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(1));
    release('ready');
    await expect(Promise.all([first, second])).resolves.toEqual(['ready', 'ready']);
  });
});
