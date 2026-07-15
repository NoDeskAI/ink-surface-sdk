import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintMtlToken, type MtlReceiverIdentity } from './mtl-receiver-auth';
import {
  handleMtlReceiver,
  listMtlMeetingWindows,
  mtlEventsAuditPath,
  type MtlLiveMeetingWindow,
  type MtlReceiverEnv,
} from './mtl-receiver';

describe('MTL receiver', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-mtl-receiver-'));
    roots.push(root);
    const env: MtlReceiverEnv = {
      MTL_TOKEN_STORE: join(root, 'mtl-tokens.json'),
      MTL_EVENTS_ROOT: join(root, 'events'),
    };
    const identity: MtlReceiverIdentity = { tenant_id: 'tenant-a', user_id: 'teacher-a' };
    const { token } = mintMtlToken(identity, env);
    const ended = vi.fn(async (_resolved: MtlReceiverIdentity, _window: MtlLiveMeetingWindow) => {});
    const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
      const rawBody = init.body === undefined ? '' : JSON.stringify(init.body);
      const req = Readable.from(rawBody ? [Buffer.from(rawBody)] : []) as unknown as IncomingMessage;
      req.url = `/api/mtl/${path}`;
      req.method = init.method || 'GET';
      req.headers = rawBody ? { 'content-type': 'application/json' } : {};
      let responseBody = '';
      const res = {
        statusCode: 200,
        setHeader: vi.fn(),
        end(chunk?: string | Buffer) {
          responseBody = chunk ? chunk.toString() : '';
        },
      } as unknown as ServerResponse;
      const handled = await handleMtlReceiver(req, res, {
        env,
        now: () => Date.parse('2026-07-15T04:00:00.000Z'),
        onMeetingEnded: ended,
      });
      return {
        handled,
        status: res.statusCode,
        json: () => JSON.parse(responseBody) as Record<string, unknown>,
      };
    };
    return { env, identity, token, ended, call };
  }

  it('isolates secret routes, validates active meeting identity, and stores only audit-safe evidence', async () => {
    const { env, identity, token, ended, call } = await fixture();
    const invalid = await call(`${'0'.repeat(32)}/api/state`);
    expect(invalid.status).toBe(404);

    const stateProbe = await call(`${token}/api/state`);
    expect(stateProbe.json()).toEqual({ ok: true, service: 'inkloop-mtl-receiver' });

    const startPayload = {
      platform: 'google_meet',
      meeting_id: 'abc-defg-hij',
      meeting_url: 'https://meet.google.com/abc-defg-hij?authuser=private',
      title: 'Weekly sync',
      start_time_ms: Date.parse('2026-07-15T03:00:00.000Z'),
      detector_source: 'meeting_app_extension',
      observer_surface: 'browser_extension',
      meeting_app_record: {
        snapshot: {
          url: 'https://meet.google.com/abc-defg-hij?authuser=private',
          title: 'Weekly sync - Google Meet',
          dom: { private_text: 'DO_NOT_STORE_FULL_DOM' },
        },
      },
    };
    const started = await call(`${token}/api/meeting-session/start`, {
      method: 'POST',
      body: startPayload,
    });
    expect(started.json()).toMatchObject({
      ok: true,
      meeting: { platform: 'google_meet', meeting_id: 'abc-defg-hij', meeting_code: 'abc-defg-hij' },
    });

    const duplicate = await call(`${token}/api/meeting-session/start`, {
      method: 'POST',
      body: { ...startPayload, start_time_ms: startPayload.start_time_ms + 1_000 },
    });
    expect(duplicate.json()).toMatchObject({ ok: true, deduplicated: true });

    const conflict = await call(`${token}/api/meeting-session/start`, {
      method: 'POST',
      body: { ...startPayload, meeting_id: 'zzz-yyyy-xxx' },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: 'mtl_active_meeting_conflict', current_meeting: { meeting_id: 'abc-defg-hij' } },
    });

    const mismatch = await call(`${token}/api/meeting-session/end`, {
      method: 'POST',
      body: { meeting_id: 'zzz-yyyy-xxx', end_time_ms: Date.parse('2026-07-15T03:50:00.000Z') },
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.json()).toMatchObject({ error: { code: 'mtl_active_meeting_mismatch' } });

    const annotation = await call(`${token}/api/annotations`, {
      method: 'POST',
      body: {
        id: 'speaker-1',
        captured_at_ms: Date.parse('2026-07-15T03:20:00.000Z'),
        kind: 'speaker_started',
        intent: 'speaker_track',
        label: 'PRIVATE_SPEAKER_LABEL',
        payload: { meeting: { platform: 'google_meet', meeting_id: 'abc-defg-hij' } },
      },
    });
    expect(annotation.json()).toEqual({
      ack: { accepted: true, annotation_id: 'speaker-1', operation: 'recorded' },
    });

    const batch = await call(`${token}/api/annotations/batch`, {
      method: 'POST',
      body: { annotations: [{ id: 'batch-1' }, { id: 'batch-2' }] },
    });
    expect(batch.json()).toMatchObject({
      accepted: true,
      count: 2,
      acks: [
        { accepted: true, annotation_id: 'batch-1', operation: 'recorded' },
        { accepted: true, annotation_id: 'batch-2', operation: 'recorded' },
      ],
    });

    const oversizedBatch = await call(`${token}/api/annotations/batch`, {
      method: 'POST',
      body: { annotations: Array.from({ length: 201 }, (_, index) => ({ id: `batch-${index}` })) },
    });
    expect(oversizedBatch.status).toBe(413);

    const endedResponse = await call(`${token}/api/meeting-session/end`, {
      method: 'POST',
      body: {
        meeting_id: 'abc-defg-hij',
        end_time_ms: Date.parse('2026-07-15T03:55:00.000Z'),
        detector_source: 'meeting_app_extension_leave',
        meeting_app_record: startPayload.meeting_app_record,
      },
    });
    expect(endedResponse.json()).toMatchObject({
      ok: true,
      meeting: { meeting_id: 'abc-defg-hij', ended_at_ms: Date.parse('2026-07-15T03:55:00.000Z') },
    });
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));

    expect(listMtlMeetingWindows(identity, env)).toEqual([
      expect.objectContaining({
        platform: 'google_meet',
        meeting_id: 'abc-defg-hij',
        meeting_code: 'abc-defg-hij',
        meeting_url: 'https://meet.google.com/abc-defg-hij',
        ended_at_ms: Date.parse('2026-07-15T03:55:00.000Z'),
      }),
    ]);
    const audit = readFileSync(mtlEventsAuditPath(identity, env), 'utf8');
    expect(audit).toContain('https://meet.google.com/abc-defg-hij');
    expect(audit).toContain('Weekly sync - Google Meet');
    expect(audit).not.toContain(token);
    expect(audit).not.toContain('DO_NOT_STORE_FULL_DOM');
    expect(audit).not.toContain('PRIVATE_SPEAKER_LABEL');
    expect(audit).not.toContain('snapshot');
  });

  it('rejects an end event whose normalized platform does not match the active meeting', async () => {
    const { env, identity, token, ended, call } = await fixture();
    const meetingId = 'shared-meeting-id';
    await call(`${token}/api/meeting-session/start`, {
      method: 'POST',
      body: {
        platform: 'google-meet',
        meeting_id: meetingId,
        start_time_ms: Date.parse('2026-07-15T03:00:00.000Z'),
      },
    });

    const response = await call(`${token}/api/meeting-session/end`, {
      method: 'POST',
      body: {
        platform: 'lark',
        meeting_id: meetingId,
        end_time_ms: Date.parse('2026-07-15T03:55:00.000Z'),
      },
    });

    expect(response.status).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: 'mtl_active_meeting_mismatch',
        current_meeting: { platform: 'google_meet', meeting_id: meetingId },
      },
    });
    expect(ended).not.toHaveBeenCalled();
    expect(listMtlMeetingWindows(identity, env)).toEqual([
      expect.not.objectContaining({ ended_at_ms: expect.any(Number) }),
    ]);
    expect(readFileSync(mtlEventsAuditPath(identity, env), 'utf8')).toContain('meeting_session_end_mismatch');
  });

  it('ends the active meeting when the supplied platform normalizes to the active platform', async () => {
    const { token, ended, call } = await fixture();
    const meetingId = 'shared-meeting-id';
    await call(`${token}/api/meeting-session/start`, {
      method: 'POST',
      body: {
        platform: 'google-meet',
        meeting_id: meetingId,
        start_time_ms: Date.parse('2026-07-15T03:00:00.000Z'),
      },
    });

    const response = await call(`${token}/api/meeting-session/end`, {
      method: 'POST',
      body: {
        platform: 'Google-Meet',
        meeting_id: meetingId,
        end_time_ms: Date.parse('2026-07-15T03:55:00.000Z'),
      },
    });

    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      meeting: { platform: 'google_meet', meeting_id: meetingId, ended_at_ms: Date.parse('2026-07-15T03:55:00.000Z') },
    });
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
  });

  it('keeps accepting legacy end events without a platform', async () => {
    const { token, ended, call } = await fixture();
    const meetingId = 'shared-meeting-id';
    await call(`${token}/api/meeting-session/start`, {
      method: 'POST',
      body: {
        platform: 'google_meet',
        meeting_id: meetingId,
        start_time_ms: Date.parse('2026-07-15T03:00:00.000Z'),
      },
    });

    const response = await call(`${token}/api/meeting-session/end`, {
      method: 'POST',
      body: {
        meeting_id: meetingId,
        end_time_ms: Date.parse('2026-07-15T03:55:00.000Z'),
      },
    });

    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      meeting: { platform: 'google_meet', meeting_id: meetingId, ended_at_ms: Date.parse('2026-07-15T03:55:00.000Z') },
    });
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
  });
});
