export type LiveBoardConnectionState = {
  connected: boolean;
  active: boolean;
  transcriptSessionID: string | null;
  transcriptRevision: number | null;
  tracks: readonly string[];
  pendingChunks: number;
};

export function shouldRenderLiveBoardStatus(
  current: LiveBoardConnectionState,
  next: LiveBoardConnectionState,
): boolean {
  return current.connected !== next.connected
    || current.active !== next.active
    || current.transcriptSessionID !== next.transcriptSessionID
    || current.transcriptRevision !== next.transcriptRevision
    || current.pendingChunks !== next.pendingChunks
    || current.tracks.join(',') !== next.tracks.join(',');
}
