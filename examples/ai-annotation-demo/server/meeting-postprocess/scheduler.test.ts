import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildEvidenceSnapshot } from './evidence-snapshot';
import { MeetingPostprocessScheduler } from './scheduler';
import { MeetingPostprocessStore } from './store';
import { POSTPROCESS_SCHEMA_VERSION, postprocessRunSchema } from './contracts';

const scope = { tenant_id: 't', user_id: 'u', meeting_id: 'm', occurrence_id: 'zoom:occ' };
const snapshot = () => buildEvidenceSnapshot({ ...scope, transcript_final: true, ocr_status: 'ready', utterances: [{ start_ms: 0, end_ms: 10, text: 'We decided to launch Friday. Alex owns the release.' }] });
const response = () => ({ theme: 'Launch meeting', overview: 'Ship Friday', section_titles: { background: '发布背景与目标', discussion: '上线时间与范围', next_steps: '发布准备与提醒' }, key_points: [{ id: 'kp1', text: 'Launch is planned', evidence_refs: [snapshot().utterances[0].id] }], decisions: [{ id: 'decision-1', text: 'Launch Friday', status: 'confirmed', evidence_refs: [snapshot().utterances[0].id] }], action_items: [{ id: 'action-1', task: 'Prepare release', owner: 'Alex', due_at: null, commitment: 'explicit', evidence_refs: [snapshot().utterances[0].id] }], highlights: [], risks: [], open_questions: [], personal_notes: [] });

function promptAwareResponse(input: { user: string }) {
  const refs = [...input.user.matchAll(/(?:utterance:|\"evidence_refs\":\[\")([^\s\"\]]+)/g)].map((match) => match[1]);
  const ref = refs.at(-1) || 'u1';
  return { theme: 'Meeting', overview: 'Evidence covered', key_points: [{ id: `kp-${ref}`, text: `Point ${ref}`, evidence_refs: [ref] }], decisions: [], action_items: [], highlights: [], risks: [], open_questions: [], personal_notes: [] };
}

describe('MeetingPostprocessScheduler', () => {
  it('rejects all new full-report runs', async () => {
    const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'postprocess-')), scope);
    const scheduler = new MeetingPostprocessScheduler(store, async () => response());
    const value = snapshot(); await store.saveSnapshot(value);
    await expect(scheduler.enqueue(value, 'meeting.full_report')).rejects.toThrow('full_report_retired');
    expect(store.listRuns(scope)).toEqual([]);
  });

  it.each([
    { name: 'queued', status: 'queued' as const },
    { name: 'collecting evidence', status: 'collecting_evidence' as const },
    { name: 'running with an active lease', status: 'running' as const, lease_expires_at: '2099-01-01T00:00:00.000Z' },
    { name: 'running with an expired lease', status: 'running' as const, lease_expires_at: '2000-01-01T00:00:00.000Z' },
  ])('cancels a legacy $name full-report run without calling the model', async ({ name, status, lease_expires_at }) => {
    const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'postprocess-')), scope);
    const generate = vi.fn(async () => response());
    const scheduler = new MeetingPostprocessScheduler(store, generate);
    const value = snapshot(); await store.saveSnapshot(value);
    const now = new Date().toISOString();
    await store.enqueue(postprocessRunSchema.parse({ ...value, schema_version: POSTPROCESS_SCHEMA_VERSION, run_id: `legacy-report-run-${status}-${lease_expires_at || 'none'}`, idempotency_key: name === 'queued' ? 'a'.repeat(64) : name === 'collecting evidence' ? 'b'.repeat(64) : name === 'running with an active lease' ? 'c'.repeat(64) : 'd'.repeat(64), artifact_kind: 'meeting.full_report', meeting_title: 'Legacy report', enqueue_full_report: false, snapshot_id: value.snapshot_id, pipeline_version: 'v2:legacy', status, attempt: 0, priority: 10, available_at: now, lease_expires_at, created_at: now, updated_at: now }));
    await scheduler.drain();
    expect(store.listRuns(scope)[0]).toMatchObject({ status: 'cancelled', error_code: 'full_report_retired' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('generates canonical cards and readable summary without opening recap', async () => {
    const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'postprocess-')), scope);
    const generate = vi.fn(async () => response());
    const scheduler = new MeetingPostprocessScheduler(store, generate);
    const value = snapshot(); await store.saveSnapshot(value);
    const first = await scheduler.enqueue(value, 'meeting.summary_cards', { title: 'Launch meeting' });
    const duplicate = await scheduler.enqueue(value, 'meeting.summary_cards', { title: 'Launch meeting' });
    expect(duplicate.run_id).toBe(first.run_id);
    await scheduler.drain();
    expect(generate).toHaveBeenCalledTimes(1);
    const cards = store.listArtifacts(scope).find((x) => x.kind === 'meeting.summary_cards')?.content as { schema_version: string; action_items: unknown[] };
    expect(cards).toMatchObject({ schema_version: '2.0', action_items: [{ owner: 'Alex', due_at: null }] });
    const summary = String(store.listArtifacts(scope).find((x) => x.kind === 'meeting.summary')?.content);
    expect(summary).toContain('## 第一层：核心信息');
    expect(summary).toContain('### 一句话摘要');
    expect(summary).toContain('## 第二层：关键脉络');
    expect(store.listEvents(scope).find((event) => event.type === 'stage.metric')?.data).toMatchObject({ stage: 'brief' });
    expect(store.listArtifacts(scope).map((artifact) => artifact.kind)).toEqual(['meeting.summary_cards', 'meeting.summary']);
  });

  it('generates only HTML for the full interview archive template', async () => {
    const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'postprocess-')), scope);
    const value = buildEvidenceSnapshot({ ...scope, transcript_final: true, ocr_status: 'not_applicable', template_id: 'interview_archive', utterances: [{ id: 'u1', speaker_name: 'Holly', start_ms: 0, end_ms: 1, text: 'I do not export.' }] });
    const ref = value.utterances[0].id;
    const item = { title: '不导出', body: '受访者不导出白板', signal: 'negative', evidence_refs: [ref] };
    const generated = { title: '访谈归档', interview_date: '2026-07-22', interviewee: 'Holly', instant_findings: Array.from({ length: 5 }, (_, index) => ({ ...item, title: `发现${index}` })), profile: [], meeting_minutes: [], product_implications: [], evidence_strength: [], quotes: Array.from({ length: 4 }, (_, index) => ({ quote: `I do not export ${index}.`, speaker: 'Holly', time: '00:00', evidence_refs: [ref] })), fact_gaps: [], product_hypotheses: [], next_actions: [], archive_notes: [item] };
    const scheduler = new MeetingPostprocessScheduler(store, async () => generated);
    await store.saveSnapshot(value); await scheduler.enqueue(value, 'meeting.interview_archive_html'); await scheduler.drain();
    expect(store.listArtifacts(scope).map((artifact) => artifact.kind)).toEqual(['meeting.interview_archive_html']);
    expect(store.listArtifacts(scope)[0].content).toMatchObject({ filename: '2026-07-22，Holly用户访谈_中文版归档纪要.html', html: expect.stringContaining('<!doctype html>') });
  });

  it('enforces fixed template section ids, titles, order, and per-section limits', async () => {
    const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'postprocess-')), scope);
    const value = buildEvidenceSnapshot({ ...scope, transcript_final: true, ocr_status: 'not_applicable', template_id: 'university_notes', utterances: [{ id: 'u1', start_ms: 0, end_ms: 10, text: 'Entropy measures disorder.' }] });
    const items = Array.from({ length: 8 }, (_, index) => ({ id: `i${index}`, text: `Concept ${index}`, label: null, speaker: null, evidence_refs: [value.utterances[0].id] }));
    const generated = { theme: 'Entropy', overview: 'Entropy lesson', section_titles: { background: '课程概览', discussion: '课堂内容', next_steps: '复习' }, key_points: [], decisions: [], action_items: [], highlights: [], risks: [], open_questions: [], personal_notes: [], template_sections: [
      { id: 'examples', title: '模型自拟案例标题', summary: null, items: items.slice(0, 2) },
      { id: 'rogue', title: '不允许的通用板块', summary: null, items: items.slice(0, 1) },
      { id: 'key_concepts', title: '模型自拟概念标题', summary: null, items },
    ] };
    const scheduler = new MeetingPostprocessScheduler(store, async () => generated);
    await store.saveSnapshot(value); await scheduler.enqueue(value); await scheduler.drain();
    const cards = store.listArtifacts(scope).find((artifact) => artifact.kind === 'meeting.summary_cards')?.content as { template_sections: Array<{ id: string; title: string; items: unknown[] }> };
    expect(cards.template_sections.map((section) => [section.id, section.title])).toEqual([
      ['key_concepts', '关键概念与定义'], ['examples', '示例与案例研究'],
    ]);
    expect(cards.template_sections[0].items).toHaveLength(6);
  });

  it('records a retry without losing the run', async () => {
    const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'postprocess-')), scope);
    const scheduler = new MeetingPostprocessScheduler(store, async () => { throw new Error('provider_timeout'); });
    const value = snapshot(); await store.saveSnapshot(value); await scheduler.enqueue(value, 'meeting.summary_cards', { title: 'Failure' }); await scheduler.drain();
    expect(store.listRuns(scope)[0]).toMatchObject({ status: 'queued', attempt: 1, error_code: 'provider_timeout' });
    expect(store.listEvents(scope).map((x) => x.type)).toContain('run.retrying');
  });

  it('aborts a hung model call and releases the scheduler lane', async () => {
    vi.useFakeTimers();
    try {
      const store = new MeetingPostprocessStore(
        mkdtempSync(join(tmpdir(), 'postprocess-')),
        scope,
      );
      const signals: AbortSignal[] = [];
      const scheduler = new MeetingPostprocessScheduler(
        store,
        async ({ signal }) => {
          if (signal) signals.push(signal);
          return await new Promise<never>(() => {});
        },
        () => new Date(),
        undefined,
        50,
      );
      const value = snapshot();
      await store.saveSnapshot(value);
      await scheduler.enqueue(value, 'meeting.summary_cards', { title: 'Hung model' });
      const drain = scheduler.drain();
      await vi.advanceTimersByTimeAsync(51);
      await drain;
      expect(signals).toHaveLength(1);
      expect(signals[0].aborted).toBe(true);
      expect(store.listRuns(scope)[0]).toMatchObject({
        status: 'queued',
        attempt: 1,
        error_code: 'postprocess_provider_timeout',
      });

      const revised = buildEvidenceSnapshot({
        ...scope,
        revision: 2,
        transcript_final: true,
        ocr_status: 'ready',
        utterances: [
          ...value.utterances,
          { start_ms: 11, end_ms: 12, text: 'Recovery evidence.' },
        ],
      });
      await store.saveSnapshot(revised);
      const recovery = new MeetingPostprocessScheduler(
        store,
        async () => response(),
        () => new Date(),
        undefined,
        50,
      );
      await recovery.enqueue(revised);
      await recovery.drain();
      expect(store.listRuns(scope).at(-1)?.status).toBe('succeeded');
    } finally {
      vi.useRealTimers();
    }
  });

  it('automatically retries when backoff expires without another request', async () => {
    vi.useFakeTimers();
    try {
      const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'postprocess-')), scope);
      let calls = 0;
      const scheduler = new MeetingPostprocessScheduler(store, async () => { calls += 1; if (calls === 1) throw new Error('provider_timeout'); return response(); }, () => new Date());
      const value = snapshot(); await store.saveSnapshot(value); await scheduler.enqueue(value, 'meeting.summary_cards', {}); await scheduler.drain();
      expect(store.listRuns(scope)[0]).toMatchObject({ status: 'queued', attempt: 1 });
      await vi.advanceTimersByTimeAsync(2_001);
      expect(store.listRuns(scope)[0]).toMatchObject({ status: 'succeeded', attempt: 2 });
      expect(calls).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it('wakes at lease expiry and recovers an interrupted running job', async () => {
    vi.useFakeTimers();
    try {
      const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'postprocess-')), scope);
      const generate = vi.fn(async () => response());
      const scheduler = new MeetingPostprocessScheduler(store, generate, () => new Date());
      const value = snapshot(); await store.saveSnapshot(value);
      const run = await scheduler.enqueue(value, 'meeting.summary_cards', {});
      await store.updateRun(run.run_id, { status: 'running', lease_expires_at: new Date(Date.now() + 1_000).toISOString() });
      await scheduler.drain();
      expect(generate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_001);
      expect(store.listRuns(scope)[0].status).toBe('succeeded');
      expect(store.listEvents(scope).some((event) => event.type === 'run.retrying')).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('rejects hallucinated evidence references', async () => {
    const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'postprocess-')), scope);
    const invalid = { ...response(), decisions: [{ ...response().decisions[0], evidence_refs: ['missing'] }] };
    const scheduler = new MeetingPostprocessScheduler(store, async () => invalid);
    const value = snapshot(); await store.saveSnapshot(value); await scheduler.enqueue(value, 'meeting.summary_cards', { title: 'Invalid' }); await scheduler.drain();
    expect(store.listRuns(scope)[0]).toMatchObject({ status: 'queued', error_code: 'meeting_card_source_ref_invalid' });
    expect(store.listArtifacts(scope)).toHaveLength(0);
  });

  it('supersedes an older evidence revision without mutating its artifact', async () => {
    const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'postprocess-')), scope);
    const scheduler = new MeetingPostprocessScheduler(store, async () => response());
    const first = snapshot(); await store.saveSnapshot(first); await scheduler.enqueue(first, 'meeting.summary_cards', { title: 'First' }); await scheduler.drain();
    const revised = buildEvidenceSnapshot({ ...scope, revision: 2, transcript_final: true, ocr_status: 'ready', utterances: [{ start_ms: 0, end_ms: 10, text: 'We decided to launch Friday. Alex owns the release.' }, { start_ms: 11, end_ms: 12, text: 'Tail evidence' }] });
    await store.saveSnapshot(revised); await scheduler.enqueue(revised, 'meeting.summary_cards', { title: 'Revised' }); await scheduler.drain();
    expect(store.listRuns(scope).map((x) => x.status)).toEqual(['superseded', 'succeeded']);
    expect(store.listArtifacts(scope).filter((x) => x.kind === 'meeting.summary_cards').map((x) => x.status)).toEqual(['superseded', 'ready']);
  });

  it('does not publish a stale result after the user selects another snapshot', async () => {
    const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'postprocess-')), scope);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const scheduler = new MeetingPostprocessScheduler(store, async () => { started(); await wait; return response(); });
    const first = snapshot(); await store.saveSnapshot(first); const firstRun = await scheduler.enqueue(first);
    const drain = scheduler.drain(); await didStart;
    const second = buildEvidenceSnapshot({ ...scope, revision: 2, transcript_final: true, ocr_status: 'ready', template_id: 'interactive_classroom', utterances: first.utterances });
    await store.saveSnapshot(second); const secondRun = await scheduler.enqueue(second);
    release(); await drain; await scheduler.drain();
    expect(store.getRun(firstRun.run_id)?.status).toBe('superseded');
    expect(store.getRun(secondRun.run_id)?.status).toBe('succeeded');
    expect(store.listArtifacts(scope).filter((artifact) => artifact.status === 'ready').every((artifact) => artifact.snapshot_id === second.snapshot_id)).toBe(true);
  });

  it('cannot resurrect artifacts after a meeting is deleted during generation', async () => {
    const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'postprocess-')), scope);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const scheduler = new MeetingPostprocessScheduler(store, async () => { started(); await wait; return response(); });
    const value = snapshot(); await store.saveSnapshot(value); await scheduler.enqueue(value);
    const drain = scheduler.drain(); await didStart; await store.deleteMeeting(scope.meeting_id); release(); await drain;
    expect(store.listRuns(scope)).toEqual([]);
    expect(store.listArtifacts(scope)).toEqual([]);
  });

  it('reuses unchanged long-meeting chunks and recalculates only the revised tail', async () => {
    const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'postprocess-')), scope);
    const generate = vi.fn(async (input: { user: string }) => promptAwareResponse(input));
    const scheduler = new MeetingPostprocessScheduler(store, generate, () => new Date(), 30);
    const first = buildEvidenceSnapshot({ ...scope, transcript_final: true, ocr_status: 'ready', utterances: [
      { id: 'u1', start_ms: 0, end_ms: 1, text: 'First chunk has enough words here.' },
      { id: 'u2', start_ms: 2, end_ms: 3, text: 'Second chunk has enough words too.' },
      { id: 'u3', start_ms: 4, end_ms: 5, text: 'Tail chunk original evidence text.' },
    ] });
    await store.saveSnapshot(first); await scheduler.enqueue(first, 'meeting.summary_cards', {}); await scheduler.drain();
    const initialCalls = generate.mock.calls.length;
    expect(store.listRuns(scope).at(-1)?.status).toBe('succeeded');
    const revised = buildEvidenceSnapshot({ ...scope, revision: 2, transcript_final: true, ocr_status: 'ready', utterances: [
      { id: 'u1', start_ms: 0, end_ms: 1, text: 'First chunk has enough words here.' },
      { id: 'u2', start_ms: 2, end_ms: 3, text: 'Second chunk has enough words too.' },
      { id: 'u3', revision: 1, start_ms: 4, end_ms: 5, text: 'Tail chunk revised decision evidence.' },
    ] });
    await store.saveSnapshot(revised); await scheduler.enqueue(revised, 'meeting.summary_cards', {}); await scheduler.drain();
    expect(store.listRuns(scope).at(-1)?.status).toBe('succeeded');
    expect(generate.mock.calls.length - initialCalls).toBe(2); // revised tail extraction + global reducer
  });

  it('extracts long-meeting chunks with bounded concurrency and preserves ordered coverage', async () => {
    const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'postprocess-')), scope);
    let active = 0; let maxActive = 0;
    const generate = vi.fn(async (input: { user: string }) => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return promptAwareResponse(input);
    });
    const scheduler = new MeetingPostprocessScheduler(store, generate, () => new Date(), 20);
    const value = buildEvidenceSnapshot({ ...scope, transcript_final: true, ocr_status: 'ready', utterances: Array.from({ length: 12 }, (_, index) => ({ start_ms: index * 10, end_ms: index * 10 + 5, text: `utterance-${index}-${'x'.repeat(20)}` })) });
    await store.saveSnapshot(value); await scheduler.enqueue(value, 'meeting.summary_cards', {}); await scheduler.drain();
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(3);
    const cards = store.listArtifacts(scope).find((artifact) => artifact.kind === 'meeting.summary_cards')?.content as { key_points: Array<{ evidence_refs: string[] }> };
    expect(cards.key_points.flatMap((item) => item.evidence_refs)).toContain(value.utterances.at(-1)?.id);
  });

  it('keeps the canonical quick-summary artifact compact even when extraction is verbose', async () => {
    const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'postprocess-')), scope);
    const value = snapshot();
    const ref = value.utterances[0].id;
    const verbose = response();
    verbose.key_points = Array.from({ length: 12 }, (_, index) => ({ id: `kp${index}`, text: `Point ${index}`, evidence_refs: [ref] }));
    verbose.decisions = Array.from({ length: 12 }, (_, index) => ({ id: `d${index}`, text: `Decision ${index}`, status: 'confirmed' as const, evidence_refs: [ref] }));
    verbose.action_items = Array.from({ length: 12 }, (_, index) => ({ id: `a${index}`, task: `Task ${index}`, owner: 'Alex', due_at: null, commitment: 'explicit', evidence_refs: [ref] }));
    const scheduler = new MeetingPostprocessScheduler(store, async () => verbose);
    await store.saveSnapshot(value); await scheduler.enqueue(value); await scheduler.drain();
    const cards = store.listArtifacts(scope).find((artifact) => artifact.kind === 'meeting.summary_cards')?.content as typeof verbose;
    expect(cards.key_points).toHaveLength(5);
    expect(cards.decisions).toHaveLength(5);
    expect(cards.action_items).toHaveLength(8);
  });

  it('renders interview highlights, confirmed items, pending items, and next actions as dedicated sections', async () => {
    const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'postprocess-')), scope);
    const value = buildEvidenceSnapshot({ ...scope, meeting_title: 'Interview', template_id: 'interview_memo', transcript_final: true, ocr_status: 'not_applicable', started_at_ms: Date.parse('2026-07-20T08:54:31Z'), utterances: [{ id: 'a1', speaker_name: 'Holly', start_ms: 0, end_ms: 0, text: 'Current completion is 87 percent.' }] });
    const generated = {
      ...response(),
      highlights: [{ id: 'h1', text: 'Current completion: 87%', evidence_refs: ['a1'] }],
      key_points: [{ id: 'k1', text: 'Outcome tracking is required.', evidence_refs: ['a1'] }],
      decisions: [
        { id: 'd1', text: '确认继续追踪结果', status: 'confirmed' as const, evidence_refs: ['a1'] },
        { id: 'd2', text: '最新比例尚未确认', status: 'tentative' as const, evidence_refs: ['a1'] },
      ],
      action_items: [{ id: 'act1', task: 'Holly 补充最新数据', owner: 'Holly', due_at: null, commitment: 'explicit' as const, evidence_refs: ['a1'] }],
      risks: [],
      open_questions: [{ id: 'q1', text: '当前回复率是多少', evidence_refs: ['a1'] }],
    };
    const scheduler = new MeetingPostprocessScheduler(store, async () => generated);
    await store.saveSnapshot(value); await scheduler.enqueue(value); await scheduler.drain();
    const cards = store.listArtifacts(scope).find((artifact) => artifact.kind === 'meeting.summary_cards')?.content as { meeting_metadata: { duration_ms: number | null } };
    const summary = String(store.listArtifacts(scope).find((artifact) => artifact.kind === 'meeting.summary')?.content);
    expect(cards.meeting_metadata.duration_ms).toBeNull();
    expect(summary).toContain('| 访谈时长 | 未记录 |');
    expect(summary).toContain('## 关键数据与信号');
    expect(summary).toContain('Current completion: 87%');
    expect(summary).toContain('## 确认事项');
    expect(summary).toContain('确认继续追踪结果');
    expect(summary).toContain('## 待确认事项');
    expect(summary).toContain('最新比例尚未确认');
    expect(summary).toContain('当前回复率是多少');
    expect(summary).toContain('## 下一步行动');
    expect(summary).toContain('Holly 补充最新数据');
  });

  it('renders the meeting expert as a three-layer pyramid without the generic three-section layout', async () => {
    const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'postprocess-')), scope);
    const value = snapshot();
    const generated = {
      ...response(),
      overview: '一句话核心进展',
      key_points: [{ id: 'k1', text: '议题脉络与各方立场', evidence_refs: [value.utterances[0].id] }],
      highlights: [{ id: 'h1', text: '关键数据', evidence_refs: [value.utterances[0].id] }],
      risks: [{ id: 'r1', text: '[分析] 仍存在交付风险', mitigation: null, evidence_refs: [value.utterances[0].id] }],
      open_questions: [{ id: 'q1', text: '范围仍待确认', evidence_refs: [value.utterances[0].id] }],
    };
    const scheduler = new MeetingPostprocessScheduler(store, async () => generated);
    await store.saveSnapshot(value); await scheduler.enqueue(value); await scheduler.drain();
    const summary = String(store.listArtifacts(scope).find((artifact) => artifact.kind === 'meeting.summary')?.content);
    expect(summary).toContain('## 第一层：核心信息');
    expect(summary).toContain('### 一句话摘要');
    expect(summary).toContain('### 结论与决策');
    expect(summary).toContain('### 待办事项');
    expect(summary).toContain('## 第二层：关键脉络');
    expect(summary).toContain('### 讨论脉络');
    expect(summary).toContain('### 关键提取');
    expect(summary).toContain('## 第三层：深度洞察');
    expect(summary).toContain('### 深度分析');
    expect(summary).not.toContain('## 背景与概览');
    expect(summary).not.toContain('## 关键讨论要点');
    expect(summary).not.toContain('## 后续步骤与提醒');
  });

  it('keeps summary derived from the first canonical cards after a partial retry', async () => {
    const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'postprocess-')), scope);
    const value = snapshot();
    const first = response(); first.overview = 'Canonical first pass';
    const second = response(); second.overview = 'Different retry pass';
    let calls = 0;
    const originalSave = store.saveArtifact.bind(store);
    let failSummaryOnce = true;
    store.saveArtifact = async (artifact, runId) => {
      if (artifact.kind === 'meeting.summary' && failSummaryOnce) { failSummaryOnce = false; throw new Error('summary_write_failed'); }
      return await originalSave(artifact, runId);
    };
    const scheduler = new MeetingPostprocessScheduler(store, async () => calls++ === 0 ? first : second, () => new Date());
    await store.saveSnapshot(value); await scheduler.enqueue(value); await scheduler.drain();
    expect(store.listRuns(scope)[0]).toMatchObject({ status: 'queued' });
    const queued = store.listRuns(scope)[0];
    await store.updateRun(queued.run_id, { available_at: new Date(0).toISOString() });
    await scheduler.drain();
    const artifacts = store.listArtifacts(scope).filter((artifact) => artifact.status === 'ready');
    const cards = artifacts.find((artifact) => artifact.kind === 'meeting.summary_cards')?.content as { overview: string };
    expect(cards.overview).toBe('Canonical first pass');
    expect(String(artifacts.find((artifact) => artifact.kind === 'meeting.summary')?.content)).toContain('Canonical first pass');
  });

  it('drops an empty malformed action instead of retrying the whole brief', async () => {
    const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'postprocess-')), scope);
    const value = snapshot(); const generated = { ...response(), action_items: [{ id: 'empty', owner: null, due_at: null, commitment: 'proposed', evidence_refs: [value.utterances[0].id] }] };
    const generate = vi.fn(async () => generated);
    const scheduler = new MeetingPostprocessScheduler(store, generate);
    await store.saveSnapshot(value); await scheduler.enqueue(value); await scheduler.drain();
    expect(store.listRuns(scope).at(-1)).toMatchObject({ status: 'succeeded', attempt: 1 });
    expect(generate).toHaveBeenCalledTimes(1);
    const cards = store.listArtifacts(scope).find((artifact) => artifact.kind === 'meeting.summary_cards')?.content as { action_items: unknown[] };
    expect(cards.action_items).toEqual([]);
  });

  it('normalizes string null owner and due values before rendering', async () => {
    const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'postprocess-')), scope);
    const value = snapshot();
    const generated = { ...response(), action_items: [{ id: 'a-null', task: '确认要求', owner: 'null', due_at: 'null', commitment: 'explicit', evidence_refs: [value.utterances[0].id] }] };
    const scheduler = new MeetingPostprocessScheduler(store, async () => generated);
    await store.saveSnapshot(value); await scheduler.enqueue(value); await scheduler.drain();
    const cards = store.listArtifacts(scope).find((artifact) => artifact.kind === 'meeting.summary_cards')?.content as { action_items: Array<{ owner: string | null; due_at: string | null }> };
    const summary = String(store.listArtifacts(scope).find((artifact) => artifact.kind === 'meeting.summary')?.content);
    expect(cards.action_items[0]).toMatchObject({ owner: null, due_at: null });
    expect(summary).not.toContain('null');
  });

  it('invalidates long-meeting chunk cache when handwriting changes', async () => {
    const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'postprocess-')), scope);
    const generate = vi.fn(async (input: { user: string }) => promptAwareResponse(input));
    const scheduler = new MeetingPostprocessScheduler(store, generate, () => new Date(), 20);
    const utterances = [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'First chunk enough words.' }, { id: 'u2', start_ms: 2, end_ms: 3, text: 'Second chunk enough words.' }];
    const first = buildEvidenceSnapshot({ ...scope, transcript_final: true, ocr_status: 'ready', utterances, handwriting: [] });
    await store.saveSnapshot(first); await scheduler.enqueue(first, 'meeting.summary_cards', {}); await scheduler.drain();
    const initialCalls = generate.mock.calls.length;
    expect(store.listRuns(scope).at(-1)?.status).toBe('succeeded');
    const revised = buildEvidenceSnapshot({ ...scope, revision: 2, transcript_final: true, ocr_status: 'ready', utterances, handwriting: [{ id: 'h1', text: 'personal thought', revision: 1, mark_ids: ['mark1'], confidence: 1, corrected_by_user: false }] });
    await store.saveSnapshot(revised); await scheduler.enqueue(revised, 'meeting.summary_cards', {}); await scheduler.drain();
    expect(store.listRuns(scope).at(-1)?.status).toBe('succeeded');
    expect(generate.mock.calls.length - initialCalls).toBe(initialCalls);
  });

  it('does not share runs across local meetings with the same provider occurrence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'postprocess-'));
    const store = new MeetingPostprocessStore(root, scope);
    const scheduler = new MeetingPostprocessScheduler(store, async () => response());
    const first = snapshot();
    const second = buildEvidenceSnapshot({ ...scope, meeting_id: 'm2', transcript_final: true, ocr_status: 'ready', utterances: [{ start_ms: 0, end_ms: 10, text: 'We decided to launch Friday. Alex owns the release.' }] });
    await store.saveSnapshot(first); await store.saveSnapshot(second);
    const firstRun = await scheduler.enqueue(first, 'meeting.summary_cards', {});
    const secondRun = await scheduler.enqueue(second, 'meeting.summary_cards', {});
    expect(secondRun.run_id).not.toBe(firstRun.run_id);
  });
});
