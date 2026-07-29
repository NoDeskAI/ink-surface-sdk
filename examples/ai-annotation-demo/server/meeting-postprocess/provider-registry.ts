import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { safeIdentityPart, sha256 } from './identity';

const providerRegistrationSchema = z.object({
  schema_version: z.literal('1.0'),
  tenant_id: z.string().min(1), user_id: z.string().min(1), meeting_id: z.string().min(1),
  provider: z.enum(['lark', 'google', 'zoom']),
  title: z.string().min(1).max(300),
  provider_meeting_id: z.string().max(512).optional(),
  provider_calendar_event_id: z.string().max(512).optional(),
  provider_space_name: z.string().max(512).optional(),
  meeting_code: z.string().max(128).optional(),
  scheduled_at: z.string().datetime(), scheduled_end_at: z.string().datetime().optional(), started_at: z.string().datetime().optional(), ended_at: z.string().datetime().optional(),
  status: z.enum(['upcoming', 'live', 'ended']), updated_at: z.string().datetime(),
});
export type ProviderMeetingRegistration = z.infer<typeof providerRegistrationSchema>;

interface ProviderMeetingDeletion { occurrence_key: string; meeting_id: string; deleted_at: string }
interface RegistryFile { schema_version: '1.0'; tenant_id: string; user_id: string; meetings: ProviderMeetingRegistration[]; deletions: ProviderMeetingDeletion[] }
const locks = new Map<string, Promise<unknown>>();

function namespacePart(value: string, fallback: string): string { return `${safeIdentityPart(value, fallback).slice(0, 80)}_${sha256(value).slice(0, 12)}`; }
function pathFor(root: string, identity: { tenant_id: string; user_id: string }): string { return resolve(root, namespacePart(identity.tenant_id, 'tenant'), namespacePart(identity.user_id, 'user'), 'meeting-provider-registry-v1.json'); }
function empty(identity: { tenant_id: string; user_id: string }): RegistryFile { return { schema_version: '1.0', ...identity, meetings: [], deletions: [] }; }
function occurrenceKeys(value: Pick<ProviderMeetingRegistration, 'provider' | 'provider_meeting_id' | 'provider_calendar_event_id' | 'provider_space_name' | 'meeting_code' | 'scheduled_at'>): string[] {
  const keys = new Set<string>();
  const provider = value.provider;
  if (value.provider_calendar_event_id) keys.add(`${provider}:calendar:${value.provider_calendar_event_id.toLowerCase()}`);
  if (value.provider_meeting_id) keys.add(`${provider}:instance:${value.provider_meeting_id.toLowerCase()}`);
  const logical = value.provider_space_name || value.meeting_code;
  if (logical && value.scheduled_at) keys.add(`${provider}:logical:${logical.toLowerCase()}:${value.scheduled_at.toLowerCase()}`);
  return [...keys].sort();
}
function read(path: string, identity?: { tenant_id: string; user_id: string }): RegistryFile {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RegistryFile>;
    if (!raw.tenant_id || !raw.user_id) throw new Error('provider_registry_identity_missing');
    return { schema_version: '1.0', tenant_id: raw.tenant_id, user_id: raw.user_id, meetings: (raw.meetings || []).map((item) => providerRegistrationSchema.parse(item)), deletions: Array.isArray(raw.deletions) ? raw.deletions.filter((item): item is ProviderMeetingDeletion => !!item?.occurrence_key && !!item?.meeting_id && !!item?.deleted_at) : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && identity) return empty(identity);
    throw error;
  }
}
function write(path: string, state: RegistryFile): void { mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.${Date.now()}.tmp`; writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); renameSync(temporary, path); }
function mutate<T>(path: string, identity: { tenant_id: string; user_id: string }, fn: (state: RegistryFile) => T): Promise<T> { const tail = locks.get(path) || Promise.resolve(); const next = tail.then(() => { const state = read(path, identity); const result = fn(state); write(path, state); return result; }); locks.set(path, next.catch(() => undefined)); return next; }

export async function registerProviderMeetings(root: string, identity: { tenant_id: string; user_id: string }, values: Array<Omit<ProviderMeetingRegistration, 'schema_version' | 'tenant_id' | 'user_id' | 'updated_at'>>): Promise<ProviderMeetingRegistration[]> {
  const path = pathFor(root, identity); const now = new Date().toISOString();
  return mutate(path, identity, (state) => values.map((value) => {
    const registration = providerRegistrationSchema.parse({ schema_version: '1.0', ...identity, ...value, updated_at: now });
    const deletedKeys = new Set(state.deletions.map((item) => item.occurrence_key));
    if (occurrenceKeys(registration).some((key) => deletedKeys.has(key))) {
      throw Object.assign(new Error('provider_meeting_occurrence_deleted'), { status: 410 });
    }
    const index = state.meetings.findIndex((item) => item.meeting_id === registration.meeting_id && item.provider === registration.provider);
    if (index >= 0) state.meetings[index] = registration; else state.meetings.push(registration);
    return registration;
  }));
}

export async function deleteProviderMeetingRegistration(root: string, identity: { tenant_id: string; user_id: string }, meetingId: string): Promise<number> { const path = pathFor(root, identity); return mutate(path, identity, (state) => { const removed = state.meetings.filter((item) => item.meeting_id === meetingId); const before = state.meetings.length; state.meetings = state.meetings.filter((item) => item.meeting_id !== meetingId); const deletedAt = new Date().toISOString(); const existing = new Set(state.deletions.map((item) => item.occurrence_key)); for (const item of removed) for (const occurrence_key of occurrenceKeys(item)) if (!existing.has(occurrence_key)) { state.deletions.push({ occurrence_key, meeting_id: meetingId, deleted_at: deletedAt }); existing.add(occurrence_key); } return before - state.meetings.length; }); }

export function listProviderMeetingRegistrations(root: string, provider?: ProviderMeetingRegistration['provider']): ProviderMeetingRegistration[] {
  const result: ProviderMeetingRegistration[] = [];
  try {
    for (const tenant of readdirSync(resolve(root), { withFileTypes: true }).filter((item) => item.isDirectory())) for (const user of readdirSync(resolve(root, tenant.name), { withFileTypes: true }).filter((item) => item.isDirectory())) {
      try { result.push(...read(resolve(root, tenant.name, user.name, 'meeting-provider-registry-v1.json')).meetings.filter((item) => !provider || item.provider === provider)); } catch { /* one corrupt namespace cannot expose or block others */ }
    }
  } catch { /* no registry yet */ }
  return result;
}

export function registrationMatches(registration: ProviderMeetingRegistration, input: { provider_meeting_id?: string; provider_calendar_event_id?: string; provider_space_name?: string; meeting_code?: string; scheduled_at?: string }): boolean {
  if (registration.provider_meeting_id && input.provider_meeting_id && registration.provider_meeting_id === input.provider_meeting_id) return true;
  if (registration.provider_calendar_event_id && input.provider_calendar_event_id && registration.provider_calendar_event_id === input.provider_calendar_event_id) return true;
  const sameSchedule = !!registration.scheduled_at && !!input.scheduled_at && registration.scheduled_at === input.scheduled_at;
  return sameSchedule && ((!!registration.meeting_code && registration.meeting_code === input.meeting_code) || (!!registration.provider_space_name && registration.provider_space_name === input.provider_space_name));
}

export function providerOccurrenceReference(registration: ProviderMeetingRegistration): string {
  if (registration.provider_calendar_event_id) return registration.provider_calendar_event_id;
  if (registration.provider_meeting_id) return registration.provider_meeting_id;
  const logical = registration.provider_space_name || registration.meeting_code;
  return logical && registration.scheduled_at
    ? `${logical}:${registration.scheduled_at}`
    : registration.meeting_id;
}

export function resolveProviderMeetingOccurrence(
  registrations: ProviderMeetingRegistration[],
  input: {
    tenant_id: string;
    user_id: string;
    provider: ProviderMeetingRegistration['provider'];
    logical_reference: string;
    started_at_ms?: number;
    tolerance_ms?: number;
  },
): ProviderMeetingRegistration | null {
  const candidates = registrations.filter((item) => {
    if (item.tenant_id !== input.tenant_id
      || item.user_id !== input.user_id
      || item.provider !== input.provider) return false;
    return item.provider_meeting_id === input.logical_reference
      || item.provider_space_name === input.logical_reference
      || item.meeting_code === input.logical_reference;
  });
  if (candidates.length === 0) return null;

  const startedAtMs = Number(input.started_at_ms);
  if (!Number.isFinite(startedAtMs)) {
    if (candidates.length === 1) return candidates[0];
    throw Object.assign(new Error('meeting_media_occurrence_ambiguous'), { status: 409 });
  }
  const toleranceMs = Math.max(1, input.tolerance_ms ?? 6 * 60 * 60 * 1_000);
  const ranked = candidates
    .map((item) => {
      const occurrenceTime = Date.parse(item.started_at || item.scheduled_at);
      return {
        item,
        distance: Number.isFinite(occurrenceTime)
          ? Math.abs(occurrenceTime - startedAtMs)
          : Number.POSITIVE_INFINITY,
      };
    })
    .sort((left, right) => left.distance - right.distance
      || left.item.meeting_id.localeCompare(right.item.meeting_id));
  if (ranked[0].distance > toleranceMs) return null;
  if (ranked[1]?.distance === ranked[0].distance) {
    throw Object.assign(new Error('meeting_media_occurrence_ambiguous'), { status: 409 });
  }
  return ranked[0].item;
}
