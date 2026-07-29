import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MeetingPostprocessMarketStore } from './market-store';

describe('MeetingPostprocessMarketStore', () => {
  it('saves immutable prompt versions and lists newest first', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'market-store-')), 'prompts.json');
    const store = new MeetingPostprocessMarketStore(path);
    store.save({ template_id: 'meeting_expert', base_version: 'meeting_expert.v3', name: 'A', prompt: 'prompt A', model: 'gpt-5.5' }, new Date('2026-07-27T01:00:00.000Z'));
    store.save({ template_id: 'meeting_expert', base_version: 'meeting_expert.v3', name: 'B', prompt: 'prompt B', model: 'gpt-5.4' }, new Date('2026-07-27T02:00:00.000Z'));

    expect(store.list('meeting_expert').map((item) => item.name)).toEqual(['B', 'A']);
    expect(JSON.parse(readFileSync(path, 'utf8')).schema_version).toBe('inkloop.postprocess-market-prompts.v1');
  });
});
