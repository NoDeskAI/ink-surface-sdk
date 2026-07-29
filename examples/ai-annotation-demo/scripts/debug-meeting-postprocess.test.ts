import { describe, expect, it } from 'vitest';
import { debugMeetingPostprocess, validateDebugMeetingPostprocessArgs } from './debug-meeting-postprocess';

describe('debugMeetingPostprocess', () => {
  it('runs the acceptance fixture end to end without a provider key', async () => {
    const output = await debugMeetingPostprocess(['fixtures/meeting-postprocess/ordinary.json']);
    expect(output.snapshot).toMatchObject({ finality: 'final', utterance_count: 2 });
    expect((output.runs as Array<{ status: string }>).every((x) => x.status === 'succeeded')).toBe(true);
    expect((output.artifacts as Array<{ kind: string }>).map((x) => x.kind)).toEqual(['meeting.summary_cards', 'meeting.summary']);
    expect(output.metrics).toEqual([expect.objectContaining({ stage: 'brief' })]);
  });
  it('forces the long fixture through chunk extraction and keeps the tail decision', async () => {
    const output = await debugMeetingPostprocess(['fixtures/meeting-postprocess/long.json']);
    expect(output.model_calls).toBeGreaterThan(3);
    const cards = (output.artifacts as Array<{ kind: string; content: any }>).find((artifact) => artifact.kind === 'meeting.summary_cards')?.content;
    expect(cards.decisions.some((item: { evidence_refs: string[] }) => item.evidence_refs.includes('u3'))).toBe(true);
  });
  it('runs the selected template with optional user guidance', async () => {
    const output = await debugMeetingPostprocess([
      'fixtures/meeting-postprocess/interview.json',
      '--template=interview_memo',
      '--conclusion=优先确认用户动机',
      '--impression=受访者最在意操作负担',
      '--pain-point=信息过密',
      '--cards-only',
    ]);
    expect(output.snapshot).toMatchObject({
      template_id: 'interview_memo',
      user_guidance: {
        source: 'user_supplied',
        conclusions: ['优先确认用户动机'],
        deepest_impressions: ['受访者最在意操作负担'],
        pain_points: ['信息过密'],
      },
    });
    expect((output.artifacts as Array<{ kind: string; content: { template_id?: string } }>).map((item) => item.kind))
      .toEqual(['meeting.summary_cards', 'meeting.summary']);
    expect((output.artifacts as Array<{ kind: string; content: { template_id?: string } }>).find((item) => item.kind === 'meeting.summary_cards')?.content.template_id)
      .toBe('interview_memo');
  });
  it('rejects an unknown template before running the model', async () => {
    await expect(debugMeetingPostprocess(['fixtures/meeting-postprocess/ordinary.json', '--template=unknown']))
      .rejects.toThrow('unknown meeting template: unknown');
  });
  it('rejects misspelled flags and extra fixture positionals', () => {
    expect(() => validateDebugMeetingPostprocessArgs(['--tempalte=meeting_expert']))
      .toThrow('unknown_argument:--tempalte=meeting_expert');
    expect(() => validateDebugMeetingPostprocessArgs(['one.json', 'two.json']))
      .toThrow('unexpected_positional:two.json');
  });
});
