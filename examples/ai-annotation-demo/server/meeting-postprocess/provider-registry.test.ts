import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deleteProviderMeetingRegistration, listProviderMeetingRegistrations, providerOccurrenceReference, registerProviderMeetings, registrationMatches, resolveProviderMeetingOccurrence } from './provider-registry';

describe('provider meeting registry', () => {
  it('persists device identity mapping for offline Hub workers and updates idempotently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'provider-registry-')); const identity = { tenant_id: 't', user_id: 'u' };
    const value = { meeting_id: 'local-1', provider: 'google' as const, title: 'Planning', provider_calendar_event_id: 'event-1', meeting_code: 'abc-defg-hij', scheduled_at: '2026-07-21T01:00:00.000Z', status: 'upcoming' as const };
    await registerProviderMeetings(root, identity, [value]); await registerProviderMeetings(root, identity, [{ ...value, status: 'ended', ended_at: '2026-07-21T02:00:00.000Z' }]);
    const registrations = listProviderMeetingRegistrations(root, 'google');
    expect(registrations).toHaveLength(1); expect(registrations[0]).toMatchObject({ meeting_id: 'local-1', status: 'ended' });
    expect(registrationMatches(registrations[0], { meeting_code: value.meeting_code, scheduled_at: value.scheduled_at })).toBe(true);
    expect(await deleteProviderMeetingRegistration(root, identity, 'local-1')).toBe(1);
    expect(listProviderMeetingRegistrations(root)).toEqual([]);
  });

  it('tombstones the provider occurrence so another local id cannot recreate it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'provider-registry-delete-')); const identity = { tenant_id: 't', user_id: 'u' };
    const deleted = { meeting_id: 'local-deleted', provider: 'zoom' as const, title: 'Recurring', provider_calendar_event_id: 'occ-1', provider_space_name: '987654321', scheduled_at: '2026-07-21T01:00:00.000Z', status: 'ended' as const };
    await registerProviderMeetings(root, identity, [deleted]);
    await deleteProviderMeetingRegistration(root, identity, deleted.meeting_id);

    await expect(registerProviderMeetings(root, identity, [{ ...deleted, meeting_id: 'new-local-id' }]))
      .rejects.toThrow('provider_meeting_occurrence_deleted');
    await expect(registerProviderMeetings(root, identity, [{ ...deleted, meeting_id: 'next-local-id', provider_calendar_event_id: 'occ-2', scheduled_at: '2026-07-28T01:00:00.000Z' }]))
      .resolves.toHaveLength(1);
  });

  it('resolves one recurring-room occurrence by its nearest start time', () => {
    const shared = {
      schema_version: '1.0' as const,
      tenant_id: 't',
      user_id: 'u',
      provider: 'google' as const,
      title: 'Weekly planning',
      provider_space_name: 'spaces/weekly-room',
      status: 'ended' as const,
      updated_at: '2026-07-28T02:00:00.000Z',
    };
    const registrations = [
      { ...shared, meeting_id: 'week-one', scheduled_at: '2026-07-21T01:00:00.000Z' },
      { ...shared, meeting_id: 'week-two', scheduled_at: '2026-07-28T01:00:00.000Z' },
    ];
    expect(providerOccurrenceReference(registrations[1])).toBe(
      'spaces/weekly-room:2026-07-28T01:00:00.000Z',
    );
    expect(resolveProviderMeetingOccurrence(registrations, {
      tenant_id: 't',
      user_id: 'u',
      provider: 'google',
      logical_reference: 'spaces/weekly-room',
      started_at_ms: Date.parse('2026-07-28T01:03:00.000Z'),
    })?.meeting_id).toBe('week-two');
    expect(() => resolveProviderMeetingOccurrence(registrations, {
      tenant_id: 't',
      user_id: 'u',
      provider: 'google',
      logical_reference: 'spaces/weekly-room',
    })).toThrow('meeting_media_occurrence_ambiguous');
  });
});
