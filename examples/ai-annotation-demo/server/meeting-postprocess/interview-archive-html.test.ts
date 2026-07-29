import { describe, expect, it, vi } from 'vitest';
import { buildEvidenceSnapshot } from './evidence-snapshot';
import { generateInterviewArchiveHtml } from './interview-archive-html';

describe('interview archive HTML', () => {
  it('renders a self-contained, escaped, printable nine-section archive', async () => {
    const snapshot = buildEvidenceSnapshot({ tenant_id: 't', user_id: 'u', meeting_id: 'm', occurrence_id: 'o', meeting_title: 'Teacher interview', template_id: 'interview_archive', transcript_final: true, ocr_status: 'not_applicable', user_guidance: { conclusions: ['实体白板可能只是临时草稿'], deepest_impressions: ['不愿增加操作'], pain_points: ['课程恢复'] }, utterances: [{ id: 'u1', speaker_name: 'Holly', start_ms: 60_000, end_ms: 61_000, text: 'I do not export the board.' }] });
    const item = (title: string, signal = 'neutral') => ({ title, body: '<script>alert(1)</script> 不外推', signal, evidence_refs: ['u1'] });
    const generate = vi.fn(async (_input: { system: string; user: string; max_tokens: number }) => ({
      title: 'Holly 用户访谈归档', interview_date: '2026-07-22', interviewee: 'Holly',
      instant_findings: [item('发现1','negative'),item('发现2'),item('发现3'),item('发现4'),item('发现5')], profile: [item('教师画像')], meeting_minutes: [item('白板工作流')], product_implications: [item('产品限制','uncertain')],
      evidence_strength: [{ conclusion: '不导出', strength: '高', basis: '受访者明确陈述', evidence_refs: ['u1'] }],
      quotes: Array.from({ length: 4 }, (_, index) => ({ quote: `I do not export ${index}.`, speaker: 'Holly', time: '01:00', evidence_refs: ['u1'] })),
      fact_gaps: [item('频率未覆盖','uncertain')], product_hypotheses: [item('恢复课程假设','uncertain')], next_actions: [item('观察真实备课')], archive_notes: [item('单一样本')],
    }));
    const result = await generateInterviewArchiveHtml({ title: 'Teacher interview', snapshot, generate });
    const firstRequest = generate.mock.calls[0]?.[0] as { system: string; user: string; max_tokens: number } | undefined;
    expect(firstRequest).toEqual(expect.objectContaining({ max_tokens: 24_000, user: expect.stringContaining('研究者即时见解') }));
    expect(firstRequest?.system).toContain('对象绑定');
    expect(firstRequest?.system).toContain('量词保真');
    expect(result.filename).toBe('2026-07-22，Holly用户访谈_中文版归档纪要.html');
    expect(result.html).toContain('<!doctype html>');
    expect(result.html).toContain('一、研究者即时发现（优先阅读）');
    expect(result.html).toContain('八、归档说明');
    expect(result.html).not.toContain('值得保留的受访者原话');
    expect(result.html.indexOf('I do not export 0.')).toBeGreaterThan(result.html.indexOf('三、完整会议纪要'));
    expect(result.html.indexOf('I do not export 0.')).toBeLessThan(result.html.indexOf('四、产品机会或对产品方向的影响'));
    expect(result.html).not.toContain('自动会议纪要');
    expect(result.html).toContain('@media print');
    expect(result.html).not.toContain('<script>');
    expect(result.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(result.html).not.toMatch(/https?:\/\//);
    expect(result.html).toContain('研究者判断');
  });

  it('rejects hallucinated evidence references', async () => {
    const snapshot = buildEvidenceSnapshot({ tenant_id: 't', user_id: 'u', meeting_id: 'm', occurrence_id: 'o', template_id: 'interview_archive', transcript_final: true, ocr_status: 'not_applicable', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'Evidence' }] });
    const item = { title: 'x', body: 'x', signal: 'neutral', evidence_refs: ['invented'] };
    const response = { title: 'x', interview_date: '', interviewee: 'x', instant_findings: Array(5).fill(item), profile: [], meeting_minutes: [], product_implications: [], evidence_strength: [], quotes: Array(4).fill({ quote: 'x', speaker: '', time: '', evidence_refs: ['invented'] }), fact_gaps: [], product_hypotheses: [], next_actions: [], archive_notes: [item] };
    await expect(generateInterviewArchiveHtml({ title: 'x', snapshot, generate: async () => response })).rejects.toThrow('interview_archive_source_ref_invalid');
  });

  it('normalizes a structured interviewee name without relaxing other fields', async () => {
    const snapshot = buildEvidenceSnapshot({ tenant_id: 't', user_id: 'u', meeting_id: 'm', occurrence_id: 'o', template_id: 'interview_archive', transcript_final: true, ocr_status: 'not_applicable', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'Evidence' }] });
    const item = { title: 'x', body: 'x', signal: 'neutral', evidence_refs: ['u1'] };
    const response = { title: 'x', interview_date: '2026-07-20', interviewee: { name: 'Holly Peterson', role: 'VP' }, instant_findings: Array.from({ length: 5 }, (_, index) => ({ ...item, title: `x${index}` })), profile: [], meeting_minutes: [], product_implications: [], evidence_strength: [], quotes: Array.from({ length: 4 }, (_, index) => ({ quote: `q${index}`, speaker: 'Holly', time: '', evidence_refs: ['u1'] })), fact_gaps: [], product_hypotheses: [], next_actions: [], archive_notes: [item] };
    await expect(generateInterviewArchiveHtml({ title: 'x', snapshot, generate: async () => response })).resolves.toMatchObject({ filename: '2026-07-20，HollyPeterson用户访谈_中文版归档纪要.html' });
  });

  it('uses trusted meeting metadata instead of a hallucinated model date', async () => {
    const snapshot = buildEvidenceSnapshot({ tenant_id: 't', user_id: 'u', meeting_id: 'm', occurrence_id: 'o', template_id: 'interview_archive', transcript_final: true, ocr_status: 'not_applicable', started_at_ms: Date.parse('2026-07-22T02:00:00.000Z'), utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'Evidence' }] });
    const item = { title: 'x', body: 'x', signal: 'neutral', evidence_refs: ['u1'] };
    const response = { title: 'x', interview_date: '2024-08-14', interviewee: 'Holly', instant_findings: Array.from({ length: 5 }, (_, index) => ({ ...item, title: `x${index}` })), profile: [], meeting_minutes: [], product_implications: [], evidence_strength: [], quotes: Array.from({ length: 4 }, (_, index) => ({ quote: `q${index}`, speaker: 'Holly', time: '', evidence_refs: ['u1'] })), fact_gaps: [], product_hypotheses: [], next_actions: [], archive_notes: [item] };
    const result = await generateInterviewArchiveHtml({ title: 'x', snapshot, generate: async () => response });
    expect(result.filename).toBe('2026-07-22，Holly用户访谈_中文版归档纪要.html');
    expect(result.html).toContain('访谈日期：2026-07-22');
    expect(result.html).not.toContain('2024-08-14');
  });

  it('derives quote timestamps from referenced evidence instead of model text', async () => {
    const snapshot = buildEvidenceSnapshot({ tenant_id: 't', user_id: 'u', meeting_id: 'm', occurrence_id: 'o', template_id: 'interview_archive', transcript_final: true, ocr_status: 'not_applicable', utterances: [{ id: 'u1', start_ms: 75_000, end_ms: 76_000, text: 'Evidence' }] });
    const item = { title: 'x', body: 'x', signal: 'neutral', evidence_refs: ['u1'] };
    const response = { title: 'x', interview_date: '', interviewee: 'Holly', instant_findings: Array.from({ length: 5 }, (_, index) => ({ ...item, title: `x${index}` })), profile: [], meeting_minutes: [], product_implications: [], evidence_strength: [], quotes: Array.from({ length: 4 }, (_, index) => ({ quote: `q${index}`, speaker: 'Holly', time: '999999:59', evidence_refs: ['u1'] })), fact_gaps: [], product_hypotheses: [], next_actions: [], archive_notes: [item] };
    const result = await generateInterviewArchiveHtml({ title: 'x', snapshot, generate: async () => response });
    expect(result.html).toContain('Holly · 1:15');
    expect(result.html).not.toContain('999999:59');
  });

  it('keeps evidence refs for validation without leaking internal indexes into HTML', async () => {
    const snapshot = buildEvidenceSnapshot({ tenant_id: 't', user_id: 'u', meeting_id: 'm', occurrence_id: 'o', template_id: 'interview_archive', transcript_final: true, ocr_status: 'not_applicable', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'Evidence' }] });
    const item = { title: 'x', body: '可读结论。evidence_refs: [u1]', signal: 'neutral', evidence_refs: ['u1'] };
    const response = { title: 'x', interview_date: '', interviewee: 'Holly', instant_findings: Array.from({ length: 5 }, (_, index) => ({ ...item, title: `x${index}` })), profile: [], meeting_minutes: [], product_implications: [], evidence_strength: [], quotes: Array.from({ length: 4 }, (_, index) => ({ quote: `q${index}`, speaker: 'Holly', time: '', evidence_refs: ['u1'] })), fact_gaps: [], product_hypotheses: [], next_actions: [], archive_notes: [item] };
    const result = await generateInterviewArchiveHtml({ title: 'x', snapshot, generate: async () => response });
    expect(result.html).toContain('可读结论。');
    expect(result.html).not.toContain('evidence_refs');
    expect(result.html).not.toContain('[u1]');
  });

  it('rejects English analysis while allowing original-language quotes and names', async () => {
    const snapshot = buildEvidenceSnapshot({ tenant_id: 't', user_id: 'u', meeting_id: 'm', occurrence_id: 'o', template_id: 'interview_archive', transcript_final: true, ocr_status: 'not_applicable', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'I reuse the whiteboard.' }] });
    const item = { title: 'Reusable whiteboard', body: 'The teacher reuses the prepared whiteboard throughout the week because repetition supports the student and reduces preparation work. This is an English analysis paragraph that should be rejected by the Chinese archive language gate.', signal: 'positive', evidence_refs: ['u1'] };
    const response = { title: 'Holly Interview Archive', interview_date: '', interviewee: 'Holly', instant_findings: Array.from({ length: 5 }, (_, index) => ({ ...item, title: `${item.title} ${index}` })), profile: [], meeting_minutes: [], product_implications: [], evidence_strength: [], quotes: Array.from({ length: 4 }, (_, index) => ({ quote: `I reuse it ${index}.`, speaker: 'Holly', time: '', evidence_refs: ['u1'] })), fact_gaps: [], product_hypotheses: [], next_actions: [], archive_notes: [item] };
    await expect(generateInterviewArchiveHtml({ title: 'x', snapshot, generate: async () => response })).rejects.toThrow('interview_archive_analysis_language_invalid');
  });

  it('folds prompt-requested finding dimensions into the readable body', async () => {
    const snapshot = buildEvidenceSnapshot({ tenant_id: 't', user_id: 'u', meeting_id: 'm', occurrence_id: 'o', template_id: 'interview_archive', transcript_final: true, ocr_status: 'not_applicable', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'Evidence' }] });
    const rich = { title: '行为发现', body: '真实行为', signal: 'negative', importance: '改变方向', product_implications: '不做导出', evidence_strength: '高', inference_boundary: '单一样本', evidence_refs: ['u1'] };
    const plain = { title: 'x', body: 'x', signal: 'neutral', evidence_refs: ['u1'] };
    const response = { title: 'x', interview_date: '', interviewee: 'Holly', instant_findings: [rich, plain, plain, plain, plain], profile: [], meeting_minutes: [], product_implications: [], evidence_strength: [], quotes: Array.from({ length: 4 }, (_, index) => ({ quote: `q${index}`, speaker: 'Holly', time: '', evidence_refs: ['u1'] })), fact_gaps: [], product_hypotheses: [], next_actions: [], archive_notes: [plain] };
    const result = await generateInterviewArchiveHtml({ title: 'x', snapshot, generate: async () => response });
    expect(result.html).toContain('为什么重要：改变方向');
    expect(result.html).toContain('产品含义：不做导出');
    expect(result.html).toContain('推断边界：单一样本');
  });

  it('renders evidence source, object scope, and opportunity level as readable badges', async () => {
    const snapshot = buildEvidenceSnapshot({ tenant_id: 't', user_id: 'u', meeting_id: 'm', occurrence_id: 'o', template_id: 'interview_archive', transcript_final: true, ocr_status: 'not_applicable', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'Evidence' }] });
    const tagged = { title: '待验证机会', body: '行为支持但并非主动需求。', signal: 'uncertain', evidence_type: 'product_hypothesis', object_scope: '数字白板', opportunity_level: 'behavior_supported_hypothesis', evidence_refs: ['u1'] };
    const plain = { title: '其他发现', body: '研究者判断。', signal: 'neutral', evidence_refs: ['u1'] };
    const response = { title: '访谈归档', interview_date: '', interviewee: 'Holly', instant_findings: [tagged, plain, plain, plain, plain], profile: [], meeting_minutes: [], product_implications: [], evidence_strength: [], quotes: Array.from({ length: 4 }, (_, index) => ({ quote: `q${index}`, speaker: 'Holly', time: '', evidence_refs: ['u1'] })), fact_gaps: [], product_hypotheses: [], next_actions: [], archive_notes: [plain] };
    const result = await generateInterviewArchiveHtml({ title: 'x', snapshot, generate: async () => response });
    expect(result.html).toContain('产品假设');
    expect(result.html).toContain('数字白板');
    expect(result.html).toContain('行为支持假设');
  });

  it('places each quote after the meeting-minute subsection sharing its evidence', async () => {
    const snapshot = buildEvidenceSnapshot({ tenant_id: 't', user_id: 'u', meeting_id: 'm', occurrence_id: 'o', template_id: 'interview_archive', transcript_final: true, ocr_status: 'not_applicable', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'First evidence' }, { id: 'u2', start_ms: 60_000, end_ms: 61_000, text: 'Second evidence' }] });
    const item = { title: '普通发现', body: '研究者判断。', signal: 'neutral', evidence_refs: ['u1'] };
    const response = { title: '访谈归档', interview_date: '', interviewee: 'Holly', instant_findings: Array.from({ length: 5 }, (_, index) => ({ ...item, title: `发现${index}` })), profile: [], meeting_minutes: [{ ...item, title: '第一话题', evidence_refs: ['u1'] }, { ...item, title: '第二话题', evidence_refs: ['u2'] }], product_implications: [], evidence_strength: [], quotes: [{ quote: 'First quote.', speaker: 'Holly', time: '', evidence_refs: ['u1'] }, { quote: 'Second quote.', speaker: 'Holly', time: '', evidence_refs: ['u2'] }, { quote: 'First quote again.', speaker: 'Holly', time: '', evidence_refs: ['u1'] }, { quote: 'Second quote again.', speaker: 'Holly', time: '', evidence_refs: ['u2'] }], fact_gaps: [], product_hypotheses: [], next_actions: [], archive_notes: [item] };
    const result = await generateInterviewArchiveHtml({ title: 'x', snapshot, generate: async () => response });
    const firstTopic = result.html.indexOf('第一话题');
    const firstQuote = result.html.indexOf('First quote.');
    const secondTopic = result.html.indexOf('第二话题');
    const secondQuote = result.html.indexOf('Second quote.');
    expect(firstTopic).toBeLessThan(firstQuote);
    expect(firstQuote).toBeLessThan(secondTopic);
    expect(secondTopic).toBeLessThan(secondQuote);
  });

  it('renders a quote only once when multiple minute sections share its evidence', async () => {
    const snapshot = buildEvidenceSnapshot({ tenant_id: 't', user_id: 'u', meeting_id: 'm', occurrence_id: 'o', template_id: 'interview_archive', transcript_final: true, ocr_status: 'not_applicable', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'Shared evidence' }] });
    const item = { title: '普通发现', body: '研究者判断。', signal: 'neutral', evidence_refs: ['u1'] };
    const response = { title: '访谈归档', interview_date: '', interviewee: 'Holly', instant_findings: Array.from({ length: 5 }, (_, index) => ({ ...item, title: `发现${index}` })), profile: [], meeting_minutes: [{ ...item, title: '第一话题' }, { ...item, title: '第二话题' }], product_implications: [], evidence_strength: [], quotes: Array.from({ length: 4 }, (_, index) => ({ quote: `Unique quote ${index}.`, speaker: 'Holly', time: '', evidence_refs: ['u1'] })), fact_gaps: [], product_hypotheses: [], next_actions: [], archive_notes: [item] };
    const result = await generateInterviewArchiveHtml({ title: 'x', snapshot, generate: async () => response });
    expect(result.html.match(/Unique quote 0\./g)).toHaveLength(1);
  });
});
