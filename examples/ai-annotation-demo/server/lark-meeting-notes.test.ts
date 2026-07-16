import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  feishuDocxSegmentsToSrt,
  fetchLarkDocxMedia,
  fetchLarkMeetingNoteTranscript,
  parseFeishuDocxTranscriptContent,
} from './lark-meeting-notes';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const RAW_TRANSCRIPT = [
  '文字记录：出海创新周会 2026年7月7日',
  '会议主题：出海创新周会',
  '@姚梦娜 00:00:49',
  '那我先吧，我们之前不是讨论了白板笔的场景嘛。',
  '@王辰炜 00:01:35',
  '我补充一下，这里要把墨水屏端标记和会议轴对齐。',
  '@姚梦娜 00:02:20',
  '后面可以继续看问卷数据。',
].join('\n');

describe('lark meeting note transcript', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('parses Feishu docx speaker/time records into SRT cues', () => {
    const segments = parseFeishuDocxTranscriptContent(RAW_TRANSCRIPT);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({
      speaker: '姚梦娜',
      start_ms: 49_000,
      end_ms: 95_000,
      text: '那我先吧，我们之前不是讨论了白板笔的场景嘛。',
    });
    expect(segments[1]).toMatchObject({
      speaker: '王辰炜',
      start_ms: 95_000,
      end_ms: 140_000,
    });
    const srt = feishuDocxSegmentsToSrt(segments);
    expect(srt).toContain('00:00:49,000 --> 00:01:35,000');
    expect(srt).toContain('姚梦娜：那我先吧');
    expect(srt).toContain('王辰炜：我补充一下');
  });

  it('turns Feishu device diarization markers into segment metadata instead of spoken text', () => {
    const raw = [
      '@王辰炜 00:01:32',
      '还是跟之前一样，哲帆先同步一下进度吧。',
      '说话人 8 用 @王辰炜 的设备 00:01:35',
      '好，那个。',
      '@金哲帆 00:01:44',
      'OK，好的。',
      '@张宇 用 @徐智强 的设备 00:01:50',
      '我补充一个风险。',
    ].join('\n');

    const segments = parseFeishuDocxTranscriptContent(raw);

    expect(segments).toHaveLength(4);
    expect(segments[0]).toMatchObject({
      speaker: '王辰炜',
      speaker_source: 'identified',
      start_ms: 92_000,
      end_ms: 95_000,
    });
    expect(segments[1]).toMatchObject({
      speaker: '说话人 8',
      speaker_source: 'device_diarization',
      speaker_device_owner: '王辰炜',
      start_ms: 95_000,
      end_ms: 104_000,
      text: '好，那个。',
    });
    expect(segments[3]).toMatchObject({
      speaker: '张宇',
      speaker_source: 'identified',
      speaker_device_owner: '徐智强',
      text: '我补充一个风险。',
    });

    const srt = feishuDocxSegmentsToSrt(segments);
    expect(srt).toContain('说话人 8：好，那个。');
    expect(srt).toContain('张宇：我补充一个风险。');
    expect(srt).not.toContain('用 @');
    expect(srt).not.toContain('的设备');
  });

  it('fetches meeting note artifacts and chooses the full transcript docx', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'inkloop-lark-note-'));
    const authPath = join(tempDir, 'auth-state.json');
    writeFileSync(authPath, JSON.stringify({
      token: {
        access_token: 'user_token',
        expires_in: 24 * 60 * 60,
        obtained_at_ms: Date.parse('2026-07-07T00:00:00+08:00'),
        scope: 'vc:note:read docx:document:readonly vc:meeting.meetingid:read docs:document.media:download',
      },
    }));

    try {
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        const auth = String((init?.headers as Record<string, string> | undefined)?.authorization || '');
        if (url.endsWith('/open-apis/vc/v1/notes/note_1') && auth.includes('user_token')) {
          return jsonResponse({
            code: 0,
            data: {
              note: {
                artifacts: [
                  { artifact_type: 1, document_id: 'summary_doc', title: '智能纪要：出海创新周会' },
                  { artifact_type: 2, document_id: 'transcript_doc', title: '文字记录：出海创新周会' },
                ],
              },
            },
          });
        }
        if (url.endsWith('/open-apis/docx/v1/documents/summary_doc/raw_content')) {
          return jsonResponse({ code: 0, data: { content: '智能纪要\n总结\nmeetgraph/meeting_1/a.png\n方案图\n@姚梦娜 00:00:49\n一句摘要' } });
        }
        if (url.endsWith('/open-apis/docx/v1/documents/summary_doc/blocks?page_size=500')) {
          return jsonResponse({ code: 0, data: { items: [{ block_type: 27, image: { token: 'img_token_1' } }], has_more: false } });
        }
        if (url.endsWith('/open-apis/docx/v1/documents/transcript_doc/blocks?page_size=500')) {
          return jsonResponse({ code: 0, data: { items: [], has_more: false } });
        }
        if (url.endsWith('/open-apis/docx/v1/documents/transcript_doc/raw_content')) {
          return jsonResponse({ code: 0, data: { content: RAW_TRANSCRIPT } });
        }
        return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
      });
      vi.stubGlobal('fetch', fetchImpl);

      const fetchMeetingDetailWithToken = vi.fn(async () => ({
        code: 0,
        data: {
          meeting: {
            id: 'meeting_1',
            topic: '出海创新周会',
            meeting_no: '473388422',
            start_time: '1783407703',
            end_time: '1783413976',
            note_id: 'note_1',
          },
        },
      }));

      const result = await fetchLarkMeetingNoteTranscript('meeting_1', {
        nowMs: Date.parse('2026-07-07T16:50:00+08:00'),
        env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret', LARK_MEETING_AUTH_STATE_PATH: authPath },
        createClient: () => ({ fetchMeetingDetailWithToken }),
      });

      expect(fetchMeetingDetailWithToken).toHaveBeenCalledWith('meeting_1', 'user_token');
      expect(result.status).toBe('ready');
      expect(result.meeting).toMatchObject({ id: 'meeting_1', note_id: 'note_1', topic: '出海创新周会' });
      expect(result.transcript).toMatchObject({
        source: 'feishu_note_docx',
        minute_token: 'feishu_note_docx:meeting_1:transcript_doc',
        document_id: 'transcript_doc',
        cue_count: 3,
        speaker_count: 2,
        parser_version: 2,
        raw_content: RAW_TRANSCRIPT,
      });
      expect(result.transcript?.segments[0]).toMatchObject({
        speaker: '姚梦娜',
        speaker_source: 'identified',
        text: '那我先吧，我们之前不是讨论了白板笔的场景嘛。',
      });
      expect(result.transcript?.srt).toContain('王辰炜：我补充一下');
      expect(result.summary).toMatchObject({
        source: 'feishu_note_docx',
        document_id: 'summary_doc',
        title: '智能纪要：出海创新周会',
      });
      expect(result.summary?.content).toContain('智能纪要');
      expect(result.summary?.images).toEqual([{ index: 0, file_token: 'img_token_1' }]);
      expect(result.artifacts.find((artifact) => artifact.document_id === 'transcript_doc')).toMatchObject({
        artifact_type: 2,
        segment_count: 3,
        speaker_count: 2,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports a docx raw_content Feishu error as failed instead of missing_transcript', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'inkloop-lark-note-'));
    const authPath = join(tempDir, 'auth-state.json');
    writeFileSync(authPath, JSON.stringify({
      token: {
        access_token: 'user_token',
        expires_in: 24 * 60 * 60,
        obtained_at_ms: Date.parse('2026-07-07T00:00:00+08:00'),
        scope: 'vc:note:read docx:document:readonly vc:meeting.meetingid:read',
      },
    }));

    try {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.endsWith('/open-apis/vc/v1/notes/note_1')) {
          return jsonResponse({
            code: 0,
            data: { note: { artifacts: [{ artifact_type: 2, document_id: 'transcript_doc', title: '文字记录' }] } },
          });
        }
        if (url.endsWith('/open-apis/docx/v1/documents/transcript_doc/raw_content')) {
          return jsonResponse({ code: 99991672, msg: 'Forbidden: missing document permission' }, 403);
        }
        return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
      }));

      const result = await fetchLarkMeetingNoteTranscript('meeting_1', {
        nowMs: Date.parse('2026-07-07T16:50:00+08:00'),
        env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret', LARK_MEETING_AUTH_STATE_PATH: authPath },
        createClient: () => ({
          fetchMeetingDetailWithToken: vi.fn(async () => ({
            code: 0,
            data: { meeting: { id: 'meeting_1', topic: '权限测试', note_id: 'note_1' } },
          })),
        }),
      });

      expect(result.status).toBe('failed');
      expect(result.transcript).toBeUndefined();
      expect(result.errors).toEqual([expect.objectContaining({
        source: 'docx',
        code: '99991672',
        required_scope: 'docx:document:readonly',
      })]);
      expect(result.errors[0].permission_url).toContain('token_type=user');
      expect(result.artifacts[0]).toMatchObject({
        document_id: 'transcript_doc',
        content_length: 0,
        segment_count: 0,
        speaker_count: 0,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps missing_transcript for a readable docx with no parseable speaker segments', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'inkloop-lark-note-'));
    const authPath = join(tempDir, 'auth-state.json');
    writeFileSync(authPath, JSON.stringify({
      token: {
        access_token: 'user_token',
        expires_in: 24 * 60 * 60,
        obtained_at_ms: Date.parse('2026-07-07T00:00:00+08:00'),
        scope: 'vc:note:read docx:document:readonly vc:meeting.meetingid:read',
      },
    }));

    try {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.endsWith('/open-apis/vc/v1/notes/note_1')) {
          return jsonResponse({
            code: 0,
            data: { note: { artifacts: [{ artifact_type: 2, document_id: 'transcript_doc', title: '文字记录' }] } },
          });
        }
        if (url.endsWith('/open-apis/docx/v1/documents/transcript_doc/raw_content')) {
          return jsonResponse({ code: 0, data: { content: '文字记录仍在生成，请稍后再试。' } });
        }
        return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
      }));

      const result = await fetchLarkMeetingNoteTranscript('meeting_1', {
        nowMs: Date.parse('2026-07-07T16:50:00+08:00'),
        env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret', LARK_MEETING_AUTH_STATE_PATH: authPath },
        createClient: () => ({
          fetchMeetingDetailWithToken: vi.fn(async () => ({
            code: 0,
            data: { meeting: { id: 'meeting_1', topic: '生成中测试', note_id: 'note_1' } },
          })),
        }),
      });

      expect(result.status).toBe('missing_transcript');
      expect(result.errors).toEqual([expect.objectContaining({
        source: 'docx',
        code: 'transcript_artifact_missing',
      })]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refreshes expired OAuth before reading meeting note artifacts', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'inkloop-lark-note-'));
    const authPath = join(tempDir, 'auth-state.json');
    const nowMs = Date.parse('2026-07-07T16:00:00+08:00');
    writeFileSync(authPath, JSON.stringify({
      token: {
        access_token: 'expired_user_token',
        refresh_token: 'refresh_user_token',
        expires_in: 60,
        refresh_expires_in: 24 * 60 * 60,
        obtained_at_ms: Date.parse('2026-07-07T15:00:00+08:00'),
        scope: 'vc:note:read docx:document:readonly vc:meeting.meetingid:read',
      },
    }));

    try {
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        const auth = String((init?.headers as Record<string, string> | undefined)?.authorization || '');
        if (url.endsWith('/open-apis/vc/v1/notes/note_1') && auth.includes('fresh_user_token')) {
          return jsonResponse({
            code: 0,
            data: { note: { artifacts: [{ artifact_type: 2, document_id: 'transcript_doc', title: '文字记录：出海创新周会' }] } },
          });
        }
        if (url.endsWith('/open-apis/docx/v1/documents/transcript_doc/raw_content') && auth.includes('fresh_user_token')) {
          return jsonResponse({ code: 0, data: { content: RAW_TRANSCRIPT } });
        }
        return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
      });
      vi.stubGlobal('fetch', fetchImpl);

      const refreshOAuthToken = vi.fn(async () => ({
        access_token: 'fresh_user_token',
        refresh_token: 'fresh_refresh_token',
        expires_in: 7200,
        refresh_expires_in: 30 * 24 * 60 * 60,
        scope: 'vc:note:read docx:document:readonly vc:meeting.meetingid:read',
      }));
      const fetchMeetingDetailWithToken = vi.fn(async () => ({
        code: 0,
        data: { meeting: { id: 'meeting_1', topic: '出海创新周会', note_id: 'note_1' } },
      }));

      const result = await fetchLarkMeetingNoteTranscript('meeting_1', {
        nowMs,
        env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret', LARK_MEETING_AUTH_STATE_PATH: authPath },
        createClient: () => ({ refreshOAuthToken, fetchMeetingDetailWithToken }),
      });

      expect(refreshOAuthToken).toHaveBeenCalledWith('refresh_user_token');
      expect(fetchMeetingDetailWithToken).toHaveBeenCalledWith('meeting_1', 'fresh_user_token');
      expect(result.status).toBe('ready');
      expect(JSON.parse(readFileSync(authPath, 'utf8')).token).toMatchObject({
        access_token: 'fresh_user_token',
        refresh_token: 'fresh_refresh_token',
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns a permission URL when OAuth lacks note/docx scopes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'inkloop-lark-note-'));
    const authPath = join(tempDir, 'auth-state.json');
    writeFileSync(authPath, JSON.stringify({
      token: {
        access_token: 'user_token',
        expires_in: 24 * 60 * 60,
        obtained_at_ms: Date.parse('2026-07-07T00:00:00+08:00'),
        scope: 'vc:meeting.meetingid:read',
      },
    }));

    try {
      const result = await fetchLarkMeetingNoteTranscript('meeting_1', {
        nowMs: Date.parse('2026-07-07T16:50:00+08:00'),
        env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret', LARK_MEETING_AUTH_STATE_PATH: authPath },
        createClient: () => ({ fetchMeetingDetailWithToken: vi.fn() }),
      });
      expect(result.status).toBe('missing_scope');
      expect(result.errors[0]).toMatchObject({
        source: 'lark_oauth',
        code: 'missing_oauth_scope',
        required_scope: 'vc:note:read,docx:document:readonly',
      });
      expect(result.errors[0].permission_url).toContain('cli_test');
      expect(result.errors[0].permission_url).toContain('token_type=user');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('downloads docx media when OAuth has media scope', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'inkloop-lark-note-'));
    const authPath = join(tempDir, 'auth-state.json');
    writeFileSync(authPath, JSON.stringify({
      token: {
        access_token: 'user_token',
        expires_in: 24 * 60 * 60,
        obtained_at_ms: Date.parse('2026-07-07T00:00:00+08:00'),
        scope: 'docx:document:readonly docs:document.media:download',
      },
    }));

    try {
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const auth = String((init?.headers as Record<string, string> | undefined)?.authorization || '');
        if (url.endsWith('/open-apis/drive/v1/medias/img_token_1/download') && auth.includes('user_token')) {
          return new Response(Buffer.from('png-bytes'), { status: 200, headers: { 'content-type': 'image/png' } });
        }
        return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
      }));

      const result = await fetchLarkDocxMedia('summary_doc', 'img_token_1', {
        nowMs: Date.parse('2026-07-07T16:50:00+08:00'),
        env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret', LARK_MEETING_AUTH_STATE_PATH: authPath },
        createClient: () => ({}),
      });

      expect(result.ok).toBe(true);
      expect(result.content_type).toBe('image/png');
      expect(result.body?.toString()).toBe('png-bytes');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns a permission URL when docx media scope is missing', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'inkloop-lark-note-'));
    const authPath = join(tempDir, 'auth-state.json');
    writeFileSync(authPath, JSON.stringify({
      token: {
        access_token: 'user_token',
        expires_in: 24 * 60 * 60,
        obtained_at_ms: Date.parse('2026-07-07T00:00:00+08:00'),
        scope: 'docx:document:readonly',
      },
    }));

    try {
      const result = await fetchLarkDocxMedia('summary_doc', 'img_token_1', {
        nowMs: Date.parse('2026-07-07T16:50:00+08:00'),
        env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret', LARK_MEETING_AUTH_STATE_PATH: authPath },
        createClient: () => ({}),
      });

      expect(result.ok).toBe(false);
      expect(result.status).toBe(403);
      expect(result.error).toMatchObject({
        code: 'missing_oauth_scope',
        required_scope: 'docs:document.media:download,drive:drive:readonly,drive:file:download',
      });
      expect(result.error?.permission_url).toContain('cli_test');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
