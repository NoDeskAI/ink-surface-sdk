import { describe, expect, it } from 'vitest';
import { joinErrorMessage, nextBoardSyncNotice, reconnectDelay, selectionBox } from './student-main';

describe('student classroom state helpers', () => {
  it('replaces only the stale empty-board notice after the first applied event', () => {
    expect(nextBoardSyncNotice('课堂还没有板书。', 'applied')).toBe('板书已同步，可以解释当前步骤。');
    expect(nextBoardSyncNotice('正在解释当前板书…', 'applied')).toBe('正在解释当前板书…');
    expect(nextBoardSyncNotice('课堂还没有板书。', 'duplicate')).toBe('课堂还没有板书。');
  });

  it('creates a normalized selection independent of drag direction', () => {
    expect(selectionBox({ x_norm: 0.8, y_norm: 0.7 }, { x_norm: 0.2, y_norm: 0.1 })).toEqual({
      x: 0.2, y: 0.1, width: 0.6000000000000001, height: 0.6,
    });
  });

  it('uses bounded exponential reconnect backoff', () => {
    expect([0, 1, 2, 3, 4, 5].map(reconnectDelay)).toEqual([500, 1_000, 2_000, 4_000, 8_000, 8_000]);
  });

  it('explains classroom lifecycle and join validation errors', () => {
    expect(joinErrorMessage(new Error('classroom_not_live'))).toBe('课堂尚未开始或已结束，请联系老师。');
    expect(joinErrorMessage(new Error('join_rate_limited'))).toBe('尝试次数过多，请稍后再试。');
    expect(joinErrorMessage(new Error('nickname_required'))).toBe('请填写有效昵称。');
    expect(joinErrorMessage(new Error('network_failed'))).toBe('无法加入课堂，请检查网络、课堂码和昵称。');
  });
});
