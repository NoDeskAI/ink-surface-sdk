import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import contract from './fixtures/mtl-protocol-contract.json';
import { mintMtlToken } from './mtl-receiver-auth';
import { handleMtlReceiver, type MtlReceiverEnv } from './mtl-receiver';

// Payload outputs are pinned from meeting-timeline-sdk commit
// fd13d52a67a915f4afb9a2a7383beedba623114a. Do not import a developer-local SDK here.
describe('MTL SDK protocol contract', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function createHarness() {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-mtl-protocol-'));
    roots.push(root);
    const env: MtlReceiverEnv = {
      MTL_TOKEN_STORE: join(root, 'mtl-tokens.json'),
      MTL_EVENTS_ROOT: join(root, 'events'),
    };
    const { token } = mintMtlToken({ tenant_id: 'tenant-contract', user_id: 'user-contract' }, env);
    const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
      const rawBody = init.body === undefined ? '' : JSON.stringify(init.body);
      const req = Readable.from(rawBody ? [Buffer.from(rawBody)] : []) as unknown as IncomingMessage;
      req.url = `/api/mtl/${token}/api/${path}`;
      req.method = init.method || 'GET';
      req.headers = rawBody ? { 'content-type': 'application/json' } : {};
      let responseBody = '';
      const res = {
        statusCode: 200,
        setHeader() {},
        end(chunk?: string | Buffer) {
          responseBody = chunk ? chunk.toString() : '';
        },
      } as unknown as ServerResponse;
      const handled = await handleMtlReceiver(req, res, {
        env,
        now: () => Date.parse('2026-07-15T04:00:00.000Z'),
        onMeetingEnded: () => {},
      });
      return {
        handled,
        status: res.statusCode,
        body: JSON.parse(responseBody) as Record<string, unknown>,
      };
    };
    return { call };
  }

  it('accepts pinned SDK payloads and preserves acceptance response checkpoints', async () => {
    const { call } = await createHarness();
    const { start, end, annotation } = contract.payload_cases;

    const state = await call('state');
    expect(state).toMatchObject({
      handled: true,
      status: 200,
      body: { ok: true, service: 'inkloop-mtl-receiver' },
    });

    const started = await call('meeting-session/start', { method: 'POST', body: start.expected });
    expect(started).toMatchObject({
      handled: true,
      status: 200,
      body: {
        ok: true,
        meeting: {
          platform: 'google_meet',
          meeting_id: start.expected.meeting_id,
          started_at_ms: start.expected.start_time_ms,
        },
      },
    });

    const duplicate = await call('meeting-session/start', { method: 'POST', body: start.expected });
    expect(duplicate).toMatchObject({
      status: 200,
      body: {
        ok: true,
        deduplicated: true,
        meeting: { meeting_id: start.expected.meeting_id },
      },
    });

    const conflict = await call('meeting-session/start', {
      method: 'POST',
      body: { ...start.expected, meeting_id: 'different-meeting' },
    });
    expect(conflict).toMatchObject({
      status: 409,
      body: {
        ok: false,
        error: {
          code: 'mtl_active_meeting_conflict',
          current_meeting: { platform: 'google_meet', meeting_id: start.expected.meeting_id },
        },
      },
    });

    const mismatchedEnd = await call('meeting-session/end', {
      method: 'POST',
      body: { ...end.expected, meeting_id: 'different-meeting' },
    });
    expect(mismatchedEnd).toMatchObject({
      status: 409,
      body: {
        ok: false,
        error: {
          code: 'mtl_active_meeting_mismatch',
          current_meeting: { platform: 'google_meet', meeting_id: start.expected.meeting_id },
        },
      },
    });

    const inserted = await call('annotations', { method: 'POST', body: annotation.expected });
    expect(inserted).toEqual({
      handled: true,
      status: 200,
      body: {
        ack: {
          accepted: true,
          annotation_id: annotation.expected.id,
          operation: 'recorded',
        },
      },
    });

    const batch = await call('annotations/batch', {
      method: 'POST',
      body: {
        annotations: [annotation.expected, { ...annotation.expected, id: 'contract-batch-2' }],
      },
    });
    expect(batch).toMatchObject({
      status: 200,
      body: {
        accepted: true,
        count: 2,
        acks: [
          { accepted: true, annotation_id: annotation.expected.id, operation: 'recorded' },
          { accepted: true, annotation_id: 'contract-batch-2', operation: 'recorded' },
        ],
      },
    });

    for (const path of ['meeting-platform/p0-reference', 'meeting-platform/runtime-events']) {
      const response = await call(path, { method: 'POST', body: { source: 'protocol-contract' } });
      expect(response).toMatchObject({ handled: true, status: 200, body: { ok: true } });
    }

    const ended = await call('meeting-session/end', { method: 'POST', body: end.expected });
    expect(ended).toMatchObject({
      handled: true,
      status: 200,
      body: {
        ok: true,
        meeting: {
          platform: 'google_meet',
          meeting_id: end.expected.meeting_id,
          ended_at_ms: end.expected.end_time_ms,
        },
      },
    });
  });
});
