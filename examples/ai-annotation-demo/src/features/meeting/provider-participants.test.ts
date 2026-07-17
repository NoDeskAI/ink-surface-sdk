import { describe, expect, it } from 'vitest';
import { aggregateProviderParticipants, providerParticipantLines } from './provider-participants';

describe('provider meeting participant aggregation', () => {
  it('merges rejoin intervals by display name and identity and sums duration', () => {
    const participants = [
      { name: 'Ada', joined_at: '2026-07-18T09:00:00', left_at: '2026-07-18T09:20:00', identity: 'signed_in' as const },
      { name: 'Grace', joined_at: '2026-07-18T09:02:00', left_at: '2026-07-18T09:12:00', identity: 'external_email' as const },
      { name: 'Ada', joined_at: '2026-07-18T09:30:00', left_at: '2026-07-18T09:45:00', identity: 'signed_in' as const },
    ];

    expect(aggregateProviderParticipants(participants)).toMatchObject([
      { name: 'Ada', identity: 'signed_in', total_duration_ms: 35 * 60_000, intervals: [{ joined_at: '2026-07-18T09:00:00' }, { joined_at: '2026-07-18T09:30:00' }] },
      { name: 'Grace', identity: 'external_email', total_duration_ms: 10 * 60_000 },
    ]);
    expect(providerParticipantLines(participants)).toEqual([
      'Ada · 共 35 分钟 · 2 段：09:00–09:20、09:30–09:45',
      'Grace（访客） · 共 10 分钟 · 09:02–09:12',
    ]);
  });

  it('keeps equal display names with different identities separate and labels anonymous guests', () => {
    expect(providerParticipantLines([
      { name: '访客 1', joined_at: '2026-07-18T09:00:00', left_at: '2026-07-18T09:05:00', identity: 'anonymous' },
      { name: '访客 1', joined_at: '2026-07-18T09:00:00', left_at: '2026-07-18T09:08:00', identity: 'signed_in' },
    ])).toEqual([
      '访客 1（访客） · 共 5 分钟 · 09:00–09:05',
      '访客 1 · 共 8 分钟 · 09:00–09:08',
    ]);
  });

  it('returns no rows for missing or empty data', () => {
    expect(aggregateProviderParticipants(undefined)).toEqual([]);
    expect(providerParticipantLines([])).toEqual([]);
  });
});
