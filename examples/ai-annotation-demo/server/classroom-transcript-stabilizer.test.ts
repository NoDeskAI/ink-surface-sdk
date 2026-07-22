import { describe, expect, it } from 'vitest';
import { stabilizeClassroomTranscriptText } from './classroom-transcript-stabilizer';

describe('classroom transcript stabilizer', () => {
  it('adds punctuation and repairs a one-character contextual term error', () => {
    expect(stabilizeClassroomTranscriptText('两边加九得到完全平房', ['完全平方'])).toEqual({
      text: '两边加九得到完全平方。', changed: true, reasons: ['context_term', 'terminal_punctuation'],
    });
  });

  it('preserves both sides of an explicit teacher self-correction', () => {
    expect(stabilizeClassroomTranscriptText('x 等于三不对应该是负三', [])).toMatchObject({
      text: 'x 等于三——更正为负三。', changed: true, reasons: ['explicit_self_correction', 'terminal_punctuation'],
    });
  });

  it('never changes numeric, variable, or operator signatures through a contextual term', () => {
    expect(stabilizeClassroomTranscriptText('x+3=4', ['x+3=9'])).toEqual({
      text: 'x+3=4.', changed: true, reasons: ['terminal_punctuation'],
    });
  });

  it('does not invent content for a short utterance', () => {
    expect(stabilizeClassroomTranscriptText('嗯', [])).toEqual({ text: '嗯。', changed: true, reasons: ['terminal_punctuation'] });
  });
});
