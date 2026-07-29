import { describe, expect, it } from 'vitest';
import {
  selectLiveTranscriptUtterances,
  type LiveBoardTranscriptUtterance,
} from './meeting-live-board-transcript';

function utterance(
  text: string,
  start_ms: number,
  confidence?: number,
): LiveBoardTranscriptUtterance {
  return {
    utterance_id: `utt-${start_ms}`,
    track: 'mic',
    start_ms,
    end_ms: start_ms + 1_000,
    text,
    revision: 1,
    ...(confidence === undefined ? {} : { confidence }),
  };
}

describe('selectLiveTranscriptUtterances', () => {
  it('keeps useful speech while hiding low-confidence noise fragments', () => {
    expect(selectLiveTranscriptUtterances([
      utterance('有的市场有大门', 1_000, 0.43),
      utterance('多次展', 2_000, 0.57),
      utterance('明白', 3_000, 0.84),
      utterance('这是 OK 的', 4_000, 0.69),
    ])).toEqual([
      expect.objectContaining({ text: '明白' }),
      expect.objectContaining({ text: '这是 OK 的' }),
    ]);
  });

  it('suppresses common Whisper boilerplate hallucinations regardless of confidence', () => {
    expect(selectLiveTranscriptUtterances([
      utterance('请不吝点赞 订阅 转发 打赏支持明镜与点点栏', 1_000, 0.99),
      utterance('感谢观看', 2_000, 0.98),
      utterance('中文字幕志愿者 杨栋梁', 3_000, 0.99),
    ])).toEqual([]);
  });

  it('does not let repeated captions flood the live rail', () => {
    expect(selectLiveTranscriptUtterances([
      utterance('谢谢大家', 1_000, 0.92),
      utterance('谢谢大家', 10_000, 0.94),
      utterance('我们继续讨论发布计划', 11_000, 0.81),
    ])).toEqual([
      expect.objectContaining({ text: '谢谢大家' }),
      expect.objectContaining({ text: '我们继续讨论发布计划' }),
    ]);
  });

  it('does not reject provider output that has no confidence field', () => {
    expect(selectLiveTranscriptUtterances([
      utterance('需要保留的实时发言', 1_000),
    ])).toHaveLength(1);
  });
});
