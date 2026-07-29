import { describe, expect, it } from 'vitest';
import { eventScopeMatches } from './event-stream';
import type { PostprocessEvent } from './contracts';

const event = { tenant_id: 't', user_id: 'u', meeting_id: 'm', occurrence_id: 'o' } as PostprocessEvent;
describe('postprocess event scope', () => {
  it('binds replay to tenant, user and meeting', () => {
    expect(eventScopeMatches(event, { tenant_id: 't', user_id: 'u', meeting_id: 'm', occurrence_id: 'o' })).toBe(true);
    expect(eventScopeMatches(event, { tenant_id: 't', user_id: 'other', meeting_id: 'm', occurrence_id: 'o' })).toBe(false);
    expect(eventScopeMatches(event, { tenant_id: 't', user_id: 'u', meeting_id: 'other', occurrence_id: 'o' })).toBe(false);
  });
});
