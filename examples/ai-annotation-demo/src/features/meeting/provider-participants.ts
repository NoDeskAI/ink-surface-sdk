import type { PersistedMeetingProviderParticipant } from '../../core/store-format';

export interface AggregatedProviderParticipant {
  name: string;
  identity: PersistedMeetingProviderParticipant['identity'];
  intervals: Array<{ joined_at: string; left_at: string }>;
  total_duration_ms: number;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/** 同名且同身份的人聚合为一行；Zoom 重进产生的多个区间保留并累计。 */
export function aggregateProviderParticipants(
  participants: PersistedMeetingProviderParticipant[] | undefined,
): AggregatedProviderParticipant[] {
  const groups = new Map<string, AggregatedProviderParticipant>();
  for (const participant of participants ?? []) {
    const name = participant.name.trim();
    if (!name) continue;
    const key = `${participant.identity}\u0000${name}`;
    const group = groups.get(key) ?? { name, identity: participant.identity, intervals: [], total_duration_ms: 0 };
    group.intervals.push({ joined_at: participant.joined_at, left_at: participant.left_at });
    const joinedAt = Date.parse(participant.joined_at);
    const leftAt = Date.parse(participant.left_at);
    if (Number.isFinite(joinedAt) && Number.isFinite(leftAt) && leftAt >= joinedAt) {
      group.total_duration_ms += leftAt - joinedAt;
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, intervals: group.intervals.sort((left, right) => timestamp(left.joined_at) - timestamp(right.joined_at)) }))
    .sort((left, right) => timestamp(left.intervals[0]?.joined_at || '') - timestamp(right.intervals[0]?.joined_at || '') || left.name.localeCompare(right.name, 'zh-CN'));
}

function clock(value: string, includeDate: boolean): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  const date = new Date(parsed);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return includeDate ? `${date.getMonth() + 1}/${date.getDate()} ${hh}:${mm}` : `${hh}:${mm}`;
}

function intervalLabel(interval: { joined_at: string; left_at: string }): string {
  const joined = new Date(interval.joined_at);
  const left = new Date(interval.left_at);
  const sameDay = Number.isFinite(joined.getTime()) && Number.isFinite(left.getTime())
    && joined.getFullYear() === left.getFullYear()
    && joined.getMonth() === left.getMonth()
    && joined.getDate() === left.getDate();
  return `${clock(interval.joined_at, !sameDay)}–${clock(interval.left_at, !sameDay)}`;
}

function durationLabel(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '时长未知';
  const minutes = Math.max(1, Math.round(durationMs / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

export function providerParticipantLine(participant: AggregatedProviderParticipant): string {
  const guest = participant.identity === 'signed_in' ? '' : '（访客）';
  const intervals = participant.intervals.map(intervalLabel).join('、');
  const segment = participant.intervals.length > 1 ? `${participant.intervals.length} 段：${intervals}` : intervals;
  return `${participant.name}${guest} · 共 ${durationLabel(participant.total_duration_ms)}${segment ? ` · ${segment}` : ''}`;
}

export function providerParticipantLines(
  participants: PersistedMeetingProviderParticipant[] | undefined,
): string[] {
  return aggregateProviderParticipants(participants).map(providerParticipantLine);
}
