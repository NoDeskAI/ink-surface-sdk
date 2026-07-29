import { describe, expect, it } from 'vitest';
import { shouldRenderLiveBoardStatus, type LiveBoardConnectionState } from './meeting-live-board-state';

const waiting: LiveBoardConnectionState = {
  connected: false,
  active: false,
  transcriptSessionID: null,
  transcriptRevision: null,
  tracks: [],
  pendingChunks: 0,
};

describe('shouldRenderLiveBoardStatus', () => {
  it('renders the first successful connection even when no meeting is active', () => {
    expect(shouldRenderLiveBoardStatus(waiting, { ...waiting, connected: true })).toBe(true);
  });

  it('does not rerender an unchanged connected idle state', () => {
    const connected = { ...waiting, connected: true };
    expect(shouldRenderLiveBoardStatus(connected, connected)).toBe(false);
  });

  it('renders track, queue, and transcript revisions during a meeting', () => {
    const connected = { ...waiting, connected: true };
    expect(shouldRenderLiveBoardStatus(connected, {
      ...connected,
      active: true,
      transcriptSessionID: 'session-1',
      transcriptRevision: 2,
      tracks: ['mic', 'remote'],
      pendingChunks: 1,
    })).toBe(true);
  });
});
