import { describe, expect, it, vi } from 'vitest';
import { createMeetingHomeSync } from './meeting-home-sync';

describe('会议首页同步锁', () => {
  it('并发两轮检查并创建只生成一张会议卡', async () => {
    const cards: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const round = vi.fn(async () => {
      const existing = cards.includes('zoom:987654321');
      await gate;
      if (!existing) cards.push('zoom:987654321');
    });
    const sync = createMeetingHomeSync(round);

    const first = sync();
    const second = sync();
    release();
    await Promise.all([first, second]);

    expect(round).toHaveBeenCalledTimes(1);
    expect(cards).toEqual(['zoom:987654321']);
  });
});
